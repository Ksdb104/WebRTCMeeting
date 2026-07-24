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

    <!-- GitHub Link -->
    <a
      href="https://github.com/Ksdb104/WebRTCMeeting"
      target="_blank"
      rel="noopener noreferrer"
      class="fixed top-4 right-32 sm:top-6 sm:right-34 z-50 p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition-all duration-200 border border-white/10 shadow-lg hover:shadow-xl cursor-pointer group"
      title="GitHub"
      aria-label="GitHub"
    >
      <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"
        />
      </svg>
    </a>

    <!-- Language Switcher -->
    <button
      @click="toggleLocale"
      class="w-11.5 h-11.5 flex items-center justify-center fixed top-4 right-18 sm:top-6 sm:right-20 z-50 p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition-all duration-200 border border-white/10 shadow-lg hover:shadow-xl cursor-pointer group"
      :title="locale === 'zh' ? 'Switch to English' : '切换为中文'"
      aria-label="Switch language"
    >
      <span class="text-sm font-bold text-white">{{ locale === 'zh' ? 'EN' : '中' }}</span>
    </button>

    <!-- Settings Button -->
    <button
      @click="showSettings = true"
      class="fixed top-4 right-4 sm:top-6 sm:right-6 z-50 p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition-all duration-200 border border-white/10 shadow-lg hover:shadow-xl cursor-pointer group"
      :title="t('home.aiSettings')"
      :aria-label="t('home.aiSettings')"
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
            {{ t('home.title') }}
          </h1>
        </div>

        <!-- Form -->
        <div class="space-y-4">
          <!-- Name Input -->
          <div class="relative group">
            <label for="userName" class="sr-only">{{ t('home.namePlaceholder') }}</label>
            <div
              class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-400 transition-colors duration-200"
            >
              <UserIcon class="w-5 h-5" />
            </div>
            <input
              id="userName"
              v-model="userName"
              type="text"
              :placeholder="t('home.namePlaceholder')"
              class="w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:bg-white/10 focus:border-white/20 transition-all duration-200"
              required
              autocomplete="off"
            />
          </div>

          <!-- Room ID Input -->
          <div class="relative group">
            <label for="roomId" class="sr-only">{{ t('home.roomIdPlaceholder') }}</label>
            <div
              class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-400 transition-colors duration-200"
            >
              <Hash class="w-5 h-5" />
            </div>
            <input
              id="roomId"
              v-model="roomId"
              type="text"
              :placeholder="t('home.roomIdPlaceholder')"
              class="uppercase w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:bg-white/10 focus:border-white/20 transition-all duration-200"
              @keyup.enter="joinRoom"
            />
          </div>

          <!-- Create Room Button -->
          <button
            @click="createRoom"
            :disabled="!userName || !isConnected"
            class="w-full py-3.5 px-4 bg-linear-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 rounded-xl font-semibold transition-all duration-200 flex items-center justify-center gap-2 group shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50 cursor-pointer text-white"
            :aria-label="t('home.createRoom')"
          >
            <PlusCircle
              class="w-5 h-5 transition-transform duration-200 group-hover:scale-110 group-hover:rotate-90"
            />
            {{ t('home.createRoom') }}
          </button>

          <!-- Divider -->
          <div class="relative">
            <div class="relative flex justify-center">
              <span class="px-3 text-sm text-gray-400 bg-transparent">{{ t('home.or') }}</span>
            </div>
          </div>

          <!-- Join Room Button -->
          <button
            @click="joinRoom"
            :disabled="!roomId || !userName || !isConnected"
            class="w-full py-3.5 px-4 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl font-semibold transition-all duration-200 flex items-center justify-center gap-2 border border-white/10 hover:border-white/20 cursor-pointer text-white disabled:hover:bg-white/5 disabled:hover:border-white/10"
            :aria-label="t('home.joinRoom')"
          >
            <LogIn class="w-5 h-5" />
            {{ t('home.joinRoom') }}
          </button>
        </div>

        <!-- Status Indicator -->
        <div class="pt-6">
          <div class="flex items-center justify-center gap-2 text-sm">
            <!-- Green indicator (connected) -->
            <div
              v-if="isConnected"
              class="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.8)] animate-pulse"
            ></div>
            <!-- Red indicator (disconnected) -->
            <div
              v-else
              class="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]"
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
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { PlusCircle, LogIn, Hash, User as UserIcon, Settings, Video } from 'lucide-vue-next'
import { io, type Socket } from 'socket.io-client'
import { useI18n } from 'vue-i18n'
import SettingsModal from '@/components/SettingsModal.vue'
const wsURL = import.meta.env.VITE_WS_URL

const { t, locale } = useI18n()

const toggleLocale = () => {
  locale.value = locale.value === 'zh' ? 'en' : 'zh'
  localStorage.setItem('app_locale', locale.value)
}

const router = useRouter()
const route = useRoute()
const roomId = ref('')
const userName = ref('')
const connectionState = ref<'connecting' | 'connected' | 'failed' | 'disconnected'>('connecting')
const isConnected = ref(false)

const status = computed(() => {
  switch (connectionState.value) {
    case 'connecting':
      return t('home.connecting')
    case 'connected':
      return t('home.connected')
    case 'failed':
      return t('home.connectFailed')
    case 'disconnected':
      return t('home.disconnected')
  }
})

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
    connectionState.value = 'connected'
  })

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err)
    isConnected.value = false
    connectionState.value = 'failed'
  })

  socket.on('disconnect', () => {
    isConnected.value = false
    connectionState.value = 'disconnected'
  })

  socket.on('room-created', (data) => {
    if (data.status) {
      router.push({ path: `/${data.roomId}`, query: { name: userName.value } })
    } else {
      alert(t('home.createFailedWithError', { error: data.error }))
    }
  })
})

onUnmounted(() => {
  if (socket) socket.disconnect()
})

const createRoom = async () => {
  if (!userName.value) {
    alert(t('home.nameRequired'))
    return
  }

  try {
    socket.emit('create-room')
  } catch (error) {
    console.error('Create room error:', error)
    alert(t('home.createFailed'))
  }
}

const joinRoom = () => {
  if (roomId.value && userName.value) {
    router.push({ path: `/${roomId.value.toUpperCase()}`, query: { name: userName.value } })
  }
}
</script>
