import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})

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
