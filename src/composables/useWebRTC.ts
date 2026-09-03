import { ref, reactive, shallowRef, onUnmounted } from 'vue'
import { io, Socket } from 'socket.io-client'
import { getSharedAudioContext } from '@/utils/globalAudio'
import { useDeviceStore } from '@/stores/device'
import 'webrtc-adapter'

export interface User {
  id: string
  name: string
  joinTime: number
  micOpen: boolean
  camOpen: boolean
  isScreenSharing: boolean
  connected: boolean // WebRTC 连接状态
  reconnecting?: boolean // 信令掉线、处于服务端重连宽限期内
  sessionId?: string // 对端每次页面加载都会变，用于立刻识别失效的 PeerConnection
  isDesktop?: boolean
  stream?: MediaStream // 摄像头流
  screenStream?: MediaStream // 屏幕共享流
  audioLevel?: number
  isSpeaking?: boolean
  camStreamId?: string
  screenStreamId?: string
}

// ====== 断线重连相关常量 ======
// 双方同时判定需要重建时，忽略针对刚建立连接的重置请求，避免来回互相重置
const PEER_RESET_DEBOUNCE_MS = 3000
// ICE 重启的最大尝试次数，超过后彻底重建 PeerConnection
const MAX_ICE_RESTARTS = 2
// connectionState 进入 disconnected 后等待自愈的时间
const DISCONNECTED_RECOVERY_DELAY_MS = 2500
// 一次恢复动作之后再次检查的间隔
const RECOVERY_RETRY_DELAY_MS = 5000
// 新建连接后若迟迟连不上（例如 offer 正好在信令断开时丢失），到时兜底重试。
// 留够 TURN 中继握手的时间，避免在正常建连过程中误触发 ICE 重启
const PEER_CONNECT_TIMEOUT_MS = 10000

const USER_ID_STORAGE_PREFIX = 'webrtc-meeting:user-id:'

const createRandomId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 生成（或复用）与房间绑定的稳定用户 ID。
 *
 * socket.id 每次重连都会变化，用它当用户身份会导致：
 * 服务端把重连的人当成新用户、对端收到的是一个陌生 ID，
 * 于是旧的 PeerConnection 永远无法被正确重建，状态也全部丢失。
 * 这里用 sessionStorage 持久化一个稳定 ID（页面刷新也能沿用），
 * 让服务端在宽限期内把它识别为「同一个人重连」。
 */
const resolveStableUserId = (roomId: string) => {
  const key = `${USER_ID_STORAGE_PREFIX}${roomId}`
  try {
    const saved = sessionStorage.getItem(key)
    if (saved) return saved
    const created = createRandomId()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    // sessionStorage 不可用时退化为内存 ID（仅失去刷新后的重连能力）
    return createRandomId()
  }
}

const clearStableUserId = (roomId: string) => {
  try {
    sessionStorage.removeItem(`${USER_ID_STORAGE_PREFIX}${roomId}`)
  } catch {
    // 忽略
  }
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' }, // Cloudflare STUN（更稳定）
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  bundlePolicy: 'max-bundle',
  // rtcpMuxPolicy: 'require',
  // 建 PeerConnection 时就预热一条传输通道的候选，
  // 等到真正 setLocalDescription 时候选已就绪，可省掉几百毫秒的收集时间
  iceCandidatePoolSize: 2,
}

