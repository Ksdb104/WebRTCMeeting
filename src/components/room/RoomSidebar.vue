<template>
  <!-- Desktop Sidebar -->
  <div
    v-if="!isMobile && show"
    class="w-80 bg-slate-900/90 backdrop-blur border-l border-white/10 flex flex-col transition-all duration-300 z-30"
  >
    <RoomSidebarContent
      :users="users"
      :localUser="localUser"
      :chatMessages="chatMessages"
      :activeTab="activeTab"
      @sendMessage="onSendMessage"
      @update:activeTab="emit('update:activeTab', $event)"
    />
  </div>

  <!-- Mobile Sidebar (Overlay) -->
  <div
    v-if="isMobile"
    class="absolute w-dvw h-dvh top-[100dvh] bg-black/30 flex items-center justify-center z-10 backdrop-blur-sm"
    :class="{ 'top-0!': mobileShow }"
    @click.self="emit('update:mobileShow', false)"
  >
    <div
      class="w-dvw h-[45dvh] absolute bottom-[-100dvh] bg-slate-900/90 backdrop-blur border-l border-white/10 flex flex-col transition-all duration-300"
      :class="{ 'bottom-13!': mobileShow }"
    >
      <RoomSidebarContent
        :users="users"
        :localUser="localUser"
        :chatMessages="chatMessages"
        :activeTab="activeTab"
        @sendMessage="onSendMessage"
        @update:activeTab="emit('update:activeTab', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import RoomSidebarContent from './RoomSidebarContent.vue'
import type { User } from '@/composables/useWebRTC'

interface ChatMessage {
  id: number
  senderId: string
  senderName: string
  content: string
  timestamp: number
  isSelf: boolean
}

defineProps<{
  show: boolean
  mobileShow: boolean
  isMobile: boolean
  users: Map<string, User>
  localUser: User
  chatMessages: ChatMessage[]
  activeTab: string
}>()

const emit = defineEmits<{
  (e: 'update:mobileShow', value: boolean): void
  (e: 'sendMessage', content: string): void
  (e: 'update:activeTab', value: string): void
}>()

const onSendMessage = (content: string) => {
  emit('sendMessage', content)
}
</script>
