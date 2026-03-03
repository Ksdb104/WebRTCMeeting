<template>
  <div class="flex flex-col h-full">
    <!-- 标签页 -->
    <div class="flex border-b border-white/10">
      <button
        @click="emit('update:activeTab', 'users')"
        :class="[
          'flex-1 py-4 text-sm font-medium transition-colors relative',
          activeTab === 'users' ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200',
        ]"
      >
        成员 ({{ users.size + 1 }})
        <div
          v-if="activeTab === 'users'"
          class="absolute bottom-0 left-0 w-full h-0.5 bg-blue-400"
        ></div>
      </button>
      <button
        @click="emit('update:activeTab', 'chat')"
        :class="[
          'flex-1 py-4 text-sm font-medium transition-colors relative',
          activeTab === 'chat' ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200',
        ]"
      >
        聊天
        <div
          v-if="activeTab === 'chat'"
          class="absolute bottom-0 left-0 w-full h-0.5 bg-blue-400"
        ></div>
      </button>
    </div>

    <!-- 内容 -->
    <div class="flex-1 overflow-y-auto bg-slate-900/50">
      <!-- 成员列表 -->
      <div v-if="activeTab === 'users'" class="p-4 space-y-4">
        <!-- 自己 -->
        <div
          class="flex items-center justify-between p-3 bg-white/5 rounded-lg border transition-all duration-300"
          :class="[
            localUser.isSpeaking
              ? 'border-green-500/50 bg-green-500/10 shadow-[0_0_15px_-3px_rgba(34,197,94,0.2)]'
              : 'border-white/5',
          ]"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-full bg-linear-to-br from-blue-500 to-purple-500 flex items-center justify-center text-xs font-bold transition-all duration-300"
              :class="{
                'ring-2 ring-green-400 ring-offset-2 ring-offset-slate-900 scale-110':
                  localUser.isSpeaking,
              }"
            >
              {{ localUser.name.charAt(0).toUpperCase() }}
            </div>
            <div class="flex flex-col">
              <span class="text-sm font-medium">{{ localUser.name }} (我)</span>
              <span
                v-if="localUser.isSpeaking"
                class="text-xs text-green-400 font-medium animate-pulse flex items-center gap-1"
              >
                <div class="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                正在说话...
              </span>
              <span v-else class="text-xs text-green-500 flex items-center gap-1">
                <div class="w-1.5 h-1.5 rounded-full bg-green-500"></div>
                在线
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2 text-gray-400">
            <Mic v-if="localUser.micOpen" class="w-4 h-4 text-green-400" />
            <MicOff v-else class="w-4 h-4 text-red-400" />
            <Video v-if="localUser.camOpen" class="w-4 h-4 text-green-400" />
            <VideoOff v-else class="w-4 h-4 text-red-400" />
          </div>
        </div>

        <!-- 其他人 -->
        <div
          v-for="user in users.values()"
          :key="user.id"
          class="flex items-center justify-between p-3 bg-white/5 rounded-lg border transition-all duration-300"
          :class="[
            user.isSpeaking
              ? 'border-green-500/50 bg-green-500/10 shadow-[0_0_15px_-3px_rgba(34,197,94,0.2)]'
              : 'border-white/5',
          ]"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-full bg-linear-to-br from-blue-500 to-purple-500 flex items-center justify-center text-xs font-bold transition-all duration-300"
              :class="{
                'ring-2 ring-green-400 ring-offset-2 ring-offset-slate-900 scale-110':
                  user.isSpeaking,
              }"
            >
              {{ user.name.charAt(0).toUpperCase() }}
            </div>
            <div class="flex flex-col">
              <span class="text-sm font-medium">{{ user.name }}</span>
              <span
                v-if="user.isSpeaking"
                class="text-xs text-green-400 font-medium animate-pulse flex items-center gap-1"
              >
                <div class="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                正在说话...
              </span>
              <span v-else class="text-xs text-gray-500 flex items-center gap-1">
                <div
                  :class="[
                    'w-1.5 h-1.5 rounded-full',
                    user.connected ? 'bg-green-500' : 'bg-yellow-500',
                  ]"
                ></div>
                {{ user.connected ? '已连接' : '连接中' }}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2 text-gray-400">
            <Mic v-if="user.micOpen" class="w-4 h-4 text-green-400" />
            <MicOff v-else class="w-4 h-4 text-red-400" />
            <Video v-if="user.camOpen" class="w-4 h-4 text-green-400" />
            <VideoOff v-else class="w-4 h-4 text-red-400" />
          </div>
        </div>
      </div>

      <!-- 聊天 -->
      <div v-else class="h-full flex flex-col">
        <div
          ref="chatContainer"
          class="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-slate-700"
        >
          <div v-for="msg in chatMessages" :key="msg.id" class="flex flex-col gap-1">
            <div class="flex items-end gap-2" :class="msg.isSelf ? 'flex-row-reverse' : ''">
              <div
                class="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[10px] text-gray-300"
              >
                {{ msg.senderName.charAt(0) }}
              </div>
              <div
                :class="[
                  'px-3 py-2 rounded-2xl max-w-[80%] text-sm wrap-break-word',
                  msg.isSelf
                    ? 'bg-blue-600 text-white rounded-tr-sm'
                    : 'bg-slate-800 text-gray-200 rounded-tl-sm',
                ]"
              >
                {{ msg.content }}
              </div>
            </div>
            <span class="text-[10px] text-gray-500 px-9" :class="msg.isSelf ? 'text-right' : ''">
              {{
                new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              }}
            </span>
          </div>
        </div>

        <div class="p-3 border-t border-white/10 bg-slate-900/95 backdrop-blur">
          <div class="flex gap-2">
            <input
              v-model="chatInput"
              @keyup.enter="handleSendMessage"
              type="text"
              class="flex-1 bg-slate-800 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              placeholder="输入消息..."
            />
            <button
              @click="handleSendMessage"
              class="bg-blue-600 hover:bg-blue-700 p-2.5 rounded-xl transition-colors text-white"
            >
              <Send class="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { Mic, MicOff, Video, VideoOff, Send } from 'lucide-vue-next'
import type { User } from '@/composables/useWebRTC'

// Re-define ChatMessage interface locally or import it. Ideally import.
// For now, simple definition.
interface ChatMessage {
  id: number
  senderId: string
  senderName: string
  content: string
  timestamp: number
  isSelf: boolean
}

const props = defineProps<{
  users: Map<string, User>
  localUser: User
  chatMessages: ChatMessage[]
  activeTab: string
}>()

const emit = defineEmits<{
  (e: 'sendMessage', content: string): void
  (e: 'update:activeTab', value: string): void
}>()
const chatInput = ref('')
const chatContainer = ref<HTMLElement | null>(null)

const handleSendMessage = () => {
  if (!chatInput.value.trim()) return
  emit('sendMessage', chatInput.value)
  chatInput.value = ''
}

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

// Watch chatMessages to scroll
watch(
  () => props.chatMessages.length,
  () => {
    scrollToBottom()
  },
)
</script>