export function useWebRTC(roomId: string, userName: string) {
  const socket = shallowRef<Socket | null>(null)
  // 保持 WebRTC 传输用的 Stream ID 不变，避免 renegotiation 时被识别为新流
  const originLocalStream = new MediaStream()

  // 信令通道是否连通（用于 UI 显示「正在重连」）
  const signalingConnected = ref(false)
  const isReconnecting = ref(false)
  // 是否已经成功加入过房间，用于区分首次连接与重连
  const hasJoinedRoom = ref(false)

  /**
   * 本次页面加载的会话 ID —— 刻意不做持久化。
   * userId 跨刷新保持不变（用于身份识别），sessionId 每次加载都变（用于识别 JS 上下文已重建）。
   * 对端看到 sessionId 变化，就能立刻断定手里的 PeerConnection 已经是死的，
   * 不必等 ICE 超时（10~30 秒）才发现，这是刷新后重连慢的主要来源。
   */
  const localSessionId = createRandomId()

  /**
   * ====== 连接生命周期回调 ======
   *
   * 同传等上层模块需要知道「对端页面重载 / 对端离开房间 / 信令恢复」才能做降级与重连。
   * 这些判定（尤其是 sessionChanged）已经在本模块算过一次，
   * 不该让上层再监听一遍 socket 事件重复推导，所以在这里以订阅的形式暴露出去。
   */
  type PeerLifecycleListener = (peerId: string) => void
  type SignalingRestoredListener = (payload: { isReconnect: boolean }) => void

  const peerSessionChangedListeners = new Set<PeerLifecycleListener>()
  const peerRemovedListeners = new Set<PeerLifecycleListener>()
  const signalingLostListeners = new Set<() => void>()
  const signalingRestoredListeners = new Set<SignalingRestoredListener>()

  // 单个监听器抛错不能影响其他监听器，也不能打断信令处理流程
  const notifyListeners = <A extends unknown[]>(
    listeners: Set<(...args: A) => void>,
    ...args: A
  ) => {
    listeners.forEach((listener) => {
      try {
        listener(...args)
      } catch (e) {
        console.error('[WebRTC] 生命周期回调执行失败:', e)
      }
    })
  }

  /** 对端页面重新加载过（sessionId 变化），其上一个 JS 上下文里的一切都已失效 */
  const onPeerSessionChanged = (listener: PeerLifecycleListener) => {
    peerSessionChangedListeners.add(listener)
    return () => peerSessionChangedListeners.delete(listener)
  }

  /** 对端已被移出房间（主动离开，或掉线超过服务端宽限期） */
  const onPeerRemoved = (listener: PeerLifecycleListener) => {
    peerRemovedListeners.add(listener)
    return () => peerRemovedListeners.delete(listener)
  }

  /** 信令通道断开 */
  const onSignalingLost = (listener: () => void) => {
    signalingLostListeners.add(listener)
    return () => signalingLostListeners.delete(listener)
  }

  /** 信令通道可用，且 join-room 已经发出（此时再 emit 才不会被服务端当成陌生连接丢弃） */
  const onSignalingRestored = (listener: SignalingRestoredListener) => {
    signalingRestoredListeners.add(listener)
    return () => signalingRestoredListeners.delete(listener)
  }

  const localUser = reactive<User>({
    id: resolveStableUserId(roomId),
    name: userName,
    joinTime: Date.now(),
    micOpen: false,
    camOpen: false,
    isScreenSharing: false,
    isSpeaking: false,
    audioLevel: 0,
    connected: true,
    camStreamId: originLocalStream.id,
  })

  // 初始化为空的 MediaStream
  const localStream = shallowRef<MediaStream | null>(new MediaStream())
  const localScreenStream = shallowRef<MediaStream | null>(null)
  const localScreenShareFinalStream = shallowRef<MediaStream | null>(null)

  const deviceStore = useDeviceStore()

  // 混音相关
  let mixingAudioContext: AudioContext | null = null
  let mixingDestination: MediaStreamAudioDestinationNode | null = null
  let micSourceNode: MediaStreamAudioSourceNode | null = null

  // 远端用户列表 Map<userId, User>
  const users = reactive<Map<string, User>>(new Map())

  // PeerConnections Map<userId, RTCPeerConnection>
  const peers = new Map<string, RTCPeerConnection>()

  /**
   * 每个对端的协商状态（Perfect Negotiation 所需）。
   * polite 由双方 ID 大小确定，保证同一对用户中一方 polite、一方 impolite，
   * 出现 offer 冲突（glare）时 polite 一侧回滚让路，避免连接卡死。
   */
  interface PeerNegotiationState {
    pc: RTCPeerConnection
    polite: boolean
    makingOffer: boolean
    ignoreOffer: boolean
    isSettingRemoteAnswerPending: boolean
    createdAt: number
    recoveryAttempts: number
    recoveryTimer: ReturnType<typeof setTimeout> | null
  }
  const peerNegotiations = new Map<string, PeerNegotiationState>()
  // remoteDescription 未就绪时暂存的 ICE 候选
  const pendingCandidates = new Map<string, RTCIceCandidateInit[]>()

  const peerMicrophoneSenders = new Map<string, RTCRtpSender>()
  interface PeerAudioTrackOverride {
    track: MediaStreamTrack | null
    sender: RTCRtpSender | null
    originalMaxBitrates: Array<number | undefined> | null
    // 期望的码率上限（同传译音轨用）。存在这里是为了 PeerConnection 重建后能重新施加，
    // 否则重建会退回默认码率
    preferredMaxBitrate: number | null
  }
  const peerAudioTrackOverrides = new Map<string, PeerAudioTrackOverride>()
  const peerAudioTrackOperations = new Map<string, Promise<unknown>>()
  const wsURL = import.meta.env.VITE_WS_URL

  const enqueuePeerAudioTrackOperation = <T>(
    targetId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const previousOperation = peerAudioTrackOperations.get(targetId) ?? Promise.resolve()
    const currentOperation = previousOperation.catch(() => undefined).then(operation)
    peerAudioTrackOperations.set(targetId, currentOperation)
    void currentOperation
      .finally(() => {
        if (peerAudioTrackOperations.get(targetId) === currentOperation) {
          peerAudioTrackOperations.delete(targetId)
        }
      })
      .catch(() => undefined)
    return currentOperation
  }

  const getDefaultOutgoingAudio = () => {
    const screenAudioTrack = localScreenShareFinalStream.value?.getAudioTracks()[0]
    if (localUser.isScreenSharing && screenAudioTrack?.readyState === 'live') {
      return { track: screenAudioTrack, stream: localScreenShareFinalStream.value! }
    }

    const microphoneTrack = originLocalStream.getAudioTracks()[0]
    if (microphoneTrack?.readyState === 'live') {
      return { track: microphoneTrack, stream: originLocalStream }
    }

    return null
  }

  const getPeerMicrophoneSender = (targetId: string, pc: RTCPeerConnection) => {
    const sender = peerMicrophoneSenders.get(targetId)
    if (sender && pc.getSenders().includes(sender)) return sender

    peerMicrophoneSenders.delete(targetId)
    return null
  }

  const reservePeerAudioTrackOverride = (targetId: string) => {
    if (!peerAudioTrackOverrides.has(targetId)) {
      peerAudioTrackOverrides.set(targetId, {
        track: null,
        sender: null,
        originalMaxBitrates: null,
        preferredMaxBitrate: null,
      })
    }
  }

  // 施加 override 期望的码率上限（重建 PeerConnection 后也要能重新施加）
  const applyOverrideBitrate = async (sender: RTCRtpSender, maxBitrate: number | null) => {
    if (!maxBitrate) return
    try {
      const parameters = sender.getParameters()
      if (!parameters.encodings?.length) return
      parameters.encodings.forEach((encoding) => {
        encoding.maxBitrate = maxBitrate
      })
      await sender.setParameters(parameters)
    } catch (e) {
      console.warn('[WebRTC] 设置替换音轨码率失败:', e)
    }
  }

  const setPeerAudioTrackOverride = async (
    targetId: string,
    track: MediaStreamTrack,
    options?: { maxBitrate?: number },
  ) => {
    reservePeerAudioTrackOverride(targetId)
    const override = peerAudioTrackOverrides.get(targetId)!
    override.track = track
    if (options?.maxBitrate !== undefined) override.preferredMaxBitrate = options.maxBitrate

    return enqueuePeerAudioTrackOperation(targetId, async () => {
      const pc = peers.get(targetId)
      if (!pc) return null

      const defaultAudio = getDefaultOutgoingAudio()
      let sender = override.sender
      if (sender && !pc.getSenders().includes(sender)) sender = null
      if (!sender) sender = getPeerMicrophoneSender(targetId, pc)
      if (!sender && defaultAudio) {
        sender = pc.getSenders().find((candidate) => candidate.track === defaultAudio.track) ?? null
      }

      if (sender) {
        if (!override.originalMaxBitrates) {
          override.originalMaxBitrates = sender
            .getParameters()
            .encodings.map((encoding) => encoding.maxBitrate)
        }
        await sender.replaceTrack(track)
      } else {
        sender = pc.addTrack(track, originLocalStream)
        override.originalMaxBitrates = sender
          .getParameters()
          .encodings.map((encoding) => encoding.maxBitrate)
      }

      override.sender = sender
      peerMicrophoneSenders.set(targetId, sender)
      await applyOverrideBitrate(sender, override.preferredMaxBitrate)
      return sender
    })
  }

  const clearPeerAudioTrackOverride = async (targetId: string) => {
    const override = peerAudioTrackOverrides.get(targetId)
    peerAudioTrackOverrides.delete(targetId)
    if (!override) return

    return enqueuePeerAudioTrackOperation(targetId, async () => {
      const pc = peers.get(targetId)
      if (!pc) return

      const defaultAudio = getDefaultOutgoingAudio()
      let sender = override.sender
      if (sender && !pc.getSenders().includes(sender)) sender = null
      if (!sender) sender = getPeerMicrophoneSender(targetId, pc)
      const existingDefaultSender = defaultAudio
        ? pc.getSenders().find((candidate) => candidate.track === defaultAudio.track)
        : undefined

      if (sender) {
        if (existingDefaultSender && existingDefaultSender !== sender) {
          pc.removeTrack(sender)
          peerMicrophoneSenders.set(targetId, existingDefaultSender)
        } else {
          await sender.replaceTrack(defaultAudio?.track ?? null)
          const parameters = sender.getParameters()
          if (parameters.encodings?.length && override.originalMaxBitrates) {
            parameters.encodings.forEach((encoding, index) => {
              const originalMaxBitrate = override.originalMaxBitrates![index]
              if (originalMaxBitrate === undefined) delete encoding.maxBitrate
              else encoding.maxBitrate = originalMaxBitrate
            })
            await sender.setParameters(parameters)
          }
          peerMicrophoneSenders.set(targetId, sender)
        }
      } else if (defaultAudio && !existingDefaultSender) {
        const newSender = pc.addTrack(defaultAudio.track, defaultAudio.stream)
        peerMicrophoneSenders.set(targetId, newSender)
      }
    })
  }

  const isPeerAudioTrackOverridden = (targetId: string) => peerAudioTrackOverrides.has(targetId)

  /**
   * 重连时必须把本地完整状态重新上报一次。
   * 服务端在宽限期外会按默认值重建成员记录，
   * 只补发 camStreamId（原实现）会让对端看到「麦克风/摄像头全关」的错误状态。
   */
  const buildLocalStatus = () => ({
    micOpen: localUser.micOpen,
    camOpen: localUser.camOpen,
    isScreenSharing: localUser.isScreenSharing,
    camStreamId: localUser.camStreamId,
    screenStreamId: localUser.screenStreamId,
    isSpeaking: false,
    audioLevel: 0,
  })

  // 初始化
  const init = async () => {
    // 1. 不再自动获取媒体流，默认 micOpen/camOpen 都是 false
    // 2. WebSocket 连接
    socket.value = io(wsURL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 400,
      reconnectionDelayMax: 3000,
      randomizationFactor: 0.3,
      timeout: 8000,
    })

    socket.value.on('connect', () => {
      signalingConnected.value = true
      isReconnecting.value = false
      console.log(`[WebRTC] 信令已连接，${hasJoinedRoom.value ? '重新加入' : '加入'}房间 ${roomId}`)

      // 用稳定 userId 加入，并带上当前真实状态，服务端据此识别重连并同步给其他人
      socket.value!.emit('join-room', {
        roomId,
        userName,
        userId: localUser.id,
        sessionId: localSessionId,
        status: buildLocalStatus(),
      })

      const isReconnect = hasJoinedRoom.value
      hasJoinedRoom.value = true

      // 必须在 join-room 之后再通知：socket.io 会在 connect 回调之前 flush 掉线期间
      // 缓冲的 emit（socket.js onconnect 里 emitBuffered 早于 emitReserved('connect')），
      // 那些包到达服务端时 socket.data.roomId 还没设上，会被静默丢弃。
      // 所以上层要补发的消息必须挂在这个回调里。
      notifyListeners(signalingRestoredListeners, { isReconnect })
    })

    socket.value.on('disconnect', (reason) => {
      signalingConnected.value = false
      // 主动断开（离开房间）不算重连
      isReconnecting.value = reason !== 'io client disconnect'
      console.warn('[WebRTC] 信令断开:', reason)
      // 恢复计划不清空：recoverPeer 会在信令不通时自动顺延，
      // 信令一恢复就能继续重连，避免连接永远停在 connecting
      notifyListeners(signalingLostListeners)
    })

    socket.value.on('connect_error', (err) => {
      signalingConnected.value = false
      isReconnecting.value = true
      console.warn('[WebRTC] 信令连接失败:', err.message)
    })

    // 3. 处理信令
    // room-users 既是首次加入的初始化，也是每次重连后的全量对账
    socket.value.on('room-users', (userList: User[]) => {
      const remoteIds = new Set<string>()
      const staleSessions = new Set<string>()

      userList.forEach((u) => {
        if (u.id === localUser.id) return
        remoteIds.add(u.id)
        if (upsertUser(u).sessionChanged) staleSessions.add(u.id)
      })

      // 清理已经不在房间里的用户（重连期间离开的人）
      Array.from(users.keys()).forEach((id) => {
        if (!remoteIds.has(id)) removeUser(id)
      })

      // 先让上层释放跟旧会话绑定的资源，再重建连接，
      // 这样 createPeerConnection 才不会把对端已失效的替换轨重新挂上去
      staleSessions.forEach((id) => notifyListeners(peerSessionChangedListeners, id))

      // 确保和每个成员都有可用连接：坏的重建，好的保留
      remoteIds.forEach((id) => ensurePeerConnection(id, { force: staleSessions.has(id) }))
    })

    socket.value.on('user-joined', (newUser: User) => {
      console.log('[WebRTC] 用户加入:', newUser.id, newUser.name)
      const { sessionChanged } = upsertUser(newUser)
      if (sessionChanged) notifyListeners(peerSessionChangedListeners, newUser.id)
      ensurePeerConnection(newUser.id, { force: sessionChanged })
    })

    // 对端信令重连成功：状态回灌 + 校验 P2P 连接是否还活着。
    // 若对端 sessionId 变了（页面刷新），立刻重建，不等 ICE 超时
    socket.value.on('user-rejoined', (user: User) => {
      const { sessionChanged } = upsertUser(user)
      console.log(
        `[WebRTC] 用户重连: ${user.id} ${user.name}${sessionChanged ? '（页面已重载，立刻重建连接）' : ''}`,
      )
      if (sessionChanged) notifyListeners(peerSessionChangedListeners, user.id)
      ensurePeerConnection(user.id, { force: sessionChanged })
    })

    // 对端信令掉线（仍在服务端宽限期内）：只标记，不销毁连接
    socket.value.on('user-offline', ({ id }: { id: string }) => {
      const user = users.get(id)
      if (user) user.reconnecting = true
    })

    socket.value.on('user-left', (userId: string) => {
      console.log('[WebRTC] 用户离开:', userId)
      removeUser(userId)
    })

    // 对端要求重建连接（它那侧判定连接已不可用）
    socket.value.on('peer-reset', ({ sender }: { sender: string }) => {
      if (!users.has(sender)) return
      const state = peerNegotiations.get(sender)
      // 防抖：双方同时判定需要重建时，忽略刚建好的连接上的重置请求
      if (state && Date.now() - state.createdAt < PEER_RESET_DEBOUNCE_MS) return
      console.log(`[WebRTC] 收到 ${sender} 的重建请求`)
      createPeerConnection(sender)
    })

    socket.value.on('offer', async ({ sdp, sender }) => {
      await handleRemoteDescription(sender, sdp)
    })

    socket.value.on('answer', async ({ sdp, sender }) => {
      await handleRemoteDescription(sender, sdp)
    })

    socket.value.on('ice-candidate', async ({ candidate, sender }) => {
      await handleCandidate(sender, candidate)
    })

    socket.value.on('user-update', (data: Partial<User> & { id: string }) => {
      const user = users.get(data.id)
      if (user) {
        applyRemoteUserState(user, pickRemoteState(data))
      }
    })
  }

  const reorganizeStreams = (user: User) => {
    // 收集当前该用户持有的所有活跃流
    const streams = new Set<MediaStream>()
    if (user.stream) streams.add(user.stream)
    if (user.screenStream) streams.add(user.screenStream)

    // 先清空，准备重新分配
    user.stream = undefined
    user.screenStream = undefined

    streams.forEach((s) => {
      if (s.id === user.camStreamId) {
        user.stream = s
      } else if (s.id === user.screenStreamId) {
        user.screenStream = s
      } else {
        // Fallback: 如果没有 ID 匹配（比如旧版本或者状态还没同步），优先给 stream，满了给 screenStream
        if (!user.stream) user.stream = s
        else user.screenStream = s
      }
    })
  }

  // 服务端会下发的状态字段（不含本地持有的媒体流与连接状态）
  const REMOTE_STATE_FIELDS = [
    'name',
    'joinTime',
    'micOpen',
    'camOpen',
    'isScreenSharing',
    'isSpeaking',
    'audioLevel',
    'camStreamId',
    'screenStreamId',
    'isDesktop',
    'sessionId',
  ] as const

  // 只挑出真正下发了的字段，避免用 undefined 覆盖掉本地已有状态
  const pickRemoteState = (source: Partial<User>): Partial<User> => {
    const patch: Record<string, unknown> = {}
    for (const field of REMOTE_STATE_FIELDS) {
      const value = (source as Record<string, unknown>)[field]
      if (value !== undefined) patch[field] = value
    }
    return patch as Partial<User>
  }

  /**
   * 把远端状态合并到本地用户对象上，并按状态清洗残留的媒体流。
   * user-update 与 room-users / user-rejoined 的状态重同步都走这里，
   * 保证「重连后开关状态不同步」的问题不会因为走了不同分支而复现。
   */
  const applyRemoteUserState = (user: User, patch: Partial<User>) => {
    Object.assign(user, patch)

    reorganizeStreams(user)

    // 根据状态强制清洗媒体流，保证UI更新
    if (patch.camOpen === false && user.stream) {
      // 只清理视频轨道，保留音频轨道（因为可能开着麦克风）
      user.stream.getVideoTracks().forEach((t) => t.stop())
      // 只有当没有活跃轨道时才置空
      if (!user.stream.getTracks().some((t) => t.readyState === 'live')) {
        user.stream = undefined
      }
    }
    // 修复说话状态残留: 如果对方关闭麦克风，强制重置说话状态
    if (patch.micOpen === false) {
      user.isSpeaking = false
      user.audioLevel = 0
    }
    if (patch.isScreenSharing === false && user.screenStream) {
      user.screenStream.getTracks().forEach((t) => t.stop())
      user.screenStream = undefined
    }
  }

  /**
   * 新增或更新用户。
   * 之前这里在用户已存在时直接 return，导致重连后收到的 room-users 快照被丢弃，
   * 对端的麦克风/摄像头状态一直停留在断线前的旧值。
   *
   * 返回 sessionChanged：对端页面重新加载过，此时本地那条 PeerConnection
   * 必然已经失效，调用方应立刻强制重建而不是等 ICE 超时。
   */
  const upsertUser = (userData: Partial<User> & { id: string }) => {
    const existing = users.get(userData.id)

    if (!existing) {
      users.set(userData.id, {
        micOpen: false,
        camOpen: false,
        isScreenSharing: false,
        joinTime: Date.now(),
        name: '',
        ...userData,
        connected: false,
        reconnecting: false,
        stream: undefined,
        screenStream: undefined,
      })
      return { isNew: true, sessionChanged: false }
    }

    const sessionChanged = Boolean(
      userData.sessionId && existing.sessionId && userData.sessionId !== existing.sessionId,
    )

    if (sessionChanged) {
      // 上个会话的流已经彻底失效，立刻丢掉，避免界面卡在最后一帧
      existing.stream?.getTracks().forEach((t) => t.stop())
      existing.screenStream?.getTracks().forEach((t) => t.stop())
      existing.stream = undefined
      existing.screenStream = undefined
      existing.connected = false
    }

    // 已存在：只覆盖状态字段，保留已经收到的媒体流与真实连接状态
    applyRemoteUserState(existing, { ...pickRemoteState(userData), reconnecting: false })

    return { isNew: false, sessionChanged }
  }

  const clearPeerRecoveryTimer = (targetId: string) => {
    const state = peerNegotiations.get(targetId)
    if (state?.recoveryTimer) {
      clearTimeout(state.recoveryTimer)
      state.recoveryTimer = null
    }
  }

  /**
   * 彻底销毁与某个对端的 PeerConnection。
   * 注意：同传的音轨（peerAudioTrackOverrides.track）要保留，
   * 只清掉与旧 PeerConnection 绑定的 sender 引用，重建时会重新 addTrack。
   */
  const destroyPeer = (targetId: string) => {
    clearPeerRecoveryTimer(targetId)
    peerNegotiations.delete(targetId)
    peerMicrophoneSenders.delete(targetId)

    const override = peerAudioTrackOverrides.get(targetId)
    if (override) {
      override.sender = null
      override.originalMaxBitrates = null
    }

    const pc = peers.get(targetId)
    if (pc) {
      pendingCandidates.delete(targetId)
      pc.onnegotiationneeded = null
      pc.onicecandidate = null
      pc.oniceconnectionstatechange = null
      pc.onconnectionstatechange = null
      pc.ontrack = null
      try {
        pc.close()
      } catch (e) {
        console.warn('[WebRTC] 关闭 PeerConnection 失败:', e)
      }
      peers.delete(targetId)
    }

    const user = users.get(targetId)
    if (user) user.connected = false
  }

  const removeUser = (userId: string) => {
    if (!users.has(userId)) return

    // 先通知上层：此时 users 与 override 都还在，监听者可以完成自己的清理。
    // 同传依赖这个回调停掉 Gemini 会话并把音轨换回麦克风，否则对端离开后会一直计费。
    notifyListeners(peerRemovedListeners, userId)

    destroyPeer(userId)
    pendingCandidates.delete(userId)
    peerAudioTrackOverrides.delete(userId)
    users.delete(userId)
  }

  // 优化屏幕共享发送端参数，提高画质和流畅度
  const optimizeScreenSender = (sender: RTCRtpSender) => {
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }

      // 提高码率上限到 8Mbps 保证画质和流畅度 (WebRTC 默认对屏幕共享限制较低)
      if (params.encodings && params.encodings[0]) {
        params.encodings[0].maxBitrate = 8000000
      }
      // 追求流畅度，设置 degradePreference 为 balanced 或 maintain-framerate
      // 这样在网络波动时会权衡帧率和分辨率，而不会像默认那样死保分辨率导致卡顿严重
      params.degradationPreference = 'balanced'

      sender.setParameters(params).catch((e) => console.warn('Set sender parameters failed:', e))
    } catch (e) {
      console.warn('Optimize screen sender failed:', e)
    }
  }

  // ID 字典序决定 polite 角色，保证同一对用户双方结论必然相反
  const isPolitePeer = (targetId: string) => localUser.id < targetId

  const isPeerUsable = (pc: RTCPeerConnection | undefined) => {
    if (!pc) return false
    if (pc.signalingState === 'closed') return false
    return (
      pc.connectionState === 'new' ||
      pc.connectionState === 'connecting' ||
      pc.connectionState === 'connected'
    )
  }

  /**
   * 创建与某个对端的 PeerConnection（内部会先销毁旧连接）。
   *
   * 原实现是 `if (peers.has(targetId)) return peers.get(targetId)`，
   * 断线重连后对端会以「新用户」身份重新发 offer，而本地这个 ID 对应的
   * PeerConnection 还是断线前那个 failed 状态的旧对象，于是 offer 被灌进
   * 一个永远不可能再连上的连接里 —— 这就是「用户列表能显示、
   * 但音视频连不上、状态一直是连接中」的根因。
   */
  const createPeerConnection = (targetId: string) => {
    destroyPeer(targetId)

    const polite = isPolitePeer(targetId)
    const pc = new RTCPeerConnection(ICE_SERVERS)
    const state: PeerNegotiationState = {
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      createdAt: Date.now(),
      recoveryAttempts: 0,
      recoveryTimer: null,
    }
    peers.set(targetId, pc)
    peerNegotiations.set(targetId, state)

    console.log(`[WebRTC] 建立 PeerConnection -> ${targetId} (polite=${polite})`)

    // 创建 DataChannel 以确保即使没有音视频流也能建立连接
    // 只由 impolite 一侧创建，避免双方同时创建产生多余协商
    if (!polite) {
      pc.createDataChannel('keepalive')
    }

    // 添加本地流 (如果已有轨道)
    // 使用 originLocalStream 确保 Stream ID 一致
    const audioOverride = peerAudioTrackOverrides.get(targetId)
    originLocalStream.getTracks().forEach((track) => {
      if (track.kind === 'audio' && audioOverride) return
      const sender = pc.addTrack(track, originLocalStream)
      if (track.kind === 'audio') peerMicrophoneSenders.set(targetId, sender)
    })
    if (audioOverride?.track) {
      const sender = pc.addTrack(audioOverride.track, originLocalStream)
      audioOverride.sender = sender
      peerMicrophoneSenders.set(targetId, sender)
      audioOverride.originalMaxBitrates = sender
        .getParameters()
        .encodings.map((encoding) => encoding.maxBitrate)
      // 重建后要重新施加码率上限，否则译音轨会按默认码率发送
      void applyOverrideBitrate(sender, audioOverride.preferredMaxBitrate)
    }
    if (!peerMicrophoneSenders.has(targetId)) {
      const audioTransceiver = pc.addTransceiver('audio', {
        direction: 'sendrecv',
        streams: [originLocalStream],
      })
      peerMicrophoneSenders.set(targetId, audioTransceiver.sender)
    }

    // 如果正在屏幕共享，也添加屏幕流
    if (localScreenShareFinalStream.value) {
      localScreenShareFinalStream.value.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localScreenShareFinalStream.value!)
        if (track.kind === 'video') {
          optimizeScreenSender(sender)
        }
      })
    }

    // 监听协商事件 (处理动态添加/移除轨道)
    // Perfect Negotiation：不再因为 signalingState 不稳定就直接放弃，
    // 否则开关摄像头/麦克风的变更会被静默丢弃，永远同步不到对端
    pc.onnegotiationneeded = async () => {
      if (peers.get(targetId) !== pc) return
      try {
        state.makingOffer = true
        await pc.setLocalDescription()
        if (peers.get(targetId) !== pc || !pc.localDescription) return
        socket.value?.emit('offer', {
          target: targetId,
          sdp: pc.localDescription,
        })
      } catch (e) {
        console.error(`[WebRTC] 创建 offer 失败 (${targetId}):`, e)
      } finally {
        state.makingOffer = false
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.value?.emit('ice-candidate', {
          target: targetId,
          candidate: event.candidate,
        })
      }
    }

    // 监听 ICE 连接状态，交由统一的恢复流程处理
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE 状态 ${targetId}: ${pc.iceConnectionState}`)
      if (peers.get(targetId) !== pc) return
      if (pc.iceConnectionState === 'failed') {
        schedulePeerRecovery(targetId, 0)
      }
    }

    pc.ontrack = (event) => {
      const user = users.get(targetId)
      if (user) {
        const stream = event.streams[0]
        if (!stream) return

        // 监听 track 结束事件，清理无效流
        event.track.onended = () => {
          // 检查 user.stream 是否还存在且 ID 匹配
          if (user.stream && user.stream.id === stream.id) {
            // 检查当前 user.stream 中是否还有活跃轨道（而不是检查闭包中的 stream，因为 stream 可能已过时）
            const hasLiveTracks = user.stream.getTracks().some((t) => t.readyState === 'live')
            if (!hasLiveTracks) {
              user.stream = undefined
            }
          }

          // 同理检查 screenStream
          if (user.screenStream && user.screenStream.id === stream.id) {
            const hasLiveTracks = user.screenStream.getTracks().some((t) => t.readyState === 'live')
            if (!hasLiveTracks) {
              user.screenStream = undefined
            }
          }
        }

        // 智能分配流：优先更新同 ID 的流引用（确保获取到最新的 Tracks），否则填充空位
        if (user.stream && user.stream.id === stream.id) {
          user.stream = stream
        } else if (user.screenStream && user.screenStream.id === stream.id) {
          user.screenStream = stream
        } else {
          // ID 不匹配，填充空位
          const isStreamActive =
            user.stream && user.stream.getTracks().some((t) => t.readyState === 'live')

          if (!isStreamActive) {
            user.stream = stream
          } else {
            user.screenStream = stream
          }
        }

        reorganizeStreams(user)
      }
    }

    pc.onconnectionstatechange = () => {
      if (peers.get(targetId) !== pc) return
      console.log(`[WebRTC] 连接状态 ${targetId}: ${pc.connectionState}`)

      const user = users.get(targetId)
      if (user) {
        user.connected = pc.connectionState === 'connected'
      }

      switch (pc.connectionState) {
        case 'connected':
          state.recoveryAttempts = 0
          clearPeerRecoveryTimer(targetId)
          break
        case 'disconnected':
          // 可能是短暂抖动，先等一会看是否自愈
          schedulePeerRecovery(targetId, DISCONNECTED_RECOVERY_DELAY_MS)
          break
        case 'failed':
          schedulePeerRecovery(targetId, 0)
          break
      }
    }

    // 兜底看门狗：连接一直停在 new / connecting（协商消息丢失等）时主动重试，
    // 避免 UI 永远停留在「连接中」
    schedulePeerRecovery(targetId, PEER_CONNECT_TIMEOUT_MS)

    return pc
  }

  /**
   * 确保与某个对端存在「可用」的连接。
   * 已有连接但处于 failed / closed / disconnected 时会协同对端一起重建。
   *
   * force：对端 sessionId 变化（页面重新加载）时用，绕过健康检查直接重建。
   * 因为此时本地连接的 connectionState 往往还停留在 connected，
   * 光看状态要等 ICE 超时才能发现，那正是重连要等十几秒的原因。
   */
  const ensurePeerConnection = (targetId: string, options?: { force?: boolean }) => {
    if (targetId === localUser.id) return
    if (!users.has(targetId)) return

    const pc = peers.get(targetId)
    if (!options?.force && isPeerUsable(pc)) return

    if (pc) {
      resetPeerConnection(targetId)
      return
    }
    createPeerConnection(targetId)
  }

  /** 通知对端一起销毁重建，然后本地重建 */
  const resetPeerConnection = (targetId: string) => {
    if (!users.has(targetId)) return
    console.log(`[WebRTC] 重建与 ${targetId} 的连接`)
    socket.value?.emit('peer-reset', { target: targetId })
    createPeerConnection(targetId)
  }

  const schedulePeerRecovery = (targetId: string, delay: number) => {
    const state = peerNegotiations.get(targetId)
    if (!state || state.recoveryTimer) return
    state.recoveryTimer = setTimeout(() => {
      state.recoveryTimer = null
      void recoverPeer(targetId)
    }, delay)
  }

  /**
   * 连接异常时的分级恢复：先尝试有限次 ICE 重启，无效再彻底重建连接。
   * 彻底重建优先由 impolite 一侧发起，polite 一侧多等几轮兜底，
   * 避免双方同时重建导致来回抖动。
   */
  const recoverPeer = async (targetId: string) => {
    const state = peerNegotiations.get(targetId)
    if (!state || !users.has(targetId)) return

    const pc = state.pc
    if (peers.get(targetId) !== pc) return
    if (pc.connectionState === 'connected' || pc.signalingState === 'closed') return

    // 信令不通时无法协商，保持排队等信令恢复后再试（不消耗重试次数）
    if (!socket.value?.connected) {
      schedulePeerRecovery(targetId, RECOVERY_RETRY_DELAY_MS)
      return
    }

    if (state.recoveryAttempts < MAX_ICE_RESTARTS) {
      state.recoveryAttempts++
      console.log(`[WebRTC] 尝试 ICE 重启 ${targetId} (第 ${state.recoveryAttempts} 次)`)
      try {
        if (typeof pc.restartIce === 'function') {
          // 会触发 onnegotiationneeded，由 Perfect Negotiation 完成重新协商
          pc.restartIce()
        } else if (!state.polite) {
          const offer = await pc.createOffer({ iceRestart: true })
          await pc.setLocalDescription(offer)
          socket.value?.emit('offer', { target: targetId, sdp: pc.localDescription })
        }
      } catch (e) {
        console.warn(`[WebRTC] ICE 重启失败 (${targetId}):`, e)
      }
      schedulePeerRecovery(targetId, RECOVERY_RETRY_DELAY_MS)
      return
    }

    // polite 一侧再多等两轮，等 impolite 一侧的 peer-reset
    if (state.polite && state.recoveryAttempts < MAX_ICE_RESTARTS + 2) {
      state.recoveryAttempts++
      schedulePeerRecovery(targetId, RECOVERY_RETRY_DELAY_MS)
      return
    }

    resetPeerConnection(targetId)
  }

  const flushPendingCandidates = async (senderId: string, pc: RTCPeerConnection) => {
    const queued = pendingCandidates.get(senderId)
    if (!queued?.length) return
    pendingCandidates.delete(senderId)
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (e) {
        console.warn(`[WebRTC] 补发 ICE 候选失败 (${senderId}):`, e)
      }
    }
  }

  /**
   * 统一处理 offer / answer（Perfect Negotiation）。
   * 冲突时 polite 一侧靠 setRemoteDescription 的隐式回滚让路，
   * impolite 一侧直接忽略对端 offer，从而不会出现双方都卡住的情况。
   */
  const handleRemoteDescription = async (
    senderId: string,
    description: RTCSessionDescriptionInit,
  ) => {
    if (senderId === localUser.id) return

    if (!users.has(senderId)) {
      // 信令乱序兜底：offer 比 room-users / user-joined 先到时先占位，
      // 后续的成员信息会覆盖掉这里的占位值，避免直接丢弃 offer 导致连接建不起来
      if (description.type !== 'offer') return
      upsertUser({ id: senderId, name: '' })
    }

    let state = peerNegotiations.get(senderId)
    if (!state || peers.get(senderId) !== state.pc) {
      // 只有 offer 才允许触发新建连接，迟到的 answer 直接丢弃
      if (description.type !== 'offer') return
      createPeerConnection(senderId)
      state = peerNegotiations.get(senderId)
      if (!state) return
    }

    const pc = state.pc

    try {
      const readyForOffer =
        !state.makingOffer && (pc.signalingState === 'stable' || state.isSettingRemoteAnswerPending)
      const offerCollision = description.type === 'offer' && !readyForOffer

      state.ignoreOffer = !state.polite && offerCollision
      if (state.ignoreOffer) {
        console.log(`[WebRTC] 忽略来自 ${senderId} 的冲突 offer (impolite)`)
        return
      }

      if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') {
        // 过期的 answer（例如刚刚回滚过），忽略即可
        return
      }

      state.isSettingRemoteAnswerPending = description.type === 'answer'
      await pc.setRemoteDescription(new RTCSessionDescription(description))
      state.isSettingRemoteAnswerPending = false

      if (peers.get(senderId) !== pc) return
      await flushPendingCandidates(senderId, pc)

      if (description.type === 'offer') {
        await pc.setLocalDescription()
        if (peers.get(senderId) !== pc || !pc.localDescription) return
        socket.value?.emit('answer', {
          target: senderId,
          sdp: pc.localDescription,
        })
      }
    } catch (e) {
      state.isSettingRemoteAnswerPending = false
      console.error(`[WebRTC] 处理 ${description.type} 失败 (${senderId}):`, e)
    }
  }

  const handleCandidate = async (senderId: string, candidate: RTCIceCandidateInit) => {
    const state = peerNegotiations.get(senderId)

    // 连接不存在 / 已被重建 / remoteDescription 还没设上时都不能直接 addIceCandidate，先缓存
    if (!state || peers.get(senderId) !== state.pc || !state.pc.remoteDescription) {
      const queued = pendingCandidates.get(senderId) ?? []
      queued.push(candidate)
      pendingCandidates.set(senderId, queued)
      return
    }

    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (e) {
      // 忽略被丢弃的 offer 所对应的候选
      if (!state.ignoreOffer) {
        console.warn(`[WebRTC] 添加 ICE 候选失败 (${senderId}):`, e)
      }
    }
  }

  // 开关麦克风
  const applyMicrophoneToggle = async () => {
    if (!localStream.value) return

    if (localUser.micOpen) {
      // 关闭：停止轨道并销毁
      const audioTrack = localStream.value.getAudioTracks()[0]
      if (audioTrack) {
        // 如果在混音中，断开连接
        if (localUser.isScreenSharing && micSourceNode) {
          micSourceNode.disconnect()
          micSourceNode = null
        } else {
          // 只有不在屏幕共享模式下，才去移除 PC 里的 Sender
          // 因为屏幕共享模式下，Audio Track 是混音后的（包含系统音频），不能移除
          const replacements: Promise<void>[] = []
          peers.forEach((pc, targetId) => {
            if (isPeerAudioTrackOverridden(targetId)) return
            const sender =
              getPeerMicrophoneSender(targetId, pc) ??
              pc.getSenders().find((candidate) => candidate.track === audioTrack)
            if (sender) {
              peerMicrophoneSenders.set(targetId, sender)
              replacements.push(sender.replaceTrack(null))
            }
          })
          await Promise.all(replacements)
        }

        audioTrack.stop()
        localStream.value.removeTrack(audioTrack)
        originLocalStream.removeTrack(audioTrack)

        // 触发更新
        localStream.value = new MediaStream(originLocalStream.getTracks())
      }
      stopSpeakingDetection()
      localUser.micOpen = false
    } else {
      // 开启：创建新流
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            // @ts-expect-error Google和egde的独有参数，防啸叫
            googEchoCancellation: true,
            googExperimentalEchoCancellation: true,
            googAutoGainControl: false,
            googNoiseSuppression: true,
            googHighpassFilter: true,
            latency: 0,
          },
        })
        const audioTrack = stream.getAudioTracks()[0]

        if (audioTrack) {
          localStream.value.addTrack(audioTrack)
          originLocalStream.addTrack(audioTrack)

          // 核心修改：如果正在屏幕共享，使用混音；否则独立发送
          if (localUser.isScreenSharing && mixingAudioContext && mixingDestination) {
            micSourceNode = mixingAudioContext.createMediaStreamSource(
              new MediaStream([audioTrack]),
            )
            micSourceNode.connect(mixingDestination)
          } else {
            // 独立发送
            const replacements: Promise<void>[] = []
            peers.forEach((pc, targetId) => {
              if (isPeerAudioTrackOverridden(targetId)) return
              const sender = getPeerMicrophoneSender(targetId, pc)
              if (sender) {
                replacements.push(sender.replaceTrack(audioTrack))
              } else {
                peerMicrophoneSenders.set(targetId, pc.addTrack(audioTrack, originLocalStream))
              }
            })
            await Promise.all(replacements)
          }

          localStream.value = new MediaStream(originLocalStream.getTracks())
          localUser.micOpen = true
          startSpeakingDetection(localStream.value) //开始电平计算
        }
      } catch (e) {
        console.error('Failed to open mic:', e)
        alert('无法开启麦克风，请检查设备权限')
      }
    }

    socket.value?.emit('update-status', { roomId, status: { micOpen: localUser.micOpen } })
  }

  let microphoneToggleOperation: Promise<void> = Promise.resolve()
  const toggleMic = () => {
    const nextOperation = microphoneToggleOperation
      .catch(() => undefined)
      .then(applyMicrophoneToggle)
    microphoneToggleOperation = nextOperation
    return nextOperation
  }

  // 辅助函数：获取流并带有重试逻辑
  const getStream = async (
    constraints: MediaStreamConstraints,
    retries = 2,
  ): Promise<MediaStream> => {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (error: unknown) {
      const err = error as { name: string }
      if (
        retries > 0 &&
        (err.name === 'NotReadableError' ||
          err.name === 'TrackStartError' ||
          err.name === 'AbortError' ||
          err.name === 'OverconstrainedError')
      ) {
        console.warn(`getStream failed with ${err.name}, retrying... (${retries} left)`)

        // 尝试停止现有的视频轨道以释放硬件资源
        if (localStream.value) {
          localStream.value.getVideoTracks().forEach((t) => t.stop())
        }

        // 等待一小段时间
        await new Promise((resolve) => setTimeout(resolve, 500))
        return getStream(constraints, retries - 1)
      }
      throw error
    }
  }

  //开关摄像头
  const toggleCam = async () => {
    if (!localStream.value) return

    if (localUser.camOpen) {
      // 关闭：停止轨道并销毁
      const videoTrack = localStream.value.getVideoTracks()[0]
      if (videoTrack) {
        // 先移除 Sender，避免 track.stop() 后找不到 sender
        peers.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track === videoTrack)
          if (sender) {
            pc.removeTrack(sender)
          }
        })

        videoTrack.stop()
        localStream.value.removeTrack(videoTrack)
        originLocalStream.removeTrack(videoTrack)

        localStream.value = new MediaStream(originLocalStream.getTracks())
      }
      localUser.camOpen = false
    } else {
      // 开启：创建新流
      try {
        const stream = await getStream({
          video: { facingMode: currentFacingMode.value },
        })
        const videoTrack = stream.getVideoTracks()[0]

        if (videoTrack) {
          localStream.value.addTrack(videoTrack)
          originLocalStream.addTrack(videoTrack)
          peers.forEach((pc) => {
            pc.addTrack(videoTrack, originLocalStream)
          })

          localStream.value = new MediaStream(originLocalStream.getTracks())
          localUser.camOpen = true
        }
      } catch (e) {
        console.error('Failed to open camera:', e)
        alert('无法开启摄像头，请检查设备权限')
      }
    }

    socket.value?.emit('update-status', { roomId, status: { camOpen: localUser.camOpen } })
  }

  const currentFacingMode = ref<'user' | 'environment'>('user')

  //移动端转换前后摄像头
  const switchCamera = async () => {
    if (!localUser.camOpen || !localStream.value) {
      // 如果摄像头未开启，直接开启
      toggleCam()
      return
    }

    // 1. 确定目标配置 (优先使用 deviceId 以确保切换，降级使用 facingMode)
    const nextFacingMode = currentFacingMode.value === 'user' ? 'environment' : 'user'
    let constraints: MediaStreamConstraints['video'] = { facingMode: nextFacingMode }
    const oldVideoTrack = localStream.value.getVideoTracks()[0]

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter((d) => d.kind === 'videoinput')

      if (videoDevices.length > 1) {
        const currentDeviceId = oldVideoTrack?.getSettings().deviceId
        let nextDevice = videoDevices[1] // 默认第二个

        if (currentDeviceId) {
          const currentIndex = videoDevices.findIndex((d) => d.deviceId === currentDeviceId)
          if (currentIndex !== -1) {
            const nextIndex = (currentIndex + 1) % videoDevices.length
            nextDevice = videoDevices[nextIndex]
          }
        }

        if (nextDevice) {
          constraints = { deviceId: { exact: nextDevice.deviceId } }
        }
      }
    } catch (e) {
      console.warn('Enumerate devices failed, fallback to facingMode', e)
    }

    // 2. 关键修改：在移动端/兼容性差的浏览器上，必须先停止旧轨道才能开启新轨道
    // 这是解决 NotReadableError 最可靠的方法
    // 分类判断：三星浏览器或移动端设备优先采取"先停后开"策略
    const shouldStopFirst = deviceStore.isMobile
    if (oldVideoTrack && shouldStopFirst) {
      oldVideoTrack.stop()
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints })
      const newVideoTrack = stream.getVideoTracks()[0]

      if (newVideoTrack) {
        // 更新 Peers
        peers.forEach((pc) => {
          const senders = pc.getSenders()
          // 尝试找到旧 track 的 sender (注意：oldVideoTrack 已经 stop 了，但引用还在)
          let sender = senders.find((s) => s.track === oldVideoTrack)

          if (!sender) {
            // 兜底：查找第一个 video kind 的 sender
            sender = senders.find((s) => s.track?.kind === 'video')
          }

          if (sender) {
            sender.replaceTrack(newVideoTrack).catch((e) => console.error('replaceTrack failed', e))
          } else {
            pc.addTrack(newVideoTrack, originLocalStream)
          }
        })

        // 更新本地流引用
        if (oldVideoTrack) {
          localStream.value.removeTrack(oldVideoTrack)
          originLocalStream.removeTrack(oldVideoTrack)
        }
        localStream.value.addTrack(newVideoTrack)
        originLocalStream.addTrack(newVideoTrack)
        localStream.value = new MediaStream(originLocalStream.getTracks())

        // 更新状态
        currentFacingMode.value = nextFacingMode
        localUser.camOpen = true
        socket.value?.emit('update-status', { roomId, status: { camOpen: true } })
      }
    } catch (e) {
      console.error('Switch camera failed:', e)

      // 3. 失败回滚：尝试恢复原来的摄像头
      try {
        console.log('Attempting to restore previous camera...')
        const restoreStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: currentFacingMode.value },
        })
        const restoreTrack = restoreStream.getVideoTracks()[0]
        if (restoreTrack) {
          localStream.value.addTrack(restoreTrack)
          originLocalStream.addTrack(restoreTrack)
          localStream.value = new MediaStream(originLocalStream.getTracks())
        }
      } catch (restoreErr) {
        console.error('Restore failed:', restoreErr)
        localUser.camOpen = false
      }

      alert('切换摄像头失败，请检查设备权限或浏览器兼容性')
    }
  }

  const startScreenShare = async () => {
    if (!localStream.value) return

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // @ts-expect-error resizeMode 用于解决 HDR 屏幕共享发白及缩放导致的高延迟问题
          resizeMode: 'none',
          frameRate: { ideal: 30, max: 60 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      const videoTrack = stream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.contentHint = 'detail' // 优化文字等细节展示，降低模糊带来的延迟感
      }

      localScreenStream.value = stream
      localUser.isScreenSharing = true
      // socket.value?.emit('update-status', { roomId, status: { isScreenSharing: true } }) // 延迟到后面带 ID 发送

      // 混音逻辑
      mixingAudioContext = getSharedAudioContext()
      mixingDestination = mixingAudioContext.createMediaStreamDestination()

      // 麦克风接入 (如果有)
      if (localStream.value.getAudioTracks().length > 0) {
        const audioTrack = localStream.value.getAudioTracks()[0]
        if (audioTrack) {
          // 移除独立发送器，转为混音发送
          peers.forEach((pc, targetId) => {
            if (isPeerAudioTrackOverridden(targetId)) return
            const sender = pc.getSenders().find((s) => s.track === audioTrack)
            if (sender) pc.removeTrack(sender)
          })

          // 连接到混音器
          micSourceNode = mixingAudioContext.createMediaStreamSource(new MediaStream([audioTrack]))
          micSourceNode.connect(mixingDestination)
        }
      }

      // 系统音频接入
      if (stream.getAudioTracks().length > 0) {
        const sysSource = mixingAudioContext.createMediaStreamSource(stream)
        sysSource.connect(mixingDestination)
      }

      // 组装最终流
      const finalStream = new MediaStream([
        ...stream.getVideoTracks(),
        ...mixingDestination.stream.getAudioTracks(),
      ])

      localScreenShareFinalStream.value = finalStream
      localUser.screenStreamId = finalStream.id
      socket.value?.emit('update-status', {
        roomId,
        status: {
          isScreenSharing: true,
          screenStreamId: finalStream.id,
        },
      })

      // 添加到 Peers
      peers.forEach((pc, targetId) => {
        finalStream.getTracks().forEach((track) => {
          if (track.kind === 'audio' && isPeerAudioTrackOverridden(targetId)) return
          const sender = pc.addTrack(track, finalStream)
          if (track.kind === 'video') {
            optimizeScreenSender(sender)
          }
        })
        // addTrack 会触发 onnegotiationneeded，前提是我们在 createPeerConnection 中设置了监听
      })

      stream.getVideoTracks()[0]!.onended = () => {
        stopScreenShare()
        if (mixingAudioContext) {
          // mixingAudioContext.close() // Do not close shared context
          mixingAudioContext = null
        }
      }
    } catch (e) {
      console.error('Screen share failed:', e)
    }
  }

  const stopScreenShare = () => {
    if (localScreenStream.value) {
      const tracks = localScreenStream.value.getTracks()
      tracks.forEach((track) => track.stop())

      // 停止混音流的 tracks
      if (localScreenShareFinalStream.value) {
        localScreenShareFinalStream.value.getTracks().forEach((t) => t.stop())
      }

      // 移除 Sender
      peers.forEach((pc) => {
        const senders = pc.getSenders()
        localScreenShareFinalStream.value?.getTracks().forEach((track) => {
          const sender = senders.find((s) => s.track === track)
          if (sender) {
            pc.removeTrack(sender)
          }
        })
      })

      localScreenStream.value = null
      localScreenShareFinalStream.value = null
      localUser.isScreenSharing = false
      localUser.screenStreamId = undefined
      socket.value?.emit('update-status', {
        roomId,
        status: {
          isScreenSharing: false,
          screenStreamId: undefined,
        },
      })

      // 清理混音器
      if (mixingAudioContext) {
        // mixingAudioContext.close()
        mixingAudioContext = null
        mixingDestination = null
        if (micSourceNode) {
          try {
            micSourceNode.disconnect()
          } catch (e) {
            console.warn(e)
          }
          micSourceNode = null
        }
      }

      // 恢复麦克风独立发送 (如果开着)
      if (localUser.micOpen && localStream.value) {
        const audioTrack = localStream.value.getAudioTracks()[0]
        if (audioTrack && audioTrack.readyState === 'live') {
          peers.forEach((pc, targetId) => {
            if (isPeerAudioTrackOverridden(targetId)) return
            pc.addTrack(audioTrack, originLocalStream)
          })
        }
      }
    }
  }

  const sendMessage = (content: string) => {
    socket.value?.emit('chat-message', { roomId, message: content })
  }

  // 說話檢測
  let audioContext: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let animationId: number | null = null
  let speakTimeout: ReturnType<typeof setTimeout> | null = null

  const startSpeakingDetection = (stream: MediaStream) => {
    try {
      // Use shared context
      audioContext = getSharedAudioContext()

      source = audioContext.createMediaStreamSource(stream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const checkAudio = () => {
        if (!analyser || !localUser.micOpen) {
          // 如果关闭了，重置 level
          if ((localUser.audioLevel || 0) !== 0) {
            localUser.audioLevel = 0
          }
          if (localUser.micOpen) {
            // 只有在开启状态下才继续循环，否则停止
            animationId = requestAnimationFrame(checkAudio)
          }
          return
        }

        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i]!
        }
        const average = sum / dataArray.length

        localUser.audioLevel = average

        if (average > 10) {
          if (!localUser.isSpeaking) {
            localUser.isSpeaking = true
            socket.value?.emit('update-status', { roomId, status: { isSpeaking: true } })
          }
          if (speakTimeout) clearTimeout(speakTimeout)
          speakTimeout = setTimeout(() => {
            localUser.isSpeaking = false
            socket.value?.emit('update-status', { roomId, status: { isSpeaking: false } })
          }, 1000)
        }

        animationId = requestAnimationFrame(checkAudio)
      }

      checkAudio()
    } catch (e) {
      console.error('Audio context init failed:', e)
    }
  }

  const stopSpeakingDetection = () => {
    if (animationId) {
      cancelAnimationFrame(animationId)
      animationId = null
    }
    if (speakTimeout) {
      clearTimeout(speakTimeout)
      speakTimeout = null
    }

    if (source) {
      try {
        source.disconnect()
      } catch (e) {
        console.warn(e)
      }
      source = null
    }
    if (analyser) {
      try {
        analyser.disconnect()
      } catch (e) {
        console.warn(e)
      }
      analyser = null
    }
    // Do not close shared context
    audioContext = null

    localUser.audioLevel = 0
    // localUser.isSpeaking = false
    // 如果之前是正在说话状态，需要通知远端停止
    if (localUser.isSpeaking) {
      localUser.isSpeaking = false
      socket.value?.emit('update-status', { roomId, status: { isSpeaking: false } })
    }
  }

  const cleanup = () => {
    stopSpeakingDetection()

    peerNegotiations.forEach((_, targetId) => clearPeerRecoveryTimer(targetId))

    localStream.value?.getTracks().forEach((t) => t.stop())
    localScreenStream.value?.getTracks().forEach((t) => t.stop())
    localScreenShareFinalStream.value?.getTracks().forEach((t) => t.stop())

    peers.forEach((pc) => {
      try {
        pc.close()
      } catch (e) {
        console.warn('[WebRTC] 关闭 PeerConnection 失败:', e)
      }
    })
    peers.clear()
    peerNegotiations.clear()
    pendingCandidates.clear()
    peerMicrophoneSenders.clear()
    peerAudioTrackOverrides.clear()

    // 主动离开：立即通知服务端移除自己，不占用重连宽限期，
    // 同时清掉稳定 ID，下次进入同一房间视为新用户
    if (socket.value?.connected) {
      socket.value.emit('leave-room', { roomId })
    }
    clearStableUserId(roomId)

    socket.value?.disconnect()
  }

  onUnmounted(cleanup)

  return {
    localUser,
    users,
    peers,
    signalingConnected,
    isReconnecting,
    onPeerSessionChanged,
    onPeerRemoved,
    onSignalingLost,
    onSignalingRestored,
    reservePeerAudioTrackOverride,
    setPeerAudioTrackOverride,
    clearPeerAudioTrackOverride,
    localStream,
    localScreenStream,
    socket,
    init,
    toggleMic,
    toggleCam,
    switchCamera,
    startScreenShare,
    stopScreenShare,
    sendMessage,
    cleanup,
  }
}
