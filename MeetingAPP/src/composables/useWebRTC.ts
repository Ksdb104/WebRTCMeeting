import { ref, reactive, shallowRef, onUnmounted } from 'vue'
import { io, Socket } from 'socket.io-client'
import { getSharedAudioContext } from '@/utils/globalAudio'
import { useDeviceStore } from '@/stores/device'
import 'webrtc-adapter'

// Dynamic import for Tauri to avoid breaking web build
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tauriInvoke: any = null
import('@tauri-apps/api/core')
  .then((mod) => {
    tauriInvoke = mod.invoke
  })
  .catch(() => {
    console.log('Not in Tauri environment')
  })

export interface User {
  id: string
  name: string
  joinTime: number
  micOpen: boolean
  camOpen: boolean
  isScreenSharing: boolean
  connected: boolean // WebRTC 连接状态
  stream?: MediaStream // 摄像头流
  screenStream?: MediaStream // 屏幕共享流
  audioLevel?: number
  isSpeaking?: boolean
  camStreamId?: string
  screenStreamId?: string
  isDesktop?: boolean
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' }, // Cloudflare STUN（更稳定）
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  bundlePolicy: 'max-bundle',
  // rtcpMuxPolicy: 'require',
}

export function useWebRTC(roomId: string, userName: string) {
  const socket = shallowRef<Socket | null>(null)
  // 保持 WebRTC 传输用的 Stream ID 不变，避免 renegotiation 时被识别为新流
  const originLocalStream = new MediaStream()

  const localUser = reactive<User>({
    id: '',
    name: userName,
    joinTime: Date.now(),
    micOpen: false,
    camOpen: false,
    isScreenSharing: false,
    isSpeaking: false,
    audioLevel: 0,
    connected: true,
    camStreamId: originLocalStream.id,
    isDesktop: false,
  })

  // Detect Tauri environment
  import('@tauri-apps/api/core')
    .then(() => {
      localUser.isDesktop = true
      if (socket.value) {
        socket.value.emit('update-status', { roomId, status: { isDesktop: true } })
      }
    })
    .catch(() => {})

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
  const controlChannels = new Map<string, RTCDataChannel>()
  const controlMotionChannels = new Map<string, RTCDataChannel>()
  const controllingUserId = ref<string | null>(null)
  const wsURL = import.meta.env.VITE_WS_URL

  // 初始化
  const init = async () => {
    // 1. 不再自动获取媒体流，默认 micOpen/camOpen 都是 false
    // 2. WebSocket 连接
    socket.value = io(wsURL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    })

    socket.value.on('connect', () => {
      console.log('Socket connected, joining room...')
      localUser.id = socket.value!.id!
      socket.value!.emit('join-room', { roomId, userName })
      // 同步初始 ID 信息
      socket.value!.emit('update-status', {
        roomId,
        status: { camStreamId: localUser.camStreamId, isDesktop: localUser.isDesktop },
      })
    })

    // 3. 处理信令
    socket.value.on('room-users', (userList: User[]) => {
      // 初始化已存在的用戶
      userList.forEach((u) => {
        if (u.id !== localUser.id) {
          addUser(u)
        }
      })
    })

    socket.value.on('user-joined', (newUser: User) => {
      console.log('User joined:', newUser)
      addUser(newUser)
      createPeerConnection(newUser.id, true)
    })

    socket.value.on('user-left', (userId: string) => {
      if (controllingUserId.value === userId) {
        controllingUserId.value = null
      }
      removeUser(userId)
    })

    socket.value.on('offer', async ({ sdp, sender }) => {
      await handleOffer(sender, sdp)
    })

    socket.value.on('answer', async ({ sdp, sender }) => {
      await handleAnswer(sender, sdp)
    })

    socket.value.on('ice-candidate', async ({ candidate, sender }) => {
      await handleCandidate(sender, candidate)
    })

    socket.value.on('request-control', ({ requesterId }) => {
      const requester = users.get(requesterId)
      const accept = confirm(`${requester?.name || 'User'} 要求远程协助，是否同意？`)
      if (accept) {
        socket.value?.emit('accept-control', { roomId, requesterId })
        startScreenShare().then(() => {
          // 接受远程协助后自动最小化窗口
          import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => {
              console.log(getCurrentWindow())
              getCurrentWindow().minimize()
            })
            .catch(() => {
              // ignore if not in tauri
            })
        }) // Auto start screen share
      } else {
        socket.value?.emit('reject-control', { roomId, requesterId })
      }
    })

    socket.value.on('accept-control', ({ accepterId }) => {
      // console.log(`Control accepted by ${accepterId}`)
      controllingUserId.value = accepterId
      // alert('Remote control accepted. You can now control the remote screen.')
    })

    socket.value.on('reject-control', () => {
      alert('远程协助被拒绝')
      controllingUserId.value = null
    })

    socket.value.on('user-update', (data: Partial<User> & { id: string }) => {
      // 如果被控端停止共享屏幕，自动结束控制
      if (data.id === controllingUserId.value && data.isScreenSharing === false) {
        controllingUserId.value = null
      }

      const user = users.get(data.id)
      if (user) {
        Object.assign(user, data)

        reorganizeStreams(user)

        // 根据状态强制清洗媒体流，保证UI更新
        if (data.camOpen === false && user.stream) {
          // 只清理视频轨道，保留音频轨道（因为可能开着麦克风）
          user.stream.getVideoTracks().forEach((t) => t.stop())
          // 只有当没有活跃轨道时才置空
          if (!user.stream.getTracks().some((t) => t.readyState === 'live')) {
            user.stream = undefined
          }
        }
        // 修复说话状态残留: 如果对方关闭麦克风，强制重置说话状态
        if (data.micOpen === false) {
          user.isSpeaking = false
          user.audioLevel = 0
        }
        if (data.isScreenSharing === false && user.screenStream) {
          user.screenStream.getTracks().forEach((t) => t.stop())
          user.screenStream = undefined
        }
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

  const addUser = (userData: User) => {
    if (!users.has(userData.id)) {
      users.set(userData.id, {
        ...userData,
        connected: false,
        stream: undefined,
        screenStream: undefined,
      })
    }
  }

  const removeUser = (userId: string) => {
    users.delete(userId)
    const pc = peers.get(userId)
    if (pc) {
      pc.close()
      peers.delete(userId)
    }
  }

  const createPeerConnection = async (targetId: string, isInitiator: boolean) => {
    if (peers.has(targetId)) return peers.get(targetId)

    const pc = new RTCPeerConnection(ICE_SERVERS)
    peers.set(targetId, pc)

    // 创建 DataChannel 以确保即使没有音视频流也能建立连接
    if (isInitiator) {
      pc.createDataChannel('keepalive')
      const controlChannel = pc.createDataChannel('control') // Create control channel
      controlChannels.set(targetId, controlChannel)
      setupControlChannel(controlChannel) // 确保发起方也能接收远端控制指令（双向控制）

      // 创建不可靠/无序通道用于鼠标移动 (低延迟)
      const motionChannel = pc.createDataChannel('control-motion', {
        ordered: false,
        maxRetransmits: 0,
      })
      controlMotionChannels.set(targetId, motionChannel)
      setupControlChannel(motionChannel)
    }

    pc.ondatachannel = (event) => {
      if (event.channel.label === 'control') {
        controlChannels.set(targetId, event.channel)
        setupControlChannel(event.channel)
      } else if (event.channel.label === 'control-motion') {
        controlMotionChannels.set(targetId, event.channel)
        setupControlChannel(event.channel)
      }
    }

    // 添加本地流 (如果已有轨道)
    // 使用 originLocalStream 确保 Stream ID 一致
    originLocalStream.getTracks().forEach((track) => {
      pc.addTrack(track, originLocalStream)
    })

    // 如果正在屏幕共享，也添加屏幕流
    if (localScreenStream.value) {
      localScreenStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localScreenStream.value!)
      })
    }

    // 监听协商事件 (处理动态添加/移除轨道)
    pc.onnegotiationneeded = async () => {
      try {
        // 避免在非稳定状态下进行协商
        if (pc.signalingState !== 'stable') return
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        socket.value?.emit('offer', {
          target: targetId,
          sdp: offer,
        })
      } catch (e) {
        console.error('Negotiation failed:', e)
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

    // 监听 ICE 连接状态，自动重启 ICE
    pc.oniceconnectionstatechange = async () => {
      console.log(`ICE connection state change for ${targetId}: ${pc.iceConnectionState}`)
      if (pc.iceConnectionState === 'failed') {
        console.log('ICE failed, attempting restart...')
        // 只有发起者尝试重启，避免冲突
        if (isInitiator) {
          try {
            // 确保在 stable 状态下才能进行重启操作，或者至少尝试
            if (pc.signalingState !== 'stable') {
              console.warn('Signaling state is not stable, postponing ICE restart')
              return
            }
            const offer = await pc.createOffer({ iceRestart: true })
            await pc.setLocalDescription(offer)
            socket.value?.emit('offer', {
              target: targetId,
              sdp: offer,
            })
          } catch (e) {
            console.error('ICE restart failed:', e)
          }
        }
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
      const user = users.get(targetId)
      if (user) {
        user.connected = pc.connectionState === 'connected'
      }
    }

    if (isInitiator) {
      // 移除手动创建 Offer，完全依赖 onnegotiationneeded
      // pc.createDataChannel 在上面已经调用，会触发 onnegotiationneeded
    }

    return pc
  }

  const handleOffer = async (senderId: string, sdp: RTCSessionDescriptionInit) => {
    const pc = await createPeerConnection(senderId, false)
    if (!pc) return

    await pc.setRemoteDescription(new RTCSessionDescription(sdp))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    socket.value?.emit('answer', {
      target: senderId,
      sdp: answer,
    })
  }

  const handleAnswer = async (senderId: string, sdp: RTCSessionDescriptionInit) => {
    const pc = peers.get(senderId)
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
    }
  }

  const handleCandidate = async (senderId: string, candidate: RTCIceCandidateInit) => {
    const pc = peers.get(senderId)
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate))
    }
  }

  // 开关麦克风
  const toggleMic = async () => {
    if (!localStream.value) return

    if (localUser.micOpen) {
      // 关闭：停止轨道并销毁
      const audioTrack = localStream.value.getAudioTracks()[0]
      if (audioTrack) {
        // 先移除 Sender，避免 track.stop() 后找不到 sender
        // 如果在混音中，断开连接
        if (localUser.isScreenSharing && micSourceNode) {
          micSourceNode.disconnect()
          micSourceNode = null
        } else {
          // 只有不在屏幕共享模式下，才去移除 PC 里的 Sender
          // 因为屏幕共享模式下，Audio Track 是混音后的（包含系统音频），不能移除
          peers.forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track === audioTrack)
            if (sender) {
              pc.removeTrack(sender)
            }
          })
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
            peers.forEach((pc) => {
              pc.addTrack(audioTrack, originLocalStream)
            })
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
        video: true,
        audio: true,
      })
      localScreenStream.value = stream
      localUser.isScreenSharing = true
      // socket.value?.emit('update-status', { roomId, status: { isScreenSharing: true } }) // 延迟到后面带 ID 发送

      // 混音逻辑
      mixingAudioContext = getSharedAudioContext()
      if (!mixingAudioContext) return
      mixingDestination = mixingAudioContext.createMediaStreamDestination()

      // 麦克风接入 (如果有)
      if (localStream.value.getAudioTracks().length > 0) {
        const audioTrack = localStream.value.getAudioTracks()[0]
        if (audioTrack) {
          // 移除独立发送器，转为混音发送
          peers.forEach((pc) => {
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
      peers.forEach((pc) => {
        finalStream.getTracks().forEach((track) => {
          pc.addTrack(track, finalStream)
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
          peers.forEach((pc) => {
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
      if (!audioContext) return

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

  const setupControlChannel = (channel: RTCDataChannel) => {
    channel.onmessage = (event) => {
      if (!localUser.isDesktop || !tauriInvoke) return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'mouse') {
          tauriInvoke('control_mouse', {
            action: data.action,
            x: data.x,
            y: data.y,
            button: data.button,
          })
        } else if (data.type === 'keyboard') {
          tauriInvoke('control_keyboard', {
            key: data.key,
            keyState: data.keyState || 'click',
          })
        }
      } catch (e) {
        console.error('Failed to process control message', e)
      }
    }
  }

  const requestControl = (targetId: string) => {
    socket.value?.emit('request-control', { roomId, targetId })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendControlEvent = (targetId: string, event: any) => {
    let channel: RTCDataChannel | undefined

    // 鼠标移动或滚动使用低延迟通道
    if (event.type === 'mouse' && (event.action === 'move' || event.action === 'scroll')) {
      channel = controlMotionChannels.get(targetId)
    }

    // 兜底或普通事件使用可靠通道
    if (!channel || channel.readyState !== 'open') {
      channel = controlChannels.get(targetId)
    }

    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify(event))
    }
  }

  const stopControl = () => {
    controllingUserId.value = null
  }

  const cleanup = () => {
    stopSpeakingDetection()
    localStream.value?.getTracks().forEach((t) => t.stop())
    localScreenStream.value?.getTracks().forEach((t) => t.stop())
    peers.forEach((pc) => pc.close())
    controlChannels.clear()
    controlMotionChannels.clear()
    socket.value?.disconnect()
  }

  onUnmounted(cleanup)

  return {
    localUser,
    users,
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
    requestControl,
    stopControl,
    controllingUserId,
    sendControlEvent,
    peers,
  }
}
