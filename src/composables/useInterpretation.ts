import { reactive, toRaw, watch, type ShallowRef } from 'vue'
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
  // 转录文本
  inputTranscript: string
  outputTranscript: string
}

export interface InterpretationState {
  activeSessions: Map<string, InterpretationSession>
  receivingFrom: Set<string>
  receivedTranscripts: Map<string, { inputText: string; outputText: string }>
  errorMessage: string
}

export interface PeerAudioTrackController {
  reservePeerAudioTrackOverride: (targetId: string) => void
  setPeerAudioTrackOverride: (
    targetId: string,
    track: MediaStreamTrack,
  ) => Promise<RTCRtpSender | null>
  clearPeerAudioTrackOverride: (targetId: string) => Promise<void>
}

const WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'
const TRANSLATION_OUTPUT_GAIN = 1.0 //确定不是音量的问题,但去掉太麻烦了,先留着这个控制项
const TRANSLATION_SAMPLE_RATE = 24000
const TRANSLATION_AUDIO_BITRATE = 24000
const TRANSLATION_BUFFER_SECONDS = 0.45
const CAPTURE_WORKLET_NAME = 'interpretation-pcm-capture'
const CAPTION_MAX_LENGTH = 32
const CAPTION_HIDE_DELAY_MS = 4000
const captureWorkletModuleLoads = new WeakMap<BaseAudioContext, Promise<void>>()

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
  audioTrackController: PeerAudioTrackController,
) {
  const state = reactive<InterpretationState>({
    activeSessions: new Map(),
    receivingFrom: new Set(),
    receivedTranscripts: new Map(),
    errorMessage: '',
  })

  const mutedByInterpretation = reactive<Set<string>>(new Set())
  const myVoiceMutedFor = reactive<Set<string>>(new Set())
  const audioReadyFrom = new Set<string>()
  const outgoingCaptionTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const receivedCaptionTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

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
        socket.value?.emit('interpretation-transcript', {
          targetId: session.targetUserId,
          inputText: '',
          outputText: '',
        })
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

  // ====== 音频静音控制 ======
  const muteRemoteUserAudio = (userId: string) => {
    if (audioReadyFrom.has(userId)) return

    const user = users.get(userId)
    if (user?.stream) {
      user.stream.getAudioTracks().forEach((track) => {
        track.enabled = false
      })
    }
  }

  const unmuteRemoteUserAudio = (userId: string) => {
    const user = users.get(userId)
    if (user?.stream) {
      user.stream.getAudioTracks().forEach((track) => {
        track.enabled = true
      })
    }
  }

  // ====== 临时令牌 ======
  const getEphemeralToken = async (targetLanguage: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!socket.value) {
        reject(new Error('Socket not connected'))
        return
      }
      socket.value.emit(
        'request-gemini-token',
        { targetLanguage },
        (response: { token?: string; expiresAt?: string; error?: string }) => {
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

  // ====== 创建翻译音频输出流 ======
  // 创建一个持续输出的 MediaStream，翻译音频片段到达时通过 BufferSource 播放到 destination
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

    // 短暂预缓冲可吸收 Gemini WebSocket 分片到达时间的波动。
    let nextTime = 0
    let isBuffering = true
    let bufferingStartedAt = ctx.currentTime
    const drainBuffer = () => {
      if (!session.outputAudioContext || session.outputAudioContext.state === 'closed') return

      const now = ctx.currentTime
      if (nextTime <= now && !isBuffering) {
        nextTime = 0
        isBuffering = true
        bufferingStartedAt = now
      }

      if (isBuffering) {
        const queuedSeconds =
          session.outputBuffer.reduce((samples, chunk) => samples + chunk.length, 0) /
          TRANSLATION_SAMPLE_RATE
        if (queuedSeconds === 0) {
          bufferingStartedAt = now
          requestAnimationFrame(drainBuffer)
          return
        }
        if (
          queuedSeconds < TRANSLATION_BUFFER_SECONDS &&
          now - bufferingStartedAt < TRANSLATION_BUFFER_SECONDS
        ) {
          requestAnimationFrame(drainBuffer)
          return
        }
        nextTime = now
        isBuffering = false
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

      requestAnimationFrame(drainBuffer)
    }
    requestAnimationFrame(drainBuffer)

    return dest.stream
  }

  const limitTranslationAudioBitrate = async (sender: RTCRtpSender) => {
    try {
      const parameters = sender.getParameters()
      if (!parameters.encodings?.length) {
        console.warn('[Interpretation] Audio sender has no configurable encoding')
        return
      }

      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = TRANSLATION_AUDIO_BITRATE
      }
      await sender.setParameters(parameters)
      console.log(`[Interpretation] Audio bitrate limited to ${TRANSLATION_AUDIO_BITRATE} bps`)
    } catch (error) {
      console.warn('[Interpretation] Failed to limit audio bitrate:', error)
    }
  }

  // ====== 替换 WebRTC 音频轨道 ======
  // 将 PeerConnection 中发给目标用户的音频轨道替换为翻译输出流
  const replaceAudioTrackForPeer = async (targetUserId: string, newTrack: MediaStreamTrack) => {
    try {
      newTrack.contentHint = 'speech'
      const audioSender = await audioTrackController.setPeerAudioTrackOverride(
        targetUserId,
        newTrack,
      )
      if (!audioSender) {
        console.warn('[Interpretation] No peer connection for', targetUserId)
        return false
      }
      await limitTranslationAudioBitrate(audioSender)
      console.log('[Interpretation] Replaced audio track for peer:', targetUserId)
      return true
    } catch (error) {
      console.error('[Interpretation] Failed to replace audio track:', error)
      return false
    }
  }

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

    const session: InterpretationSession = {
      targetUserId,
      targetLanguage: peerLanguage,
      ws: null,
      isConnected: false,
      isConnecting: true,
      sessionError: '',
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
      inputTranscript: '',
      outputTranscript: '',
    }

    state.activeSessions.set(targetUserId, session)

    try {
      const token = await getEphemeralToken(peerLanguage)

      const wsUrl = `${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`
      const ws = new WebSocket(wsUrl)
      session.ws = ws

      ws.onopen = () => {
        const setupMsg = {
          setup: {
            model: 'models/gemini-3.5-live-translate-preview',
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            generationConfig: {
              responseModalities: ['AUDIO'],
              translationConfig: {
                targetLanguageCode: peerLanguage,
                echoTargetLanguage: false,
              },
            },
          },
        }
        ws.send(JSON.stringify(setupMsg))
      }

      ws.onmessage = (event) => handleGeminiMessage(session, event)

      ws.onerror = (err) => {
        console.error('[Interpretation] Gemini WS error:', err)
        session.sessionError = 'Gemini 同传连接异常，请检查服务端网络后重试'
        state.errorMessage = session.sessionError
        stopInterpretation(targetUserId)
      }

      ws.onclose = (ev) => {
        console.log(
          `[Interpretation] Gemini WS closed: ${targetUserId}, code: ${ev.code}, reason: ${ev.reason}`,
        )
        session.isConnected = false
        session.isConnecting = false
        if (ev.code !== 1000 && ev.code !== 1005) {
          session.sessionError = `Gemini 同传连接已关闭（${ev.code}${ev.reason ? `: ${ev.reason}` : ''}）`
          state.errorMessage = session.sessionError
        }
      }

      // 通知对方启动同传
      socket.value?.emit('interpretation-request', {
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
        session.isConnected = true
        session.isConnecting = false

        // 创建输出音频流并替换 WebRTC 轨道
        const outputStream = createOutputAudioStream(session)
        const outputTrack = outputStream.getAudioTracks()[0]
        if (outputTrack) {
          void replaceAudioTrackForPeer(session.targetUserId, outputTrack).then((replaced) => {
            if (replaced) {
              socket.value?.emit('interpretation-audio-ready', {
                targetId: session.targetUserId,
              })
            }
          })
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
          socket.value?.emit('interpretation-transcript', {
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
            }
          }
        }
      }
    } catch (e) {
      console.error('[Interpretation] Parse error:', e)
    }
  }

  // ====== 麦克风采集 → Gemini ======
  const disconnectAudioCapture = (session: InterpretationSession, signalStreamEnd = true) => {
    if (
      signalStreamEnd &&
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

    const targetSampleRate = 16000
    const sourceSampleRate = audioContext.sampleRate

    processorNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN || !session.isConnected) return

      const inputData = event.data
      if (!(inputData instanceof Float32Array) || inputData.length === 0) return

      // 静音检测
      let sumSquares = 0
      for (let i = 0; i < inputData.length; i++) {
        sumSquares += inputData[i]! * inputData[i]!
      }
      if (Math.sqrt(sumSquares / inputData.length) < 0.001) return

      const resampledData = resample(inputData, sourceSampleRate, targetSampleRate)
      const pcmData = float32ToInt16(resampledData)
      const base64Audio = arrayBufferToBase64(pcmData.buffer)

      session.ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64Audio }],
          },
        }),
      )
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
  const stopInterpretation = async (targetUserId: string) => {
    const session = state.activeSessions.get(targetUserId)
    state.activeSessions.delete(targetUserId)
    clearInterpretationStateForUser(targetUserId)

    if (session) {
      await audioTrackController.clearPeerAudioTrackOverride(targetUserId)

      // 清理采集
      disconnectAudioCapture(session, false)

      // 清理输出
      if (session.outputGainNode) session.outputGainNode.disconnect()
      session.outputStream?.getTracks().forEach((track) => track.stop())
      session.outputAudioContext = null
      session.outputBuffer = []

      // 关闭 Gemini WS
      if (session.ws) session.ws.close()
    }

    socket.value?.emit('interpretation-stop', { targetId: targetUserId })
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
            const session: InterpretationSession = {
              targetUserId: requesterId,
              targetLanguage,
              ws: null,
              isConnected: false,
              isConnecting: true,
              sessionError: '',
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
              inputTranscript: '',
              outputTranscript: '',
            }
            state.activeSessions.set(requesterId, session)
            audioTrackController.reservePeerAudioTrackOverride(requesterId)

            const token = await getEphemeralToken(targetLanguage)
            const wsUrl = `${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`
            const ws = new WebSocket(wsUrl)
            session.ws = ws

            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  setup: {
                    model: 'models/gemini-3.5-live-translate-preview',
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    generationConfig: {
                      responseModalities: ['AUDIO'],
                      translationConfig: {
                        targetLanguageCode: targetLanguage,
                        echoTargetLanguage: false,
                      },
                    },
                  },
                }),
              )
            }

            ws.onmessage = (event) => handleGeminiMessage(session, event)
            ws.onerror = () => {
              session.sessionError = 'Gemini 同传连接异常，请检查服务端网络后重试'
              state.errorMessage = session.sessionError
              stopInterpretation(requesterId)
            }
            ws.onclose = (event) => {
              session.isConnected = false
              session.isConnecting = false
              if (event.code !== 1000 && event.code !== 1005) {
                session.sessionError = `Gemini 同传连接已关闭（${event.code}${event.reason ? `: ${event.reason}` : ''}）`
                state.errorMessage = session.sessionError
              }
            }

            myVoiceMutedFor.add(requesterId)
          } catch (e) {
            console.error('[Interpretation] Auto-start failed:', e)
            state.errorMessage = e instanceof Error ? e.message : String(e)
            state.activeSessions.delete(requesterId)
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
      unmuteRemoteUserAudio(senderId)
      console.log(`[Interpretation] Translation audio ready from ${senderId}`)
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

    s.on('interpretation-stop', async ({ senderId }: { senderId: string }) => {
      clearInterpretationStateForUser(senderId)

      if (state.activeSessions.has(senderId)) {
        const session = state.activeSessions.get(senderId)!
        await audioTrackController.clearPeerAudioTrackOverride(senderId)
        disconnectAudioCapture(session)
        if (session.outputGainNode) session.outputGainNode.disconnect()
        session.outputStream?.getTracks().forEach((track) => track.stop())
        session.outputAudioContext = null
        if (session.ws) session.ws.close()
        state.activeSessions.delete(senderId)
      }
    })
  }

  const isUserMutedByInterpretation = (userId: string) => mutedByInterpretation.has(userId)
  const isInterpretingFor = (userId: string) => state.activeSessions.has(userId)

  const stopAll = () => {
    for (const userId of [...state.activeSessions.keys()]) {
      void stopInterpretation(userId)
    }
    for (const userId of [...mutedByInterpretation]) {
      unmuteRemoteUserAudio(userId)
    }
    state.receivingFrom.clear()
    state.receivedTranscripts.clear()
    for (const timeout of outgoingCaptionTimeouts.values()) clearTimeout(timeout)
    for (const timeout of receivedCaptionTimeouts.values()) clearTimeout(timeout)
    outgoingCaptionTimeouts.clear()
    receivedCaptionTimeouts.clear()
    mutedByInterpretation.clear()
    myVoiceMutedFor.clear()
    audioReadyFrom.clear()
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

  // 重新应用所有同传静音（当远端用户流变化时调用）
  const reapplyMutes = () => {
    for (const userId of mutedByInterpretation) {
      muteRemoteUserAudio(userId)
    }
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
    stopAll,
  }
}
