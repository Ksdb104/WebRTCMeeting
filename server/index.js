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
// key: roomId, value: Map<socketId, UserInfo>
const rooms = new Map()

// UserInfo 结构
// {
//   id: string,
//   name: string,
//   joinTime: number,
//   isSpeaking: boolean,
//   audioLevel: number,
//   micOpen: boolean,
//   camOpen: boolean
// }

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
      const roomId = generateRoomId()

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

  socket.on('join-room', ({ roomId, userName, isDesktop }) => {
    socket.join(roomId)

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map())
    }

    const room = rooms.get(roomId)

    const newUser = {
      id: socket.id,
      name: userName,
      joinTime: Date.now(),
      micOpen: false,
      camOpen: false,
      isDesktop: isDesktop || false,
    }

    room.set(socket.id, newUser)

    // 通知房间其他人有新用户加入
    socket.to(roomId).emit('user-joined', newUser)

    // 发送当前房间用户列表给新用户，按加入时间排序
    const userList = Array.from(room.values()).sort((a, b) => a.joinTime - b.joinTime)
    socket.emit('room-users', userList)

    console.log(`User ${userName} (${socket.id}) joined room ${roomId}`)
  })

  // WebRTC 信令
  socket.on('offer', (payload) => {
    // payload: { target: targetSocketId, sdp: ..., type: ... }
    io.to(payload.target).emit('offer', {
      sdp: payload.sdp,
      sender: socket.id,
    })
  })

  socket.on('answer', (payload) => {
    io.to(payload.target).emit('answer', {
      sdp: payload.sdp,
      sender: socket.id,
    })
  })

  socket.on('ice-candidate', (payload) => {
    io.to(payload.target).emit('ice-candidate', {
      candidate: payload.candidate,
      sender: socket.id,
    })
  })

  // 状态更新（是否开启摄像头，麦克风等等）
  socket.on('update-status', ({ roomId, status }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)
      if (room.has(socket.id)) {
        const user = room.get(socket.id)
        Object.assign(user, status)
        // 广播状态更新
        socket.to(roomId).emit('user-update', { id: socket.id, ...status })
      }
    }
  })

  // Remote Control Signaling
  socket.on('request-control', ({ targetId }) => {
    io.to(targetId).emit('request-control', { requesterId: socket.id })
  })

  socket.on('accept-control', ({ requesterId }) => {
    io.to(requesterId).emit('accept-control', { accepterId: socket.id })
  })

  socket.on('reject-control', ({ requesterId }) => {
    io.to(requesterId).emit('reject-control', { rejecterId: socket.id })
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
    const userRooms = [...socket.rooms].filter((r) => r !== socket.id)
    if (userRooms.length === 0) {
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
    io.to(targetId).emit('interpretation-request', {
      requesterId: socket.id,
      targetLanguage,
    })
  })

  // 目标用户接受同传
  socket.on('interpretation-accept', ({ requesterId }) => {
    io.to(requesterId).emit('interpretation-accept', { accepterId: socket.id })
  })

  // 发送方完成译音轨道替换后，通知接收方启用远端音频轨道
  socket.on('interpretation-audio-ready', ({ targetId }) => {
    io.to(targetId).emit('interpretation-audio-ready', { senderId: socket.id })
  })

  // 任意一方关闭同传
  socket.on('interpretation-stop', ({ targetId }) => {
    io.to(targetId).emit('interpretation-stop', { senderId: socket.id })
  })

  // 转发同传转录文本（可选，用于字幕显示）
  socket.on('interpretation-transcript', ({ targetId, inputText, outputText }) => {
    io.to(targetId).emit('interpretation-transcript', {
      senderId: socket.id,
      inputText,
      outputText,
    })
  })

  // 聊天消息
  socket.on('chat-message', ({ roomId, message, type = 'text', fileInfo }) => {
    socket.to(roomId).emit('chat-message', {
      senderId: socket.id,
      message,
      type,
      fileInfo,
      timestamp: Date.now(),
    })
  })

  socket.on('disconnecting', () => {
    const roomsJoined = socket.rooms
    for (const roomId of roomsJoined) {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId)
        if (room.has(socket.id)) {
          room.delete(socket.id)

          socket.to(roomId).emit('user-left', socket.id)

          if (room.size === 0) {
            rooms.delete(roomId)
            console.log(`Room ${roomId} destroyed`)
          }
        }
      }
    }
  })

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id)
  })
})

const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
