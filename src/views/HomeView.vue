<template>
  <div
    class="h-dvh bg-linear-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4 sm:p-6 lg:p-8 overflow-hidden relative"
  >
    <!-- Animated Background Orbs -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        class="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-blue-600/20 rounded-full blur-[120px] animate-pulse"
      ></div>
      <div
        class="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] bg-purple-600/20 rounded-full blur-[120px] animate-pulse"
        style="animation-delay: 1s"
      ></div>
      <div
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[40%] h-[40%] bg-cyan-500/10 rounded-full blur-[100px] animate-pulse"
        style="animation-delay: 2s"
      ></div>
    </div>

    <!-- Settings Button -->
    <button
      @click="showSettings = true"
      class="fixed top-4 right-4 sm:top-6 sm:right-6 z-50 p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition-all duration-200 border border-white/10 shadow-lg hover:shadow-xl cursor-pointer group"
      title="AI 设置"
      aria-label="打开AI设置"
    >
      <Settings
        class="w-5 h-5 text-white group-hover:rotate-90 transition-transform duration-300"
      />
    </button>

    <!-- Settings Modal -->
    <SettingsModal v-model="showSettings" />

    <!-- Main Content Card -->
    <div class="w-full max-w-md relative z-10">
      <!-- Glass Card -->
      <div
        class="bg-white/10 backdrop-blur-xl rounded-3xl p-8 sm:p-10 border border-white/20 shadow-2xl"
      >
        <!-- Header -->
        <div class="text-center mb-4">
          <div
            class="inline-flex items-center justify-center w-16 h-16 bg-linear-to-br from-blue-500 to-purple-600 rounded-2xl mb-4 shadow-lg"
          >
            <Video class="w-8 h-8 text-white" />
          </div>
          <h1
            class="text-3xl sm:text-4xl sm:leading-12 font-bold mb-3 bg-linear-to-r from-blue-400 via-cyan-400 to-purple-400 bg-clip-text text-transparent"
          >
            WebRTC Meeting
          </h1>
          <!-- <p class="text-gray-300 text-sm sm:text-base">安全、实时、无缝的音视频会议体验</p> -->
        </div>

        <!-- Form -->
        <div class="space-y-4">
          <!-- Name Input -->
          <div class="relative group">
            <label for="userName" class="sr-only">您的名字</label>
            <div
              class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-400 transition-colors duration-200"
            >
              <UserIcon class="w-5 h-5" />
            </div>
            <input
              id="userName"
              v-model="userName"
              type="text"
              placeholder="输入您的名字"
              class="w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:bg-white/10 focus:border-white/20 transition-all duration-200"
              required
              autocomplete="off"
            />
          </div>

          <!-- Room ID Input -->
          <div class="relative group">
            <label for="roomId" class="sr-only">房间码</label>
            <div
              class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-400 transition-colors duration-200"
            >
              <Hash class="w-5 h-5" />
            </div>
            <input
              id="roomId"
              v-model="roomId"
              type="text"
              placeholder="输入房间码（可选）"
              class="uppercase w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:bg-white/10 focus:border-white/20 transition-all duration-200"
              @keyup.enter="joinRoom"
            />
          </div>

          <!-- Create Room Button -->
          <button
            @click="createRoom"
            :disabled="!userName || !isConnected"
            class="w-full py-3.5 px-4 bg-linear-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 rounded-xl font-semibold transition-all duration-200 flex items-center justify-center gap-2 group shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50 cursor-pointer text-white"
            aria-label="创建房间"
          >
            <PlusCircle
              class="w-5 h-5 transition-transform duration-200 group-hover:scale-110 group-hover:rotate-90"
            />
            创建房间
          </button>

          <!-- Divider -->
          <div class="relative">
            <!-- <div class="absolute inset-0 flex items-center">
              <div class="w-full border-t border-white/10"></div>
            </div> -->
            <div class="relative flex justify-center">
              <span class="px-3 text-sm text-gray-400 bg-transparent">或者</span>
            </div>
          </div>

          <!-- Join Room Button -->
          <button
            @click="joinRoom"
            :disabled="!roomId || !userName || !isConnected"
            class="w-full py-3.5 px-4 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl font-semibold transition-all duration-200 flex items-center justify-center gap-2 border border-white/10 hover:border-white/20 cursor-pointer text-white disabled:hover:bg-white/5 disabled:hover:border-white/10"
            aria-label="加入房间"
          >
            <LogIn class="w-5 h-5" />
            加入房间
          </button>
        </div>

        <!-- Status Indicator -->
        <div class="pt-6">
          <div class="flex items-center justify-center gap-2 text-sm">
            <div
              :class="[
                'w-2 h-2 rounded-full transition-all duration-300',
                isConnected
                  ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.8)] animate-pulse'
                  : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]',
              ]"
            ></div>
            <span :class="isConnected ? 'text-green-400' : 'text-red-400'" class="font-medium">
              {{ status }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { PlusCircle, LogIn, Hash, User as UserIcon, Settings, Video } from 'lucide-vue-next'
import { io, type Socket } from 'socket.io-client'
import SettingsModal from '@/components/SettingsModal.vue'
const wsURL = import.meta.env.VITE_WS_URL

const router = useRouter()
const route = useRoute()
const roomId = ref('')
const userName = ref('')
const status = ref('正在连接服务器...')
const isConnected = ref(false)

// Settings
const showSettings = ref(false)

let socket: Socket

onMounted(() => {
  // 自动填写路由转换过来的房间码
  if (route.query.code) {
    roomId.value = route.query.code as string
  }

  socket = io(wsURL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  })

  socket.on('connect', () => {
    isConnected.value = true
    status.value = '服务器已连接'
  })

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err)
    isConnected.value = false
    status.value = '连接失败'
  })

  socket.on('disconnect', () => {
    isConnected.value = false
    status.value = '服务器断开连接'
  })

  socket.on('room-created', (data) => {
    if (data.status) {
      router.push({ path: `/${data.roomId}`, query: { name: userName.value } })
    } else {
      alert('创建房间失败: ' + data.error)
    }
  })
})

onUnmounted(() => {
  if (socket) socket.disconnect()
})

const createRoom = async () => {
  if (!userName.value) {
    alert('请输入您的名字')
    return
  }

  try {
    // const response = await fetch('/api/create-room')
    // if (!response.ok) {
    //   throw new Error('Failed to create room')
    // }
    // const data = await response.json()
    // router.push({ path: `/${data.roomId}`, query: { name: userName.value } })
    socket.emit('create-room')
  } catch (error) {
    console.error('Create room error:', error)
    alert('创建房间失败，请重试')
  }
}

const joinRoom = () => {
  if (roomId.value && userName.value) {
    router.push({ path: `/${roomId.value.toUpperCase()}`, query: { name: userName.value } })
  }
}
</script>
