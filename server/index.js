import express from 'express'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import { GoogleGenAI } from '@google/genai'

// 加载 .env 文件（简单实现，无需额外依赖）
const __dirname = dirname(fileURLToPath(import.meta.url))
try {
  const envPath = resolve(__dirname, '..', '.env.server')
  const envContent = readFileSync(envPath, 'utf-8')
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=')
      const value = valueParts.join('=').replace(/^['"]|['"]$/g, '')
      if (key && !process.env[key]) {
        process.env[key] = value
      }
    }
  })
} catch {
  // .env.server 文件不存在，跳过
}

const app = express()
app.use(express.json())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // 默认 pingInterval 25s + pingTimeout 20s，意味着网络被拔掉后
  // 最长要 45 秒服务端才会发现连接已死、才会广播 user-offline。
  // 收紧到 10s + 10s，掉线检测缩短到 ~20 秒，客户端也会同步用这套心跳参数
  pingInterval: 10000,
  pingTimeout: 10000,
})

// ====== Gemini SDK ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
let genaiClient = null
if (GEMINI_API_KEY) {
  genaiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } })
  console.log('Gemini SDK initialized')
} else {
  console.warn('GEMINI_API_KEY not configured, interpretation will not work')
}

function getErrorDetails(error) {
  const details = []
  let current = error
  while (current && details.length < 3) {
    const message = current.message || String(current)
    if (message && !details.includes(message)) details.push(message)
    current = current.cause
  }
  return details.join(': ')
}

// 房间列表
// key: roomId, value: Map<userId, UserInfo>
// 注意：这里的 key 是客户端生成的「稳定 userId」，而不是 socket.id。
// socket.id 每次重连都会变，用它做身份会导致重连后被当成新用户，
// 对端已建立的 PeerConnection 无法复用、状态也全部丢失。
const rooms = new Map()

// UserInfo 结构
// {
//   id: string,        // 稳定 userId（客户端生成，重连保持不变）
//   socketId: string,  // 当前连接的 socket.id，仅服务端内部用于路由
//   sessionId: string, // 每次页面加载都会变，对端据此立刻判定旧 PeerConnection 已失效
//   name: string,
//   joinTime: number,
//   online: boolean,   // 信令是否在线（宽限期内断线时为 false）
//   isSpeaking: boolean,
//   audioLevel: number,
//   micOpen: boolean,
//   camOpen: boolean,
//   isScreenSharing: boolean,
//   camStreamId: string,
//   screenStreamId: string,
// }

// 断线重连宽限期：网络抖动 / 页面刷新时不立即把用户移出房间，
// 期间同一个 userId 重新加入即视为重连，保留其状态与房间位置。
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 20000)

// key: `${roomId}::${userId}` -> Timeout，宽限期内待移除的用户
const pendingRemovals = new Map()

// 允许客户端通过 update-status / join-room 覆盖的字段白名单，
// 防止客户端篡改 id、socketId、joinTime 等关键字段
const ALLOWED_STATUS_FIELDS = [
  'micOpen',
  'camOpen',
  'isScreenSharing',
  'isSpeaking',
  'audioLevel',
  'camStreamId',
  'screenStreamId',
]

function sanitizeStatus(status) {
  const result = {}
  if (!status || typeof status !== 'object') return result
  for (const field of ALLOWED_STATUS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(status, field)) {
      result[field] = status[field]
    }
  }
  // 停止共享时顺手清理屏幕流 ID，避免残留脏数据影响重连后的流分配
  if (result.isScreenSharing === false) result.screenStreamId = undefined
  return result
}

const removalKey = (roomId, userId) => `${roomId}::${userId}`

function cancelPendingRemoval(roomId, userId) {
  const key = removalKey(roomId, userId)
  const timer = pendingRemovals.get(key)
  if (timer) {
    clearTimeout(timer)
    pendingRemovals.delete(key)
  }
}

function getRoomUser(roomId, userId) {
  if (!roomId || !userId) return undefined
  const room = rooms.get(roomId)
  return room ? room.get(userId) : undefined
}

