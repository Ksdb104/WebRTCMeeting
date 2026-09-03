import { getCurrentInstance, onUnmounted, reactive, toRaw, watch, type ShallowRef } from 'vue'
import type { Socket } from 'socket.io-client'
import { getSharedAudioContext } from '@/utils/globalAudio'
import type { User } from '@/composables/useWebRTC'
import captureWorkletUrl from '@/worklets/interpretationCapture.worklet.ts?worker&url'

export interface InterpretationSession {
  targetUserId: string
  targetLanguage: string
  ws: WebSocket | null
  isConnected: boolean
  isConnecting: boolean
  sessionError: string
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  // 音频采集（发送到 Gemini）
  sourceNode: MediaStreamAudioSourceNode | null
  processorNode: AudioWorkletNode | null
  silentGainNode: GainNode | null
  captureState: 'idle' | 'loading' | 'running' | 'error'
  captureError: string
  // 翻译音频输出（通过 WebRTC 发送给对方）
  outputAudioContext: AudioContext | null
  outputGainNode: GainNode | null
  outputStream: MediaStream | null
  outputBuffer: Float32Array[] // 待播放的音频片段队列
  inputAudioTrack: MediaStreamTrack | null
  // Gemini setup 响应的超时定时器
  setupTimer: ReturnType<typeof setTimeout> | null
  // 因信令离线而挂起，等信令恢复后继续重连（挂起期间不消耗重连配额）
  awaitingSignaling: boolean
  // 转录文本
  inputTranscript: string
  outputTranscript: string
}

/** 同传被降级关闭的原因，用于给用户可读的提示 */
export type InterpretationDegradeReason =
  | 'peer-reloaded' // 对端刷新了页面，其翻译会话随 JS 上下文消失
  | 'peer-left' // 对端已离开房间
  | 'peer-stopped' // 重连对账后发现对端已不再为我做同传
  | 'audio-timeout' // 等不到对端译音轨，放弃静音其原声
  | 'gemini-failed' // Gemini 连接重试耗尽

export interface InterpretationDegradeNotice {
  id: string
  peerId: string
  peerName: string
  reason: InterpretationDegradeReason
}

export interface InterpretationState {
  activeSessions: Map<string, InterpretationSession>
  receivingFrom: Set<string>
  receivedTranscripts: Map<string, { inputText: string; outputText: string }>
  errorMessage: string
  degradeNotices: InterpretationDegradeNotice[]
}

export interface PeerAudioTrackController {
  reservePeerAudioTrackOverride: (targetId: string) => void
  setPeerAudioTrackOverride: (
    targetId: string,
    track: MediaStreamTrack,
    options?: { maxBitrate?: number },
  ) => Promise<RTCRtpSender | null>
  clearPeerAudioTrackOverride: (targetId: string) => Promise<void>
}

/**
 * 连接生命周期订阅（由 useWebRTC 提供）。
 * 同传靠这些回调实现降级与重连，而不是自己再监听一遍 socket 事件重复推导。
 */
export interface ConnectionLifecycle {
  onPeerSessionChanged: (listener: (peerId: string) => void) => () => void
  onPeerRemoved: (listener: (peerId: string) => void) => () => void
  onSignalingLost: (listener: () => void) => () => void
  onSignalingRestored: (listener: (payload: { isReconnect: boolean }) => void) => () => void
}

export type InterpretationDeps = PeerAudioTrackController & ConnectionLifecycle

/** 远端音频被静音的原因。每个功能只增删自己那一份，谁都不许直接写 track.enabled */
type RemoteAudioMuteReason = 'interpretation-pending'

const WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'
const TRANSLATION_OUTPUT_GAIN = 1.0 //确定不是音量的问题,但去掉太麻烦了,先留着这个控制项
const TRANSLATION_SAMPLE_RATE = 24000
const TRANSLATION_AUDIO_BITRATE = 24000
const TRANSLATION_BUFFER_MAX_WAIT_SECONDS = 0.1
const CAPTURE_WORKLET_NAME = 'interpretation-pcm-capture'
// 原来是 [500, 1000, 2000]，总窗口只有 3.5 秒，比一次信令重连还短，
// 信令抖一下就会把同传会话判死。这里拓宽，且信令离线时不再消耗配额
const GEMINI_RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000]
// setup 响应超时：WS 连上但 setupComplete 迟迟不来时也要当失败处理
const GEMINI_SETUP_TIMEOUT_MS = 10000
// 取临时令牌的超时。原实现是个没有超时的 ack Promise，
// 信令掉线时会永久挂起，会话卡在 isConnecting 再没人唤醒
const TOKEN_REQUEST_TIMEOUT_MS = 10000
// 等待对端「译音轨已就绪」的上限。超时就放弃静音其原声：
// 「听到未翻译的原声」是可接受的降级，「完全听不到人」不是
const AUDIO_READY_TIMEOUT_MS = 8000
// 离线期间积压的控制消息上限
const PENDING_CONTROL_EMIT_LIMIT = 32
// 降级提示的展示时长
const DEGRADE_NOTICE_TTL_MS = 8000
const CAPTION_MAX_LENGTH = 40
const CAPTION_HIDE_DELAY_MS = 5000
const captureWorkletModuleLoads = new WeakMap<BaseAudioContext, Promise<void>>()

/** 信令离线导致的失败，需要与真正的 Gemini 故障区分：前者应挂起等待，而不是消耗重连配额 */
class SignalingOfflineError extends Error {
  constructor() {
    super('网络已断开，同传将在连接恢复后继续')
    this.name = 'SignalingOfflineError'
  }
}

const createNoticeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const createGeminiSetupMessage = (targetLanguage: string) => ({
  setup: {
    model: 'models/gemini-3.5-live-translate-preview',
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        prefixPaddingMs: 250,
        silenceDurationMs: 800,
      },
      activityHandling: 'NO_INTERRUPTION',
    },
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: {
        targetLanguageCode: targetLanguage,
        echoTargetLanguage: false,
      },
    },
  },
})

const ensureCaptureWorkletModule = (audioContext: AudioContext) => {
  if (!audioContext.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    throw new Error('当前页面无法使用 AudioWorklet，请通过 HTTPS 或 localhost 打开会议页面')
  }

  let moduleLoad = captureWorkletModuleLoads.get(audioContext)
  if (!moduleLoad) {
    moduleLoad = audioContext.audioWorklet.addModule(captureWorkletUrl)
    captureWorkletModuleLoads.set(audioContext, moduleLoad)
  }
  return moduleLoad
}

export function useInterpretation(
  socket: ShallowRef<Socket | null>,
  localStream: ShallowRef<MediaStream | null>,
  users: Map<string, User>,
  deps: InterpretationDeps,
) {
  const audioTrackController: PeerAudioTrackController = deps

  const state = reactive<InterpretationState>({
    activeSessions: new Map(),
    receivingFrom: new Set(),
    receivedTranscripts: new Map(),
    errorMessage: '',
    degradeNotices: [],
  })

  const mutedByInterpretation = reactive<Set<string>>(new Set())
  const myVoiceMutedFor = reactive<Set<string>>(new Set())
  const audioReadyFrom = new Set<string>()
  const outputPlaybackTimes = new WeakMap<InterpretationSession, number>()
  const outgoingCaptionTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const receivedCaptionTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  // userId -> 静音原因集合
  const remoteAudioMuteReasons = new Map<string, Set<RemoteAudioMuteReason>>()
  // userId -> 等待对端译音轨就绪的看门狗
  const audioReadyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 信令是否处于离线状态（离线期间 audio-ready 不可能到达，看门狗要顺延而不是误判）
  const signalingOffline = { value: false }

  // ====== 降级提示 ======
  const pushDegradeNotice = (
    peerId: string,
    peerName: string,
    reason: InterpretationDegradeReason,
  ) => {
    const notice: InterpretationDegradeNotice = {
      id: createNoticeId(),
      peerId,
      peerName,
      reason,
    }
    state.degradeNotices.push(notice)
    if (state.degradeNotices.length > 3) state.degradeNotices.shift()
    setTimeout(() => {
      const index = state.degradeNotices.findIndex((item) => item.id === notice.id)
      if (index >= 0) state.degradeNotices.splice(index, 1)
    }, DEGRADE_NOTICE_TTL_MS)
  }

  // ====== 控制消息发送 ======
  // socket.io 的自带缓冲在这里不可用：重连时它会在我们的 connect 回调（里面才发 join-room）
  // 之前就 flush 掉线期间积压的包，那些包到达服务端时还不知道我们是谁，会被静默丢弃。
  // 所以控制类消息自己排队，由 onSignalingRestored 在 join-room 之后 flush。
  const pendingControlEmits: Array<{ key: string; event: string; payload: unknown }> = []

  const emitControl = (event: string, payload: { targetId: string } & Record<string, unknown>) => {
    const activeSocket = socket.value
    if (activeSocket?.connected) {
      activeSocket.emit(event, payload)
      return
    }
    const key = `${event}:${payload.targetId}`
    const existing = pendingControlEmits.findIndex((item) => item.key === key)
    if (existing >= 0) pendingControlEmits.splice(existing, 1)
    pendingControlEmits.push({ key, event, payload })
    while (pendingControlEmits.length > PENDING_CONTROL_EMIT_LIMIT) pendingControlEmits.shift()
  }

  const flushControlEmits = () => {
    const activeSocket = socket.value
    if (!activeSocket?.connected) return
    const queued = pendingControlEmits.splice(0, pendingControlEmits.length)
    for (const item of queued) activeSocket.emit(item.event, item.payload)
  }

  // 字幕是瞬时信息：掉线就丢弃，不要缓冲到重连后一次性涌出
  const emitTranscript = (payload: { targetId: string; inputText: string; outputText: string }) => {
    socket.value?.volatile.emit('interpretation-transcript', payload)
  }

  const clearCaptionTimeout = (
    timeouts: Map<string, ReturnType<typeof setTimeout>>,
    userId: string,
  ) => {
    const timeout = timeouts.get(userId)
    if (timeout) clearTimeout(timeout)
    timeouts.delete(userId)
  }

  const scheduleOutgoingCaptionExpiry = (session: InterpretationSession) => {
    clearCaptionTimeout(outgoingCaptionTimeouts, session.targetUserId)
    outgoingCaptionTimeouts.set(
      session.targetUserId,
      setTimeout(() => {
        const activeSession = state.activeSessions.get(session.targetUserId)
        if (!activeSession || toRaw(activeSession) !== toRaw(session)) return
        activeSession.outputTranscript = ''
        outgoingCaptionTimeouts.delete(session.targetUserId)
        emitTranscript({ targetId: session.targetUserId, inputText: '', outputText: '' })
      }, CAPTION_HIDE_DELAY_MS),
    )
  }

  const scheduleReceivedCaptionExpiry = (userId: string) => {
    clearCaptionTimeout(receivedCaptionTimeouts, userId)
    receivedCaptionTimeouts.set(
      userId,
      setTimeout(() => {
        state.receivedTranscripts.delete(userId)
        receivedCaptionTimeouts.delete(userId)
      }, CAPTION_HIDE_DELAY_MS),
    )
  }

  const clearInterpretationStateForUser = (userId: string) => {
    clearCaptionTimeout(outgoingCaptionTimeouts, userId)
    clearCaptionTimeout(receivedCaptionTimeouts, userId)
    state.receivingFrom.delete(userId)
    state.receivedTranscripts.delete(userId)
    mutedByInterpretation.delete(userId)
    myVoiceMutedFor.delete(userId)
    audioReadyFrom.delete(userId)
    unmuteRemoteUserAudio(userId)
  }

  // ====== 远端音频静音控制 ======
  // track.enabled 是每条轨道一个布尔值、没有归属也没有引用计数的共享开关，
  // 谁最后写谁生效。所以这里改成「按原因记账、统一求值」：
  // 任何功能只增删自己那一份 reason，没人再直接写 track.enabled，
  // 这样同传结束时也不会顺手把别的功能加的静音一起解掉。
  const applyRemoteAudioState = (userId: string) => {
    const user = users.get(userId)
    if (!user?.stream) return
    const enabled = (remoteAudioMuteReasons.get(userId)?.size ?? 0) === 0
    user.stream.getAudioTracks().forEach((track) => {
      track.enabled = enabled
    })
  }

  const addRemoteAudioMute = (userId: string, reason: RemoteAudioMuteReason) => {
    let reasons = remoteAudioMuteReasons.get(userId)
    if (!reasons) {
      reasons = new Set()
      remoteAudioMuteReasons.set(userId, reasons)
    }
    reasons.add(reason)
    applyRemoteAudioState(userId)
  }

  const removeRemoteAudioMute = (userId: string, reason: RemoteAudioMuteReason) => {
    const reasons = remoteAudioMuteReasons.get(userId)
    if (!reasons?.delete(reason)) return
    applyRemoteAudioState(userId)
    if (reasons.size === 0) remoteAudioMuteReasons.delete(userId)
  }

  const clearAudioReadyWatchdog = (userId: string) => {
    const timer = audioReadyTimers.get(userId)
    if (timer) clearTimeout(timer)
    audioReadyTimers.delete(userId)
  }

  /**
   * 只要为同传静音了某人，就必须有个兜底：
   * 如果对端的译音轨迟迟不就绪（它崩了 / 刷新了 / Gemini 没起来），
   * 到时就放弃静音，否则这个人会永久失声，而且录制里也是全程无声。
   */
  const armAudioReadyWatchdog = (userId: string) => {
    clearAudioReadyWatchdog(userId)
    audioReadyTimers.set(
      userId,
      setTimeout(() => {
        audioReadyTimers.delete(userId)
        if (audioReadyFrom.has(userId)) return
        if (!mutedByInterpretation.has(userId)) return
        // 信令离线期间 audio-ready 根本没机会到达，顺延而不是误判
        if (signalingOffline.value) {
          armAudioReadyWatchdog(userId)
          return
        }
        console.warn(`[Interpretation] 等不到 ${userId} 的译音轨，放弃静音其原声`)
        mutedByInterpretation.delete(userId)
        removeRemoteAudioMute(userId, 'interpretation-pending')
        pushDegradeNotice(userId, users.get(userId)?.name ?? '', 'audio-timeout')
      }, AUDIO_READY_TIMEOUT_MS),
    )
  }

  const muteRemoteUserAudio = (userId: string) => {
    if (audioReadyFrom.has(userId)) return
    addRemoteAudioMute(userId, 'interpretation-pending')
    if (!audioReadyTimers.has(userId)) armAudioReadyWatchdog(userId)
  }

  const unmuteRemoteUserAudio = (userId: string) => {
    clearAudioReadyWatchdog(userId)
    removeRemoteAudioMute(userId, 'interpretation-pending')
  }

  // ====== 临时令牌 ======
  const getEphemeralToken = async (targetLanguage: string): Promise<string> => {
    const activeSocket = socket.value
    // 必须检查 connected：否则这个带 ack 的 emit 会被 socket.io 缓冲，
    // ack 永远不回，整个会话卡在 isConnecting 且再没有人唤醒它
    if (!activeSocket?.connected) throw new SignalingOfflineError()

    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('请求 Gemini 令牌超时'))
      }, TOKEN_REQUEST_TIMEOUT_MS)

      activeSocket.emit(
        'request-gemini-token',
        { targetLanguage },
        (response: { token?: string; expiresAt?: string; error?: string }) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (response.error) {
            reject(new Error(response.error))
          } else if (response.token) {
            resolve(response.token)
          } else {
            reject(new Error('No token in server response'))
          }
        },
      )
    })
  }

  const isCurrentSession = (session: InterpretationSession) => {
    const activeSession = state.activeSessions.get(session.targetUserId)
    return Boolean(activeSession && toRaw(activeSession) === toRaw(session))
  }

  const scheduleGeminiReconnect = (session: InterpretationSession, reason: string) => {
    if (!isCurrentSession(session) || session.reconnectTimer) return

    // 信令不通就拿不到令牌。挂起等信令恢复，并且不消耗重连配额，
    // 否则一次网络抖动就能把配额烧完、把同传判死。
    if (!socket.value?.connected) {
      session.awaitingSignaling = true
      session.isConnected = false
      session.isConnecting = true
      session.sessionError = '网络已断开，同传将在连接恢复后继续'
      state.errorMessage = session.sessionError
      return
    }

    const delay = GEMINI_RECONNECT_DELAYS_MS[session.reconnectAttempts]
    if (delay === undefined) {
      const peerName = users.get(session.targetUserId)?.name ?? ''
      console.warn(`[Interpretation] Gemini 重连配额耗尽：${reason}`)
      void teardownInterpretation(session.targetUserId, { notifyPeer: true })
      pushDegradeNotice(session.targetUserId, peerName, 'gemini-failed')
      return
    }

    session.reconnectAttempts += 1
    session.isConnected = false
    session.isConnecting = true
    session.sessionError = `Gemini 同传连接中断，正在重连（${session.reconnectAttempts}/${GEMINI_RECONNECT_DELAYS_MS.length}）`
    state.errorMessage = session.sessionError

    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null
      if (!isCurrentSession(session)) return
      void connectGeminiSession(session).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        scheduleGeminiReconnect(session, message)
      })
    }, delay)
  }

  const connectGeminiSession = async (session: InterpretationSession) => {
    const token = await getEphemeralToken(session.targetLanguage)
    if (!isCurrentSession(session)) return

    const wsUrl = `${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`
    const ws = new WebSocket(wsUrl)
    session.ws = ws
    session.isConnecting = true
    session.awaitingSignaling = false

    const clearSetupTimer = () => {
      if (session.setupTimer) clearTimeout(session.setupTimer)
      session.setupTimer = null
    }

    ws.onopen = () => {
      if (session.ws !== ws) return
      ws.send(JSON.stringify(createGeminiSetupMessage(session.targetLanguage)))
      // WS 连上但 setupComplete 迟迟不来时，原实现会永远等下去，
      // 因为重连只挂在 onerror / onclose 上
      clearSetupTimer()
      session.setupTimer = setTimeout(() => {
        session.setupTimer = null
        if (session.ws !== ws) return
        handleDisconnect('Gemini setup 响应超时')
      }, GEMINI_SETUP_TIMEOUT_MS)
    }

    ws.onmessage = (event) => {
      if (session.ws === ws) handleGeminiMessage(session, event)
    }

    const handleDisconnect = (reason: string) => {
      if (session.ws !== ws) return
      clearSetupTimer()
      session.ws = null
      try {
        ws.close()
      } catch {
        // The socket can already be closed by the remote endpoint.
      }
      scheduleGeminiReconnect(session, reason)
    }

    ws.onerror = () => {
      console.error('[Interpretation] Gemini WS error')
      handleDisconnect('WebSocket 网络错误')
    }

    ws.onclose = (event) => {
      console.log(
        `[Interpretation] Gemini WS closed: ${session.targetUserId}, code: ${event.code}, reason: ${event.reason}`,
      )
      handleDisconnect(`${event.code}${event.reason ? `: ${event.reason}` : ''}`)
    }
  }

  // ====== 创建翻译音频输出流 ======
  const drainTranslationAudio = (session: InterpretationSession) => {
    const rawSession = toRaw(session)
    const ctx = session.outputAudioContext
    const outputGain = session.outputGainNode
    if (!ctx || ctx.state === 'closed' || !outputGain) return

    let nextTime = outputPlaybackTimes.get(rawSession) ?? 0
    if (nextTime <= ctx.currentTime) {
      nextTime = ctx.currentTime + TRANSLATION_BUFFER_MAX_WAIT_SECONDS
    }

    while (session.outputBuffer.length > 0) {
      const chunk = session.outputBuffer.shift()!
      const buffer = ctx.createBuffer(1, chunk.length, TRANSLATION_SAMPLE_RATE)
      buffer.getChannelData(0).set(chunk)

      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(outputGain)
      source.start(nextTime)
      nextTime += buffer.duration
    }

    outputPlaybackTimes.set(rawSession, nextTime)
  }

  // 创建一个持续输出的 MediaStream，翻译音频到达时直接交给 Web Audio 时钟调度。
  const createOutputAudioStream = (session: InterpretationSession) => {
    // 复用麦克风采集使用的上下文。WebSocket 回调中新建 AudioContext 可能被自动播放策略挂起。
    const ctx = getSharedAudioContext()
    session.outputAudioContext = ctx

    const dest = ctx.createMediaStreamDestination()
    session.outputStream = dest.stream

    const outputGain = ctx.createGain()
    outputGain.gain.value = TRANSLATION_OUTPUT_GAIN
    outputGain.connect(dest)
    session.outputGainNode = outputGain

    outputPlaybackTimes.set(toRaw(session), 0)
    drainTranslationAudio(session)

    return dest.stream
  }

  // ====== 替换 WebRTC 音频轨道 ======
  // 将 PeerConnection 中发给目标用户的音频轨道替换为翻译输出流。
  // 码率上限交给 useWebRTC 记在 override 上，这样 PeerConnection 重建后能自动重新施加
  const replaceAudioTrackForPeer = async (targetUserId: string, newTrack: MediaStreamTrack) => {
    try {
      newTrack.contentHint = 'speech'
      const audioSender = await audioTrackController.setPeerAudioTrackOverride(
        targetUserId,
        newTrack,
        { maxBitrate: TRANSLATION_AUDIO_BITRATE },
      )
      if (!audioSender) {
        console.warn('[Interpretation] No peer connection for', targetUserId)
        return false
      }
      console.log('[Interpretation] Replaced audio track for peer:', targetUserId)
      return true
    } catch (error) {
      console.error('[Interpretation] Failed to replace audio track:', error)
      return false
    }
  }

  const createSession = (targetUserId: string, targetLanguage: string): InterpretationSession => ({
    targetUserId,
    targetLanguage,
    ws: null,
    isConnected: false,
    isConnecting: true,
    sessionError: '',
    reconnectAttempts: 0,
    reconnectTimer: null,
    sourceNode: null,
    processorNode: null,
    silentGainNode: null,
    captureState: 'idle',
    captureError: '',
    outputAudioContext: null,
    outputGainNode: null,
    outputStream: null,
    outputBuffer: [],
    inputAudioTrack: null,
    setupTimer: null,
    awaitingSignaling: false,
    inputTranscript: '',
    outputTranscript: '',
  })

  // ====== 启动同传 ======
  const startInterpretation = async (
    targetUserId: string,
    peerLanguage: string,
    myLanguage: string,
  ) => {
    if (state.activeSessions.has(targetUserId)) return

    state.errorMessage = ''
    audioTrackController.reservePeerAudioTrackOverride(targetUserId)
    audioReadyFrom.delete(targetUserId)

    const session = createSession(targetUserId, peerLanguage)

    state.activeSessions.set(targetUserId, session)

    try {
      await connectGeminiSession(session)

      // 通知对方启动同传。走 outbox：万一取到令牌后信令才掉线，
      // 这条请求不能丢，否则对端永远不会建立接收侧状态
      emitControl('interpretation-request', {
        targetId: targetUserId,
        targetLanguage: myLanguage,
      })

      // 双向静音原声
      myVoiceMutedFor.add(targetUserId)
      mutedByInterpretation.add(targetUserId)
      muteRemoteUserAudio(targetUserId)
    } catch (e) {
      console.error('[Interpretation] Failed to start:', e)
      state.errorMessage = e instanceof Error ? e.message : String(e)
      state.activeSessions.delete(targetUserId)
      await audioTrackController.clearPeerAudioTrackOverride(targetUserId)
      throw e
    }
  }

  // ====== 处理 Gemini 消息 ======
  const handleGeminiMessage = (session: InterpretationSession, event: MessageEvent) => {
    if (event.data instanceof Blob) {
      event.data.text().then((text) => parseGeminiResponse(session, text))
    } else {
      parseGeminiResponse(session, event.data)
    }
  }

  const parseGeminiResponse = (session: InterpretationSession, data: string) => {
    try {
      const msg = JSON.parse(data)

      if (msg.setupComplete) {
        console.log('[Interpretation] Gemini setup complete')
        if (session.setupTimer) {
          clearTimeout(session.setupTimer)
          session.setupTimer = null
        }
        session.isConnected = true
        session.isConnecting = false
        session.awaitingSignaling = false
        session.reconnectAttempts = 0
        session.sessionError = ''
        state.errorMessage = ''

        // 首次连接时创建输出轨；重连只复用现有轨道，避免泄漏 Web Audio 节点。
        if (!session.outputStream) {
          const outputStream = createOutputAudioStream(session)
          const outputTrack = outputStream.getAudioTracks()[0]
          if (outputTrack) {
            void replaceAudioTrackForPeer(session.targetUserId, outputTrack).then((replaced) => {
              if (replaced) {
                emitControl('interpretation-audio-ready', { targetId: session.targetUserId })
              }
            })
          }
        }

        // 开始采集麦克风发给 Gemini
        void startAudioCapture(session)
        return
      }

      const sc = msg.serverContent || msg.server_content
      if (sc) {
        // 转录
        const inputT = sc.inputTranscription || sc.input_transcription
        if (inputT?.text) {
          session.inputTranscript = appendTranscript(session.inputTranscript, inputT.text)
          console.log(`[Interpretation] Input: ${inputT.text}`)
        }

        const outputT = sc.outputTranscription || sc.output_transcription
        if (outputT?.text) {
          session.outputTranscript = appendCaption(session.outputTranscript, outputT.text)
          emitTranscript({
            targetId: session.targetUserId,
            inputText: session.inputTranscript,
            outputText: session.outputTranscript,
          })
          scheduleOutgoingCaptionExpiry(session)
          console.log(`[Interpretation] Output: ${outputT.text}`)
        }

        // 翻译后的音频 → 写入输出 buffer，通过 WebRTC 发送
        const turn = sc.modelTurn || sc.model_turn
        if (turn?.parts) {
          for (const part of turn.parts) {
            const inlineData = part.inlineData || part.inline_data
            if (inlineData?.data) {
              const audioStr = inlineData.data as string
              if (audioStr.length < 10 || /^A+={0,2}$/.test(audioStr)) continue

              // 解码 base64 PCM 16-bit → Float32 并推入输出队列
              const pcm = base64ToInt16Array(audioStr)
              const float32 = int16ToFloat32(pcm)
              session.outputBuffer.push(float32)
              drainTranslationAudio(session)
            }
          }
        }
      }
    } catch (e) {
      console.error('[Interpretation] Parse error:', e)
    }
  }

  // ====== 麦克风采集 → Gemini ======
  const sendRealtimeAudio = (
    session: InterpretationSession,
    inputData: Float32Array,
    sourceSampleRate: number,
  ) => {
    const resampledData = resample(inputData, sourceSampleRate, 16000)
    const pcmData = float32ToInt16(resampledData)
    const base64Audio = arrayBufferToBase64(pcmData.buffer)

    session.ws!.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64Audio }],
        },
      }),
    )
  }

  const disconnectAudioCapture = (session: InterpretationSession, signalAudioStreamEnd = true) => {
    if (
      signalAudioStreamEnd &&
      session.inputAudioTrack &&
      session.ws?.readyState === WebSocket.OPEN &&
      session.isConnected
    ) {
      session.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
    }
    if (session.processorNode) {
      session.processorNode.port.onmessage = null
      session.processorNode.port.close()
    }
    session.processorNode?.disconnect()
    session.sourceNode?.disconnect()
    session.silentGainNode?.disconnect()
    session.processorNode = null
    session.sourceNode = null
    session.silentGainNode = null
    session.inputAudioTrack = null
    if (session.captureState !== 'error') session.captureState = 'idle'
  }

  const startAudioCapture = async (session: InterpretationSession) => {
    const audioTrack = localStream.value?.getAudioTracks()[0]
    if (!audioTrack || audioTrack.readyState !== 'live') {
      disconnectAudioCapture(session)
      return
    }
    if (toRaw(session.inputAudioTrack) === audioTrack) return

    disconnectAudioCapture(session)
    session.inputAudioTrack = audioTrack
    session.captureState = 'loading'
    session.captureError = ''

    console.log(`[Interpretation] Starting audio capture, track state: ${audioTrack.readyState}`)

    const audioContext = getSharedAudioContext()
    if (audioContext.state === 'suspended') void audioContext.resume()

    try {
      await ensureCaptureWorkletModule(audioContext)
    } catch (error) {
      if (toRaw(session.inputAudioTrack) === audioTrack) {
        session.captureState = 'error'
        session.captureError = error instanceof Error ? error.message : String(error)
        disconnectAudioCapture(session, false)
      }
      console.error('[Interpretation] Failed to load audio capture worklet:', error)
      return
    }

    if (
      toRaw(session.inputAudioTrack) !== audioTrack ||
      audioTrack.readyState !== 'live' ||
      localStream.value?.getAudioTracks()[0] !== audioTrack
    ) {
      return
    }

    const audioOnlyStream = new MediaStream([audioTrack])
    const sourceNode = audioContext.createMediaStreamSource(audioOnlyStream)
    session.sourceNode = sourceNode

    const processorNode = new AudioWorkletNode(audioContext, CAPTURE_WORKLET_NAME, {
      channelCount: 1,
      channelCountMode: 'explicit',
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    session.processorNode = processorNode
    processorNode.onprocessorerror = () => {
      session.captureState = 'error'
      session.captureError = 'AudioWorklet 音频处理线程异常，请关闭同传后重试'
      console.error('[Interpretation] Audio capture worklet processor error')
    }

    const sourceSampleRate = audioContext.sampleRate

    processorNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN || !session.isConnected) return

      const inputData = event.data
      if (!(inputData instanceof Float32Array) || inputData.length === 0) return

      sendRealtimeAudio(session, inputData, sourceSampleRate)
    }

    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    session.silentGainNode = silentGain

    sourceNode.connect(processorNode)
    processorNode.connect(silentGain)
    silentGain.connect(audioContext.destination)
    session.captureState = 'running'
  }

  // ====== 停止同传 ======
  /** 释放单个会话持有的全部资源（Gemini WS、采集图、输出节点、定时器） */
  const disposeSession = (session: InterpretationSession) => {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
    session.reconnectTimer = null
    if (session.setupTimer) clearTimeout(session.setupTimer)
    session.setupTimer = null
    session.awaitingSignaling = false

    disconnectAudioCapture(session, false)

    if (session.outputGainNode) {
      try {
        session.outputGainNode.disconnect()
      } catch (e) {
        console.warn('[Interpretation] 断开译音输出节点失败:', e)
      }
    }
    session.outputGainNode = null
    session.outputStream?.getTracks().forEach((track) => track.stop())
    session.outputStream = null
    session.outputAudioContext = null
    session.outputBuffer = []
    session.inputTranscript = ''
    session.outputTranscript = ''
    outputPlaybackTimes.delete(toRaw(session))

    // 先摘掉引用再 close，否则 onclose 会触发一轮无意义的重连
    const ws = session.ws
    session.ws = null
    session.isConnected = false
    session.isConnecting = false
    if (ws) {
      try {
        ws.close()
      } catch (e) {
        console.warn('[Interpretation] 关闭 Gemini WS 失败:', e)
      }
    }
  }

  /**
   * 拆除与某个对端的同传，双向状态一起清干净。
   *
   * 注意同步性：本函数在第一个 await 之前就会同步执行到
   * clearPeerAudioTrackOverride，而后者会同步删除 override 表项。
   * useWebRTC 在 onPeerSessionChanged 回调返回后立刻重建 PeerConnection，
   * 依赖这一点才不会把已失效的译音轨重新挂上去。
   */
  const teardownInterpretation = async (
    peerId: string,
    options: { notifyPeer: boolean } = { notifyPeer: true },
  ) => {
    const session = state.activeSessions.get(peerId)
    state.activeSessions.delete(peerId)
    clearInterpretationStateForUser(peerId)
    if (session) disposeSession(session)
    state.errorMessage = ''

    if (options.notifyPeer) emitControl('interpretation-stop', { targetId: peerId })

    // 只有确实存在出方向会话时才需要还原音轨。
    // 纯接收方（只是被对端翻译）从未占用过 override，不该在这里制造多余的轨道变更。
    if (session) await audioTrackController.clearPeerAudioTrackOverride(peerId)
  }

  const stopInterpretation = (targetUserId: string) =>
    teardownInterpretation(targetUserId, { notifyPeer: true })

  /** 本地是否还残留与该对端相关的同传状态 */
  const hasInterpretationState = (peerId: string) =>
    state.activeSessions.has(peerId) ||
    state.receivingFrom.has(peerId) ||
    mutedByInterpretation.has(peerId) ||
    myVoiceMutedFor.has(peerId) ||
    audioReadyFrom.has(peerId)

  /** 因外部原因降级关闭：对端已经不在原来的上下文里了，通知它没有意义 */
  const degradeInterpretation = (peerId: string, reason: InterpretationDegradeReason) => {
    if (!hasInterpretationState(peerId)) return
    const peerName = users.get(peerId)?.name ?? ''
    console.warn(`[Interpretation] 降级关闭与 ${peerId} 的同传，原因：${reason}`)
    void teardownInterpretation(peerId, { notifyPeer: false })
    pushDegradeNotice(peerId, peerName, reason)
  }

  // ====== Socket 事件监听 ======
  const setupSocketListeners = () => {
    const s = socket.value
    if (!s) return

    s.on(
      'interpretation-request',
      async ({ requesterId, targetLanguage }: { requesterId: string; targetLanguage: string }) => {
        console.log(`[Interpretation] Request from ${requesterId}, lang: ${targetLanguage}`)

        state.receivingFrom.add(requesterId)
        mutedByInterpretation.add(requesterId)
        audioReadyFrom.delete(requesterId)
        muteRemoteUserAudio(requesterId)
        s.emit('interpretation-accept', { requesterId })

        // 自动启动我的翻译会话
        if (!state.activeSessions.has(requesterId)) {
          try {
            const session = createSession(requesterId, targetLanguage)
            state.activeSessions.set(requesterId, session)
            audioTrackController.reservePeerAudioTrackOverride(requesterId)

            await connectGeminiSession(session)

            myVoiceMutedFor.add(requesterId)
          } catch (e) {
            console.error('[Interpretation] Auto-start failed:', e)
            state.errorMessage = e instanceof Error ? e.message : String(e)
            state.activeSessions.delete(requesterId)
            // 原实现只删了 session 和 override，没回滚静音状态，
            // 于是反向会话一失败，对端就在本地被永久静音且无法自行恢复
            clearInterpretationStateForUser(requesterId)
            await audioTrackController.clearPeerAudioTrackOverride(requesterId)
          }
        }
      },
    )

    s.on('interpretation-accept', ({ accepterId }: { accepterId: string }) => {
      console.log(`[Interpretation] ${accepterId} accepted`)
    })

    s.on('interpretation-audio-ready', ({ senderId }: { senderId: string }) => {
      audioReadyFrom.add(senderId)
      // 对端的轨道此刻承载的已经是译音，正是要听的内容
      unmuteRemoteUserAudio(senderId)
      console.log(`[Interpretation] Translation audio ready from ${senderId}`)
    })

    /**
     * 重连后的状态对账。
     * 掉线期间服务端会把发给我们的事件直接丢弃（找不到 socketId），
     * 所以对端的 interpretation-stop 可能永远收不到。重连后双方各自广播
     * 「我当前是否还在给你做同传」，对不上的一侧就地降级，避免僵尸状态。
     */
    s.on('interpretation-sync', ({ senderId, active }: { senderId: string; active: boolean }) => {
      if (active) {
        // 对端仍在为我翻译：它那条轨道现在就是译音，直接视为已就绪。
        // 这里刻意 fail-open —— 宁可短暂听到原声，也不能把人永久静音
        state.receivingFrom.add(senderId)
        audioReadyFrom.add(senderId)
        clearAudioReadyWatchdog(senderId)
        mutedByInterpretation.delete(senderId)
        removeRemoteAudioMute(senderId, 'interpretation-pending')
        return
      }
      // 对端已经没有指向我的会话，配对断了，降级关闭我这一侧
      degradeInterpretation(senderId, 'peer-stopped')
    })

    s.on(
      'interpretation-transcript',
      ({
        senderId,
        inputText,
        outputText,
      }: {
        senderId: string
        inputText: string
        outputText: string
      }) => {
        if (!outputText) {
          clearCaptionTimeout(receivedCaptionTimeouts, senderId)
          state.receivedTranscripts.delete(senderId)
          return
        }
        state.receivedTranscripts.set(senderId, {
          inputText,
          outputText: outputText.slice(-CAPTION_MAX_LENGTH),
        })
        scheduleReceivedCaptionExpiry(senderId)
      },
    )

    // 对端主动关闭：走同一套拆除逻辑，但不要再发回执，避免回环
    s.on('interpretation-stop', async ({ senderId }: { senderId: string }) => {
      await teardownInterpretation(senderId, { notifyPeer: false })
    })
  }

  /** 重连后向房间内每个成员声明自己的出方向会话状态 */
  const broadcastInterpretationSync = () => {
    for (const peerId of users.keys()) {
      emitControl('interpretation-sync', {
        targetId: peerId,
        active: state.activeSessions.has(peerId),
      })
    }
  }

  const isUserMutedByInterpretation = (userId: string) => mutedByInterpretation.has(userId)
  const isInterpretingFor = (userId: string) => state.activeSessions.has(userId)

  const stopAll = () => {
    for (const userId of [...state.activeSessions.keys()]) {
      void stopInterpretation(userId)
    }
    for (const userId of [...remoteAudioMuteReasons.keys()]) {
      removeRemoteAudioMute(userId, 'interpretation-pending')
    }
    for (const timeout of audioReadyTimers.values()) clearTimeout(timeout)
    audioReadyTimers.clear()
    remoteAudioMuteReasons.clear()
    state.receivingFrom.clear()
    state.receivedTranscripts.clear()
    state.degradeNotices.splice(0, state.degradeNotices.length)
    for (const timeout of outgoingCaptionTimeouts.values()) clearTimeout(timeout)
    for (const timeout of receivedCaptionTimeouts.values()) clearTimeout(timeout)
    outgoingCaptionTimeouts.clear()
    receivedCaptionTimeouts.clear()
    pendingControlEmits.splice(0, pendingControlEmits.length)
    mutedByInterpretation.clear()
    myVoiceMutedFor.clear()
    audioReadyFrom.clear()
  }

  // ====== 路线 C：按「对端的 JS 上下文是否还活着」分流 ======
  const lifecycleUnsubscribers = [
    // 对端刷新了页面：它的 Gemini 会话、采集图、译音轨都随旧上下文消失，
    // 无法「恢复」只能重建，代价与用户手点一次相当 —— 所以降级关闭并提示
    deps.onPeerSessionChanged((peerId) => {
      degradeInterpretation(peerId, 'peer-reloaded')
    }),

    // 对端已离开房间：必须停掉本地会话，否则 Gemini 会一直连着、一直计费
    deps.onPeerRemoved((peerId) => {
      degradeInterpretation(peerId, 'peer-left')
    }),

    // 我自己信令抖动：页面还活着，Gemini 通常也活着，什么都不拆，
    // 只是让 audio-ready 看门狗顺延（离线期间它根本没机会到达）
    deps.onSignalingLost(() => {
      signalingOffline.value = true
    }),

    deps.onSignalingRestored(({ isReconnect }) => {
      signalingOffline.value = false
      // 必须在 join-room 之后才 flush，否则服务端还不知道我们是谁
      flushControlEmits()
      if (!isReconnect) return

      // 恢复因信令离线而挂起的 Gemini 重连
      for (const session of state.activeSessions.values()) {
        if (!session.awaitingSignaling) continue
        session.awaitingSignaling = false
        session.reconnectAttempts = 0
        const targetUserId = session.targetUserId
        void connectGeminiSession(session).catch((error) => {
          scheduleGeminiReconnect(session, error instanceof Error ? error.message : String(error))
          console.warn(`[Interpretation] ${targetUserId} 的同传重连失败:`, error)
        })
      }

      broadcastInterpretationSync()
    }),
  ]

  // 单元测试会在组件外直接调用本 composable，此时没有实例可挂载钩子
  if (getCurrentInstance()) {
    onUnmounted(() => {
      lifecycleUnsubscribers.forEach((unsubscribe) => unsubscribe())
    })
  }

  // ====== 工具函数 ======
  function appendTranscript(current: string, next: string): string {
    if (!current || next.startsWith(current)) return next
    return `${current}${next}`.slice(-1000)
  }

  function appendCaption(current: string, next: string): string {
    const combined = !current || next.startsWith(current) ? next : `${current}${next}`
    return combined.slice(-CAPTION_MAX_LENGTH)
  }

  function resample(inputData: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return inputData
    const ratio = fromRate / toRate
    const outputLength = Math.round(inputData.length / ratio)
    const output = new Float32Array(outputLength)
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio
      const floor = Math.floor(srcIndex)
      const ceil = Math.min(floor + 1, inputData.length - 1)
      const frac = srcIndex - floor
      output[i] = inputData[floor]! * (1 - frac) + inputData[ceil]! * frac
    }
    return output
  }

  function float32ToInt16(float32: Float32Array): Int16Array {
    const int16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]!))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return int16
  }

  function int16ToFloat32(int16: Int16Array): Float32Array {
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i]! / 0x8000
    }
    return float32
  }

  function arrayBufferToBase64(buffer: ArrayBufferLike): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }

  function base64ToInt16Array(base64: string): Int16Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new Int16Array(bytes.buffer)
  }

  // ====== 监听 localStream 变化 ======
  // 麦克风轨道会在开关设备时重建，同传采集必须跟随当前轨道。
  watch(localStream, () => {
    if (state.activeSessions.size === 0) return

    for (const session of state.activeSessions.values()) {
      if (!session.isConnected) continue
      void startAudioCapture(session)
    }

    // 同时确保接收方静音：对方新添加的音频轨道也要禁用
    for (const userId of mutedByInterpretation) {
      muteRemoteUserAudio(userId)
    }
  })

  /**
   * 远端流变化后重新求值静音状态（对端 renegotiate 出的新轨道默认是 enabled=true）。
   * 只处理我们确实表达过意见的用户，不去碰其它人的轨道。
   */
  const reapplyMutes = () => {
    for (const userId of mutedByInterpretation) {
      muteRemoteUserAudio(userId)
    }
    for (const userId of remoteAudioMuteReasons.keys()) {
      applyRemoteAudioState(userId)
    }
  }

  const dismissDegradeNotice = (id: string) => {
    const index = state.degradeNotices.findIndex((item) => item.id === id)
    if (index >= 0) state.degradeNotices.splice(index, 1)
  }

  return {
    state,
    mutedByInterpretation,
    myVoiceMutedFor,
    startInterpretation,
    stopInterpretation,
    isUserMutedByInterpretation,
    isInterpretingFor,
    setupSocketListeners,
    reapplyMutes,
    dismissDegradeNotice,
    stopAll,
  }
}
