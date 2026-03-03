<template>
  <!-- 底部功能栏 (Desktop) -->
  <div
    v-if="!isMobile"
    class="h-20 bg-slate-900/90 backdrop-blur border-t border-white/10 flex items-center justify-between px-6 z-40 shadow-[0_-4px_20px_rgba(0,0,0,0.3)]"
  >
    <div class="flex items-center gap-4 min-w-50">
      <div class="flex flex-col gap-1">
        <div
          class="flex items-center gap-2 group cursor-pointer bg-white/5 px-2 py-1 rounded hover:bg-white/10"
          @click="copyRoomId"
        >
          <span class="text-xs text-gray-400">房间码:</span>
          <span class="font-mono text-sm font-bold text-white">{{ roomId }}</span>
          <Copy class="w-3 h-3 text-gray-500 group-hover:text-blue-400" />
        </div>
        <div
          class="flex items-center gap-2 group cursor-pointer bg-white/5 px-2 py-1 rounded hover:bg-white/10"
          @click="copyLink"
        >
          <span class="text-xs text-gray-400">链接:</span>
          <span class="font-mono text-xs text-white truncate max-w-25">点击复制</span>
          <Link class="w-3 h-3 text-gray-500 group-hover:text-blue-400" />
        </div>
      </div>
    </div>

    <div class="flex items-center gap-4">
      <button
        class="p-4 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
        :class="{ 'bg-red-500/20! text-red-500!': !localUser.micOpen }"
        @click="emit('toggleMic')"
      >
        <Mic v-if="localUser.micOpen" class="w-6 h-6 group-hover:scale-110 transition-transform" />
        <MicOff v-else class="w-6 h-6 group-hover:scale-110 transition-transform" />
      </button>

      <button
        class="p-4 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
        :class="{ 'bg-red-500/20! text-red-500!': !localUser.camOpen }"
        @click="emit('toggleCam')"
      >
        <Video
          v-if="localUser.camOpen"
          class="w-6 h-6 group-hover:scale-110 transition-transform"
        />
        <VideoOff v-else class="w-6 h-6 group-hover:scale-110 transition-transform" />
      </button>

      <button
        class="p-4 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
        :class="{ 'bg-blue-600! text-white!': localUser.isScreenSharing }"
        @click="emit('handleScreenShare')"
      >
        <Monitor class="w-6 h-6 group-hover:scale-110 transition-transform" />
      </button>

      <button
        class="p-4 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
        :class="{ 'bg-red-600! text-white!': isRecording }"
        @click="emit('toggleRecording')"
      >
        <Disc
          class="w-6 h-6 group-hover:scale-110 transition-transform"
          :class="{ 'animate-pulse': isRecording }"
        />
      </button>

      <div class="w-px h-8 bg-white/10 mx-2"></div>

      <button
        class="p-4 rounded-full bg-red-600 hover:bg-red-700 text-white transition-all duration-200 shadow-lg shadow-red-600/30 group relative"
        @click="emit('leaveRoom')"
      >
        <PhoneOff class="w-6 h-6 group-hover:scale-110 transition-transform" />
      </button>
    </div>

    <div class="flex items-center justify-end gap-2 min-w-50">
      <button
        @click="emit('update:showSidebar', !showSidebar)"
        class="p-3 rounded-xl hover:bg-slate-800 transition-colors"
        :class="{ 'bg-slate-800 text-blue-400': showSidebar, 'text-gray-400': !showSidebar }"
      >
        <PanelRight class="w-5 h-5" />
      </button>
    </div>
  </div>

  <!-- 底部功能-移动端适配 -->
  <div
    v-else
    class="h-13 bg-slate-900/90 backdrop-blur border-t border-white/10 flex items-center justify-between px-2 z-40 shadow-[0_-4px_20px_rgba(0,0,0,0.3)]"
  >
    <button
      class="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
      :class="{ 'bg-red-500/20! text-red-500!': !localUser.micOpen }"
      @click="emit('toggleMic')"
    >
      <Mic v-if="localUser.micOpen" class="w-4 h-4 group-hover:scale-110 transition-transform" />
      <MicOff v-else class="w-4 h-4 group-hover:scale-110 transition-transform" />
    </button>

    <button
      class="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
      :class="{ 'bg-red-500/20! text-red-500!': !localUser.camOpen }"
      @click="emit('toggleCam')"
    >
      <Video v-if="localUser.camOpen" class="w-4 h-4 group-hover:scale-110 transition-transform" />
      <VideoOff v-else class="w-4 h-4 group-hover:scale-110 transition-transform" />
    </button>

    <button
      v-if="localUser.camOpen"
      class="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
      @click="emit('switchCamera')"
    >
      <RefreshCcw class="w-4 h-4 group-hover:scale-110 transition-transform" />
    </button>

    <button
      class="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
      @click="emit('update:mobileShowSidebar', !mobileShowSidebar)"
    >
      <Users class="w-4 h-4 group-hover:scale-110 transition-transform" />
    </button>

    <button
      v-if="!isIOS"
      class="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
      @click="emit('toggleFullscreen')"
    >
      <Maximize v-if="!isFullscreen" class="w-4 h-4 group-hover:scale-110 transition-transform" />
      <Minimize v-else class="w-4 h-4 group-hover:scale-110 transition-transform" />
    </button>

    <button
      class="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-all duration-200 group relative"
      @click="copyLink"
    >
      <Share class="w-4 h-4 group-hover:scale-110 transition-transform" />
    </button>

    <button
      class="p-2 rounded-full bg-red-600 hover:bg-red-700 text-white transition-all duration-200 shadow-lg shadow-red-600/30 group relative"
      @click="emit('leaveRoom')"
    >
      <PhoneOff class="w-4 h-4 group-hover:scale-110 transition-transform" />
    </button>
  </div>
</template>

<script setup lang="ts">
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Monitor,
  PhoneOff,
  PanelRight,
  Copy,
  Link,
  Disc,
  RefreshCcw,
  Users,
  Maximize,
  Minimize,
  Share,
} from 'lucide-vue-next'
import type { User } from '@/composables/useWebRTC'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'

const props = defineProps<{
  localUser: User
  roomId: string
  isRecording: boolean
  isMobile: boolean
  showSidebar: boolean
  mobileShowSidebar: boolean
  isFullscreen: boolean
}>()

const emit = defineEmits<{
  (e: 'toggleMic'): void
  (e: 'toggleCam'): void
  (e: 'handleScreenShare'): void
  (e: 'toggleRecording'): void
  (e: 'leaveRoom'): void
  (e: 'update:showSidebar', value: boolean): void
  (e: 'update:mobileShowSidebar', value: boolean): void
  (e: 'switchCamera'): void
  (e: 'toggleFullscreen'): void
}>()

const deviceStore = useDeviceStore()
const { isIOS } = storeToRefs(deviceStore)

const copyLink = () => {
  const url = `${window.location.origin}/${props.roomId}`
  navigator.clipboard.writeText(url)
  alert('链接已复制')
}

const copyRoomId = () => {
  navigator.clipboard.writeText(props.roomId)
  alert('房间码已复制')
}
</script>