// 下发给客户端时去掉 socketId，客户端只认稳定 userId
function serializeUser(user) {
  const { socketId, ...rest } = user
  void socketId
  return rest
}

function roomUserList(room) {
  return Array.from(room.values())
    .sort((a, b) => a.joinTime - b.joinTime)
    .map(serializeUser)
}

// 按稳定 userId 定向发送（内部换算成当前 socket.id）
function emitToUser(roomId, targetUserId, event, payload) {
  const user = getRoomUser(roomId, targetUserId)
  if (!user || !user.socketId) return false
  io.to(user.socketId).emit(event, payload)
  return true
}

function removeUserFromRoom(roomId, userId) {
  cancelPendingRemoval(roomId, userId)
  const room = rooms.get(roomId)
  if (!room || !room.has(userId)) return
  room.delete(userId)
  io.to(roomId).emit('user-left', userId)
  console.log(`User ${userId} removed from room ${roomId}`)

  // 房间空了且没有待重连的成员时才销毁
  const hasPending = [...pendingRemovals.keys()].some((key) => key.startsWith(`${roomId}::`))
  if (room.size === 0 && !hasPending) {
    rooms.delete(roomId)
    console.log(`Room ${roomId} destroyed`)
  }
}

// 生成房间ID的辅助函数
function generateRoomId() {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXY'
  let result = ''
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// 获取唯一房间ID的API **已整合进websocket
// app.get('/api/create-room', (req, res) => {
//   let roomId = generateRoomId()
//   let attempts = 0
//   // 简单的防冲突重试机制
//   while (rooms.has(roomId) && attempts < 10) {
//     roomId = generateRoomId()
//     attempts++
//   }

//   if (rooms.has(roomId)) {
//     return res.status(503).json({ error: 'Failed to generate unique room ID' })
//   }

//   res.json({ roomId })
// })

io.on('connection', (socket) => {
  console.log('User connected:', socket.id)
  socket.emit('your-id', socket.id)

  // 创建房间
  socket.on('create-room', () => {
    try {
      // 之前这里用的是 const，一旦房间号冲突就会抛 TypeError
      let roomId = generateRoomId()

      // 简单的防冲突重试机制
      while (rooms.has(roomId)) {
        roomId = generateRoomId()
      }

      rooms.set(roomId, new Map())

      socket.emit('room-created', {
        status: true,
        roomId,
      })

      console.log(`房间创建成功: ${roomId}`)
    } catch (error) {
      socket.emit('room-created', {
        status: false,
        error: error.message,
      })
    }
  })

  socket.on('join-room', ({ roomId, userName, userId, sessionId, isDesktop, status }) => {
    if (!roomId) return

    // 老客户端没有传 userId 时退化为 socket.id（无重连能力，但不会报错）
    const stableUserId = userId || socket.id

    socket.join(roomId)
    socket.data.roomId = roomId
    socket.data.userId = stableUserId

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map())
    }
    const room = rooms.get(roomId)

    // 重连成功，取消待移除
    cancelPendingRemoval(roomId, stableUserId)

    const existing = room.get(stableUserId)

    if (existing) {
      // ====== 重连路径：保留身份、加入时间与既有状态 ======
      const previousSocketId = existing.socketId
      existing.socketId = socket.id
      existing.online = true
      // sessionId 变化 = 对方页面重新加载过，旧的 PeerConnection 必然已失效。
      // 下发给房间其他人后，他们无需等 ICE 超时即可立刻重建连接
      if (sessionId) existing.sessionId = sessionId
      if (userName) existing.name = userName
      if (isDesktop !== undefined) existing.isDesktop = !!isDesktop
      // 客户端上报的当前真实状态优先（重连后麦克风/摄像头可能仍是开着的）
      Object.assign(existing, sanitizeStatus(status))

      // 同一身份的旧连接如果还没断开（例如刷新时旧 socket 未及时关闭），主动踢掉
      if (previousSocketId && previousSocketId !== socket.id) {
        const staleSocket = io.sockets.sockets.get(previousSocketId)
        if (staleSocket) {
          // 清掉身份标记，避免旧 socket 的 disconnecting 把刚重连的用户又标记为离线
          staleSocket.data.userId = null
          staleSocket.data.roomId = null
          staleSocket.disconnect(true)
        }
      }

      socket.to(roomId).emit('user-rejoined', serializeUser(existing))
      socket.emit('room-users', roomUserList(room))

      console.log(`User ${existing.name} (${stableUserId}) rejoined room ${roomId}`)
      return
    }

    // ====== 首次加入 ======
    const newUser = {
      id: stableUserId,
      socketId: socket.id,
      sessionId: sessionId || socket.id,
      name: userName,
      joinTime: Date.now(),
      online: true,
      micOpen: false,
      camOpen: false,
      isScreenSharing: false,
      isDesktop: isDesktop || false,
      ...sanitizeStatus(status),
    }

    room.set(stableUserId, newUser)

    // 通知房间其他人有新用户加入
    socket.to(roomId).emit('user-joined', serializeUser(newUser))

    // 发送当前房间用户列表给新用户，按加入时间排序
    socket.emit('room-users', roomUserList(room))

    console.log(`User ${userName} (${stableUserId}) joined room ${roomId}`)
  })

  // 主动离开房间：立即移除，不占用重连宽限期
  socket.on('leave-room', () => {
    const roomId = socket.data.roomId
    const userId = socket.data.userId
    if (!roomId || !userId) return

    removeUserFromRoom(roomId, userId)
    socket.leave(roomId)
    socket.data.roomId = null
    socket.data.userId = null
  })

  // WebRTC 信令（target / sender 均为稳定 userId）
  socket.on('offer', (payload) => {
    emitToUser(socket.data.roomId, payload.target, 'offer', {
      sdp: payload.sdp,
      sender: socket.data.userId,
    })
  })

  socket.on('answer', (payload) => {
    emitToUser(socket.data.roomId, payload.target, 'answer', {
      sdp: payload.sdp,
      sender: socket.data.userId,
    })
  })

  socket.on('ice-candidate', (payload) => {
    emitToUser(socket.data.roomId, payload.target, 'ice-candidate', {
      candidate: payload.candidate,
      sender: socket.data.userId,
    })
  })

  // 请求对端销毁并重建与自己之间的 PeerConnection（断线重连 / ICE 彻底失败时使用）
  socket.on('peer-reset', (payload) => {
    emitToUser(socket.data.roomId, payload.target, 'peer-reset', {
      sender: socket.data.userId,
    })
  })

  // 状态更新（是否开启摄像头，麦克风等等）
  socket.on('update-status', ({ roomId, status }) => {
    const targetRoomId = roomId || socket.data.roomId
    const userId = socket.data.userId
    const user = getRoomUser(targetRoomId, userId)
    if (!user) return

    const patch = sanitizeStatus(status)
    Object.assign(user, patch)
    // 广播状态更新
    socket.to(targetRoomId).emit('user-update', { id: userId, ...patch })
  })

  // Remote Control Signaling
  socket.on('request-control', ({ targetId }) => {
    emitToUser(socket.data.roomId, targetId, 'request-control', {
      requesterId: socket.data.userId,
    })
  })

  socket.on('accept-control', ({ requesterId }) => {
    emitToUser(socket.data.roomId, requesterId, 'accept-control', {
      accepterId: socket.data.userId,
    })
  })

  socket.on('reject-control', ({ requesterId }) => {
    emitToUser(socket.data.roomId, requesterId, 'reject-control', {
      rejecterId: socket.data.userId,
    })
  })

  // ====== 同传信令 ======
  // 请求 Gemini 临时令牌（仅已连接用户可调用）
  socket.on('request-gemini-token', async ({ targetLanguage }, callback) => {
    if (!genaiClient) {
      console.error('Gemini SDK not initialized')
      callback({ error: 'Gemini not configured on server' })
      return
    }

    // 验证用户确实在某个房间内
    if (!socket.data.roomId || !getRoomUser(socket.data.roomId, socket.data.userId)) {
      callback({ error: 'Not in any room' })
      return
    }

    try {
      console.log(`Requesting Gemini token for language: ${targetLanguage}`)

      const now = new Date()
      const expireTime = new Date(now.getTime() + 30 * 60 * 1000)
      const newSessionExpireTime = new Date(now.getTime() + 2 * 60 * 1000)

      const token = await genaiClient.authTokens.create({
        config: {
          uses: 1,
          expireTime: expireTime.toISOString(),
          newSessionExpireTime: newSessionExpireTime.toISOString(),
          httpOptions: { apiVersion: 'v1alpha' },
        },
      })

      console.log('Gemini token created successfully')
      // token.name 格式为 "auth_tokens/xxx"，客户端需要完整值
      callback({ token: token.name, expiresAt: token.expireTime })
    } catch (error) {
      const errorDetails = getErrorDetails(error) || 'Unknown error'
      console.error('Failed to create Gemini ephemeral token:', errorDetails)
      callback({ error: `Token creation failed: ${errorDetails}` })
    }
  })

  // 发送方请求开启同传（通知目标用户）
  socket.on('interpretation-request', ({ targetId, targetLanguage }) => {
    emitToUser(socket.data.roomId, targetId, 'interpretation-request', {
      requesterId: socket.data.userId,
      targetLanguage,
    })
  })

  // 目标用户接受同传
  socket.on('interpretation-accept', ({ requesterId }) => {
    emitToUser(socket.data.roomId, requesterId, 'interpretation-accept', {
      accepterId: socket.data.userId,
    })
  })

  // 发送方完成译音轨道替换后，通知接收方启用远端音频轨道
  socket.on('interpretation-audio-ready', ({ targetId }) => {
    emitToUser(socket.data.roomId, targetId, 'interpretation-audio-ready', {
      senderId: socket.data.userId,
    })
  })

  // 任意一方关闭同传
  socket.on('interpretation-stop', ({ targetId }) => {
    emitToUser(socket.data.roomId, targetId, 'interpretation-stop', {
      senderId: socket.data.userId,
    })
  })

  // 重连后的同传状态对账：声明「我当前是否还在给你做同传」。
  // 掉线期间发给离线用户的事件会被直接丢弃，靠这个事件把双方状态重新对齐
  socket.on('interpretation-sync', ({ targetId, active }) => {
    emitToUser(socket.data.roomId, targetId, 'interpretation-sync', {
      senderId: socket.data.userId,
      active: !!active,
    })
  })

  // 转发同传转录文本（可选，用于字幕显示）
  socket.on('interpretation-transcript', ({ targetId, inputText, outputText }) => {
    emitToUser(socket.data.roomId, targetId, 'interpretation-transcript', {
      senderId: socket.data.userId,
      inputText,
      outputText,
    })
  })

  // 聊天消息
  socket.on('chat-message', ({ roomId, message, type = 'text', fileInfo }) => {
    const targetRoomId = roomId || socket.data.roomId
    if (!targetRoomId) return
    socket.to(targetRoomId).emit('chat-message', {
      senderId: socket.data.userId,
      message,
      type,
      fileInfo,
      timestamp: Date.now(),
    })
  })

  socket.on('disconnecting', () => {
    const roomId = socket.data.roomId
    const userId = socket.data.userId
    if (!roomId || !userId) return

    const user = getRoomUser(roomId, userId)
    // socketId 不一致说明该身份已被新连接接管（重连已完成），旧连接的断开不做处理
    if (!user || user.socketId !== socket.id) return

    user.online = false
    user.socketId = null

    // 先告知房间内其他人「该成员正在重连」，但不移除成员、也不销毁对端连接
    socket.to(roomId).emit('user-offline', { id: userId })

    cancelPendingRemoval(roomId, userId)
    const key = removalKey(roomId, userId)
    pendingRemovals.set(
      key,
      setTimeout(() => {
        pendingRemovals.delete(key)
        const current = getRoomUser(roomId, userId)
        // 宽限期内已经重连成功则不再移除
        if (!current || current.online) return
        removeUserFromRoom(roomId, userId)
      }, RECONNECT_GRACE_MS),
    )

    console.log(
      `User ${user.name} (${userId}) went offline in room ${roomId}, waiting ${RECONNECT_GRACE_MS}ms for reconnect`,
    )
  })

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id)
  })
})

const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
