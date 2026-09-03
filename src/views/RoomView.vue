<template>
  <div class="h-dvh bg-slate-950 text-white flex flex-col overflow-hidden relative">
    <!-- 信令断线提示 -->
    <Transition name="fade">
      <div
        v-if="isReconnecting"
        class="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-200 text-sm shadow-lg backdrop-blur-sm"
        role="status"
        aria-live="polite"
      >
        <span
          class="w-3.5 h-3.5 rounded-full border-2 border-amber-300/40 border-t-amber-200 animate-spin"
          aria-hidden="true"
        ></span>
        {{ t('room.signalingLost') }}
      </div>
    </Transition>

    <!-- 左侧：快捷消息/文件 (透明背景，悬浮) -->
    <div
      class="absolute left-4 top-1/2 -translate-y-1/2 z-20 w-80 pointer-events-none space-y-2"
      v-if="
        !showSidebar || (showSidebar && activeTab != 'chat') || (isMobile && !mobileShowSidebar)
      "
    >
      <TransitionGroup name="fade">
        <div
          v-for="msg in quickMessages"
          :key="msg.id"
          class="bg-black/40 backdrop-blur-sm p-3 rounded-lg text-sm text-white/90 border-l-4 border-blue-500 shadow-lg animate-in fade-in slide-in-from-left-4"
        >
          <span class="font-bold text-blue-300">{{ msg.senderName }}:</span> {{ msg.content }}
        </div>
      </TransitionGroup>
    </div>

    <!-- 主内容区 -->
    <div class="flex-1 flex overflow-hidden relative">
      <!-- 中间：视频/屏幕共享 -->
      <div class="flex-1 relative bg-black/50 p-4 flex items-center justify-center overflow-hidden">
        <!-- Mode 1: Screen Share Grid -->
        <div
          v-if="screenShares.length > 0"
          class="grid gap-4 w-full h-full transition-all duration-500"
          :class="gridClass"
        >
          <div
            v-for="user in screenShares"
            :key="user.id + '-screen'"
            class="relative rounded-xl overflow-hidden border border-white/10 bg-black"
          >
            <!-- Screen Stream (Main) -->
            <VideoPlayer
              v-if="!swappedViews.has(user.id)"
              :stream="getScreenStream(user)"
              :name="t('room.screenOf', { name: user.name })"
              :micOpen="user.micOpen"
              :muted="user.id === localUser.id"
              :sreenStream="true"
              :pipMode="false"
            />
            <!-- Camera Stream (Main) -->
            <VideoPlayer
              v-else
              :stream="getCameraStream(user)"
              :name="user.name"
              :micOpen="user.micOpen"
              :camOpen="true"
              :muted="user.id === localUser.id"
              :mirror="user.id === localUser.id"
              :pipMode="false"
            />

            <!-- 右上角叠画 -->
            <div
              v-if="user.camOpen"
              class="absolute top-4 right-4 w-1/4 aspect-video bg-black rounded-xl overflow-hidden border border-white/20 shadow-xl z-10 min-w-30 cursor-pointer hover:border-blue-500 hover:shadow-blue-500/20 transition-all"
              @click.stop="toggleView(user.id)"
              :title="t('room.clickToSwapView')"
            >
              <VideoPlayer
                v-if="!swappedViews.has(user.id)"
                :stream="getCameraStream(user)"
                :name="user.name"
                :micOpen="user.micOpen"
                :camOpen="true"
                :muted="user.id === localUser.id"
                :mirror="user.id === localUser.id"
                :pipMode="true"
              />
              <VideoPlayer
                v-else
                :stream="getScreenStream(user)"
                :name="t('room.screenOf', { name: user.name })"
                :micOpen="user.micOpen"
                :sreenStream="true"
                :muted="user.id === localUser.id"
                :pipMode="true"
              />
            </div>
          </div>
        </div>

        <!-- Mode 2: Camera Grid -->
        <div
          v-else-if="cameraUsers.length > 0"
          class="grid gap-4 w-full h-full transition-all duration-500"
          :class="gridClass"
        >
          <div
            v-for="user in cameraUsers"
            :key="user.id + '-cam'"
            class="relative rounded-xl overflow-hidden border border-white/10 shadow-lg"
          >
            <VideoPlayer
              :stream="getCameraStream(user)"
              :name="user.name"
              :micOpen="user.micOpen"
              :camOpen="true"
              :muted="user.id === localUser.id"
              :mirror="user.id === localUser.id"
              :pipMode="false"
            />
          </div>
        </div>

        <!-- Mode 3: Avatar Grid (All Users) -->
        <div v-else class="grid gap-4 w-full h-full transition-all duration-500" :class="gridClass">
          <div
            v-for="user in allUsers"
            :key="user.id"
            class="relative rounded-xl overflow-hidden border border-white/10 shadow-lg bg-slate-800"
          >
            <VideoPlayer
              :stream="getCameraStream(user)"
              :name="user.name"
              :micOpen="user.micOpen"
              :camOpen="user.camOpen"
              :muted="user.id === localUser.id"
              :pipMode="false"
            />
          </div>
        </div>
      </div>

      <RoomSidebar
        :show="showSidebar"
        :mobileShow="mobileShowSidebar"
        :isMobile="isMobile"
        :users="users"
        :localUser="localUser"
        :chatMessages="chatMessages"
        :interpretingUsers="interpretingUsers"
        :receivingInterpretation="receivingInterpretation"
        v-model:activeTab="activeTab"
        @update:mobileShow="mobileShowSidebar = $event"
        @sendMessage="handleSendMessage"
        @toggleInterpretation="handleToggleInterpretation"
      />
    </div>

    <div
      v-if="interpretationErrors.length > 0"
      class="absolute top-4 left-1/2 -translate-x-1/2 z-40 max-w-[min(90vw,40rem)] bg-red-950/95 border border-red-500/40 px-4 py-3 rounded-md shadow-xl"
    >
      <p class="text-sm font-medium text-red-200">{{ t('interpretation.captureError') }}</p>
      <p class="mt-1 text-xs text-red-300">{{ interpretationErrors[0] }}</p>
    </div>

    <!-- 同传降级提示 -->
    <div
      v-if="interpretationState.degradeNotices.length > 0"
      class="absolute top-16 left-1/2 -translate-x-1/2 z-40 w-[min(90vw,32rem)] space-y-2"
      role="status"
      aria-live="polite"
    >
      <div
        v-for="notice in interpretationState.degradeNotices"
        :key="notice.id"
        class="flex items-start gap-3 bg-amber-950/95 border border-amber-500/40 px-4 py-3 rounded-md shadow-xl"
      >
        <p class="flex-1 text-xs text-amber-200 leading-relaxed">
          {{ degradeNoticeText(notice) }}
        </p>
        <button
          class="text-amber-300/70 hover:text-amber-100 transition-colors text-xs shrink-0"
          :aria-label="t('interpretation.degraded.dismiss')"
          @click="dismissInterpretationNotice(notice.id)"
        >
          ✕
        </button>
      </div>
    </div>

    <div
      v-if="interpretationCaptions.length > 0"
      class="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 w-[min(88vw,42rem)] max-h-36 overflow-hidden space-y-1.5 pointer-events-none"
      aria-live="polite"
    >
      <div
        v-for="caption in interpretationCaptions"
        :key="caption.id"
        class="bg-black/80 border border-white/15 px-4 py-2.5 rounded-md shadow-xl text-center"
      >
        <p class="text-[11px] text-amber-300 mb-1">{{ caption.label }}</p>
        <p class="text-sm sm:text-base text-white leading-snug wrap-break-word line-clamp-2">
          {{ caption.text }}
        </p>
      </div>
    </div>

    <!-- 底部功能栏 -->
    <RoomControls
      :localUser="localUser"
      :roomId="roomId"
      :isRecording="isRecording"
      :isMobile="isMobile"
      :isFullscreen="isFullscreen"
      v-model:showSidebar="showSidebar"
      v-model:mobileShowSidebar="mobileShowSidebar"
      @toggleMic="toggleMic"
      @toggleCam="toggleCam"
      @handleScreenShare="handleScreenShare"
      @toggleRecording="toggleRecording"
      @leaveRoom="leaveRoom"
      @switchCamera="switchCamera"
      @toggleFullscreen="toggleFullscreen"
    />

    <!-- 隐藏的音频播放器 **必须，不然窗口变化会导致远端音频不能播放 -->
    <!-- <div class="hidden"> -->
    <!-- iOS 适配: 不能使用 display: none (hidden)，否则视频流不会加载/播放。改用透明度0+绝对定位 -->
    <div class="absolute top-0 left-0 w-1 h-1 opacity-0 pointer-events-none overflow-hidden z-[-1]">
      <VideoPlayer
        v-for="user in hiddenUsers"
        :key="user.id + '-hidden'"
        :stream="user.stream"
        :name="user.name"
        :muted="user.id === localUser.id"
      />
    </div>

    <!-- 同传语言选择弹窗 -->
    <div
      v-if="showLangPicker"
      class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 backdrop-blur-sm"
      @click.self="showLangPicker = false"
    >
      <div
        class="bg-slate-900 border border-white/20 p-6 rounded-2xl w-full max-w-sm text-white shadow-2xl"
      >
        <h3 class="text-lg font-bold mb-4 flex items-center gap-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="w-5 h-5 text-amber-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m5 8 6 6" />
            <path d="m4 14 6-6 2-3" />
            <path d="M2 5h12" />
            <path d="M7 2h1" />
            <path d="m22 22-5-10-5 10" />
            <path d="M14 18h6" />
          </svg>
          {{ t('interpretation.title') }}
        </h3>
        <p class="text-sm text-gray-400 mb-5">{{ t('interpretation.description') }}</p>

        <div class="space-y-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider">{{
              t('interpretation.myLanguage')
            }}</label>
            <select
              v-model="myLanguage"
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            >
              <option v-for="lang in supportedLanguages" :key="lang.code" :value="lang.code">
                {{ t('languages.' + lang.code) }}
              </option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider">{{
              t('interpretation.peerLanguage')
            }}</label>
            <select
              v-model="peerLanguage"
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            >
              <option v-for="lang in supportedLanguages" :key="lang.code" :value="lang.code">
                {{ t('languages.' + lang.code) }}
              </option>
            </select>
          </div>
        </div>

        <div class="mt-6 flex justify-end gap-3">
          <button
            @click="showLangPicker = false"
            class="px-4 py-2 hover:bg-white/10 rounded-lg text-sm transition-colors cursor-pointer"
          >
            {{ t('settings.cancel') }}
          </button>
          <button
            @click="confirmStartInterpretation"
            class="px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-amber-500/20 cursor-pointer"
          >
            {{ t('interpretation.start') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWebRTC, type User } from '@/composables/useWebRTC'
import { useDeviceStore } from '@/stores/device'
import { getSharedAudioContext, closeSharedAudioContext } from '@/utils/globalAudio'
import { storeToRefs } from 'pinia'
import VideoPlayer from '@/components/VideoPlayer.vue'
import RoomControls from '@/components/room/RoomControls.vue'
import RoomSidebar from '@/components/room/RoomSidebar.vue'
import { transcribeAudio, summarizeText, type LLMConfig } from '@/utils/llm'
import {
  useInterpretation,
  type InterpretationDegradeNotice,
} from '@/composables/useInterpretation'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const roomId = route.params.roomId as string

const userName = (route.query.name as string) || ''

const {
  localUser,
  users,
  localStream,
  localScreenStream,
  socket,
  isReconnecting,
  onPeerSessionChanged,
  onPeerRemoved,
  onSignalingLost,
  onSignalingRestored,
  reservePeerAudioTrackOverride,
  setPeerAudioTrackOverride,
  clearPeerAudioTrackOverride,
  init,
  toggleMic,
  toggleCam,
  startScreenShare,
  stopScreenShare,
  switchCamera,
  sendMessage: sendSocketMessage,
} = useWebRTC(roomId, userName)

// ====== 同传 ======
const {
  state: interpretationState,
  startInterpretation,
  stopInterpretation,
  isInterpretingFor,
  setupSocketListeners: setupInterpretationListeners,
  reapplyMutes: reapplyInterpretationMutes,
  dismissDegradeNotice: dismissInterpretationNotice,
  stopAll: stopAllInterpretation,
} = useInterpretation(socket, localStream, users, {
  reservePeerAudioTrackOverride,
  setPeerAudioTrackOverride,
  clearPeerAudioTrackOverride,
  // 同传的降级与重连由这几个连接生命周期回调驱动
  onPeerSessionChanged,
  onPeerRemoved,
  onSignalingLost,
  onSignalingRestored,
})

// 同传相关计算属性
const interpretingUsers = computed(() => {
  const set = new Set<string>()
  for (const key of interpretationState.activeSessions.keys()) {
    set.add(key)
  }
  return set
})

const receivingInterpretation = computed(() => {
  return interpretationState.receivingFrom
})

const interpretationCaptions = computed(() => {
  const captions: Array<{ id: string; label: string; text: string }> = []

  for (const [userId, transcript] of interpretationState.receivedTranscripts) {
    if (!transcript.outputText) continue
    captions.push({
      id: `received-${userId}`,
      label: t('interpretation.captionFrom', {
        name: users.get(userId)?.name || t('room.unknownUser'),
      }),
      text: transcript.outputText,
    })
  }

  for (const [userId, session] of interpretationState.activeSessions) {
    if (!session.outputTranscript) continue
    captions.push({
      id: `outgoing-${userId}`,
      label: t('interpretation.captionTo', {
        name: users.get(userId)?.name || t('room.unknownUser'),
      }),
      text: session.outputTranscript,
    })
  }

  return captions.slice(-2)
})

const degradeNoticeText = (notice: InterpretationDegradeNotice) =>
  t(`interpretation.degraded.${notice.reason}`, {
    name: notice.peerName || users.get(notice.peerId)?.name || t('room.unknownUser'),
  })

const interpretationErrors = computed(() =>
  [
    interpretationState.errorMessage,
    ...[...interpretationState.activeSessions.values()].flatMap((session) =>
      [session.sessionError, session.captureState === 'error' ? session.captureError : ''].filter(
        Boolean,
      ),
    ),
  ].filter(Boolean),
)

// 同传语言选择弹窗状态
const showLangPicker = ref(false)
const langPickerTargetUser = ref('')
const myLanguage = ref('zh-Hans')
const peerLanguage = ref('en')

const supportedLanguages = [
  { code: 'en' },
  { code: 'zh-Hans' },
  { code: 'zh-Hant' },
  { code: 'ja' },
  { code: 'ko' },
  { code: 'fr' },
  { code: 'de' },
  { code: 'es' },
  { code: 'ru' },
  { code: 'ar' },
  { code: 'pt-BR' },
  { code: 'it' },
  { code: 'th' },
  { code: 'vi' },
]

const handleToggleInterpretation = (userId: string) => {
  if (isInterpretingFor(userId) || interpretationState.receivingFrom.has(userId)) {
    // 关闭同传
    stopInterpretation(userId)
  } else {
    // 弹出语言选择
    langPickerTargetUser.value = userId
    showLangPicker.value = true
  }
}

const confirmStartInterpretation = async () => {
  showLangPicker.value = false
  try {
    await startInterpretation(langPickerTargetUser.value, peerLanguage.value, myLanguage.value)
  } catch (e: unknown) {
    alert(t('interpretation.startFailed', { error: e instanceof Error ? e.message : String(e) }))
  }
}

const showSidebar = ref(true) //桌面端右边栏
const mobileShowSidebar = ref(false) //移动端右边栏（实际上变到了下边）
const activeTab = ref('users')

interface ChatMessageData {
  senderId: string
  message: string
  timestamp: number
}

interface ChatMessage {
  id: number
  senderId: string
  senderName: string
  content: string
  timestamp: number
  isSelf: boolean
}

const chatMessages = ref<ChatMessage[]>([])
const quickMessages = ref<{ id: number; senderName: string; content: string }[]>([])
const swappedViews = ref(new Set<string>())
const isFullscreen = ref(false)

const isRecording = ref(false)
let mediaRecorder: MediaRecorder | null = null
let recordedChunks: Blob[] = []
let recordingAudioContext: AudioContext | null = null
let recordingDestination: MediaStreamAudioDestinationNode | null = null
const remoteAudioSources = new Map<string, MediaStreamAudioSourceNode>()
let stopMixingWatcher: (() => void) | null = null

const deviceStore = useDeviceStore()
const { isMobile } = storeToRefs(deviceStore)

// Computed
const allUsers = computed(() => [localUser, ...users.values()])

const screenShares = computed(() => {
  return allUsers.value.filter((u) => {
    if (u.id === localUser.id) return localUser.isScreenSharing && localScreenStream.value
    // 支持错位情况：只共享屏幕时，流可能在 stream 字段
    return u.isScreenSharing && (u.screenStream || (!u.camOpen && u.stream))
  })
})

const cameraUsers = computed(() => {
  return allUsers.value.filter((u) => {
    if (u.id === localUser.id) return localUser.camOpen
    return u.camOpen
  })
})

const visibleUserIds = computed(() => {
  const ids = new Set<string>()
  if (screenShares.value.length > 0) {
    screenShares.value.forEach((u) => ids.add(u.id))
  } else if (cameraUsers.value.length > 0) {
    cameraUsers.value.forEach((u) => ids.add(u.id))
  } else {
    allUsers.value.forEach((u) => ids.add(u.id))
  }
  return ids
})

const hiddenUsers = computed(() => {
  return allUsers.value.filter((u) => !visibleUserIds.value.has(u.id))
})

const gridClass = computed(() => {
  let count = 0
  if (screenShares.value.length > 0) {
    count = screenShares.value.length
  } else if (cameraUsers.value.length > 0) {
    count = cameraUsers.value.length
  } else {
    count = allUsers.value.length
  }

  if (count <= 1) return 'grid-cols-1'
  if (count <= 2) return 'grid-cols-2'
  if (count <= 4) return 'grid-cols-2 md:grid-cols-2'
  if (count <= 6) return 'grid-cols-2 md:grid-cols-3'
  if (count <= 9) return 'grid-cols-3 md:grid-cols-3'
  return 'grid-cols-3 md:grid-cols-4'
})

// Helper functions for streams
const getScreenStream = (u: User) => {
  if (u.id === localUser.id) return localScreenStream.value || undefined
  if (u.screenStream) return u.screenStream
  // Fallback: 如果只共享屏幕且没开摄像头，流可能在 stream 中
  if (u.isScreenSharing && !u.camOpen && u.stream) return u.stream
  return undefined
}

const getCameraStream = (u: User) => {
  if (u.id === localUser.id) return localStream.value || undefined
  // 如果发生错位（stream 是屏幕流），不要作为摄像头返回
  if (u.isScreenSharing && !u.screenStream && !u.camOpen && u.stream) return undefined
  return u.stream || undefined
}

// Methods
const handleScreenShare = () => {
  if (localUser.isScreenSharing) {
    stopScreenShare()
  } else {
    startScreenShare()
  }
}

const leaveRoom = () => {
  if (isRecording.value) {
    if (confirm(t('room.leaveConfirm'))) {
      stopRecording() // Clean stop
      router.push('/')
    }
  } else {
    router.push('/')
  }
}

const handleSendMessage = (content: string) => {
  sendSocketMessage(content)

  // 本地显示
  const msg: ChatMessage = {
    id: Date.now(),
    senderId: localUser.id,
    senderName: localUser.name,
    content: content,
    timestamp: Date.now(),
    isSelf: true,
  }
  chatMessages.value.push(msg)
}

const toggleFullscreen = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = document as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elem = document.documentElement as any

  if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
    if (elem.requestFullscreen) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elem.requestFullscreen().catch((err: any) => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`)
      })
    } else if (elem.webkitRequestFullscreen) {
      elem.webkitRequestFullscreen()
    }
  } else {
    if (doc.exitFullscreen) {
      doc.exitFullscreen()
    } else if (doc.webkitExitFullscreen) {
      doc.webkitExitFullscreen()
    }
  }
}

const toggleView = (userId: string) => {
  const newSet = new Set(swappedViews.value)
  if (newSet.has(userId)) {
    newSet.delete(userId)
  } else {
    newSet.add(userId)
  }
  swappedViews.value = newSet
}

const showQuickMessage = (senderName: string, content: string) => {
  const id = Date.now()
  quickMessages.value.push({ id, senderName, content })
  setTimeout(() => {
    quickMessages.value = quickMessages.value.filter((m) => m.id !== id)
  }, 3000)
}

const toggleRecording = async () => {
  if (isRecording.value) {
    stopRecording()
  } else {
    startRecording()
  }
}

const updateAudioMix = () => {
  if (!recordingAudioContext || !recordingDestination) return

  // 1. Identify all currently active remote audio streams
  const activeStreamIds = new Set<string>()

  users.forEach((user) => {
    // Camera stream
    if (user.stream && user.stream.getAudioTracks().length > 0) {
      activeStreamIds.add(user.stream.id)
      if (!remoteAudioSources.has(user.stream.id)) {
        try {
          const source = recordingAudioContext!.createMediaStreamSource(user.stream)
          source.connect(recordingDestination!)
          remoteAudioSources.set(user.stream.id, source)
        } catch (e) {
          console.error(`Failed to add remote stream ${user.stream.id} to mix:`, e)
        }
      }
    }
    // Screen stream
    if (user.screenStream && user.screenStream.getAudioTracks().length > 0) {
      activeStreamIds.add(user.screenStream.id)
      if (!remoteAudioSources.has(user.screenStream.id)) {
        try {
          const source = recordingAudioContext!.createMediaStreamSource(user.screenStream)
          source.connect(recordingDestination!)
          remoteAudioSources.set(user.screenStream.id, source)
        } catch (e) {
          console.error(`Failed to add remote screen stream ${user.screenStream.id} to mix:`, e)
        }
      }
    }
  })

  // 2. Remove stale sources
  for (const [streamId, source] of remoteAudioSources.entries()) {
    if (!activeStreamIds.has(streamId)) {
      try {
        source.disconnect()
      } catch (e) {
        console.warn(`Failed to disconnect source ${streamId}:`, e)
      }
      remoteAudioSources.delete(streamId)
    }
  }
}

const startRecording = async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    })

    // 2. 准备混音环境
    recordingAudioContext = getSharedAudioContext()
    recordingDestination = recordingAudioContext.createMediaStreamDestination()

    // 3. 将麦克风接入混音器
    if (localStream.value!.getAudioTracks().length > 0) {
      const micSource = recordingAudioContext.createMediaStreamSource(localStream.value!)
      // 可以在这里加个增益节点把麦克风声音放大点 **但是会增加啸叫可能
      // const gainNode = recordingAudioContext.createGain(); gainNode.gain.value = 1.2;
      // micSource.connect(gainNode).connect(recordingDestination);
      micSource.connect(recordingDestination)
    }

    // 4. 将系统音频（如果有）接入混音器
    if (stream.getAudioTracks().length > 0) {
      const sysSource = recordingAudioContext.createMediaStreamSource(stream)
      sysSource.connect(recordingDestination)
    }

    // 5. 将远端音频接入混音器
    updateAudioMix()
    stopMixingWatcher = watch(
      users,
      () => {
        updateAudioMix()
      },
      { deep: true },
    )

    // 6. 【核心】组装最终的录制流
    // 视频来自屏幕共享，音频来自混音器的结果
    const finalStream = new MediaStream([
      ...stream.getVideoTracks(), // 视频轨道
      ...recordingDestination.stream.getAudioTracks(), // 混合后的音频轨道
    ])

    // 在创建 MediaRecorder 时尝试不同的 mimeType **不管用，不过还是留着吧
    const mimeTypes = [
      'video/webm;codecs=av1', // 最优，如果浏览器支持
      'video/webm;codecs=vp9', // 次选，通常支持较好
      'video/webm;codecs=h265', // 再次
      'video/mp4', // Chrome 新版支持 mp4 录制
    ]

    const options = { mimeType: 'video/mp4' }
    for (const mime of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mime)) {
        options.mimeType = mime
        console.log(`Using codec: ${mime}`)
        break
      }
    }

    mediaRecorder = new MediaRecorder(finalStream, options)
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunks.push(e.data)
      }
    }
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: options.mimeType })
      recordedChunks = []
      processRecording(blob)
      // Cleanup happens in stopRecording
    }

    mediaRecorder.start()
    isRecording.value = true

    const videoTrack = stream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.onended = () => {
        if (isRecording.value) stopRecording()
      }
    }
  } catch (e) {
    console.error('Start recording failed', e)
  }
}

const stopRecording = () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  isRecording.value = false

  // Cleanup watcher
  if (stopMixingWatcher) {
    stopMixingWatcher()
    stopMixingWatcher = null
  }

  // Cleanup audio sources
  remoteAudioSources.forEach((source) => {
    try {
      source.disconnect()
    } catch (e) {
      console.warn('Error disconnecting source:', e)
    }
  })
  remoteAudioSources.clear()

  // Cleanup audio context
  if (recordingAudioContext) {
    // Do not close shared context
    // recordingAudioContext.close()
    recordingAudioContext = null
    recordingDestination = null
  }
}

const processRecording = async (blob: Blob) => {
  const downloadVideo = () => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `meeting-recording-${Date.now()}.webm`
    a.click()
  }

  const savedConfig = localStorage.getItem('llm_config')
  if (!savedConfig) {
    downloadVideo()
    return
  }

  const config = JSON.parse(savedConfig) as LLMConfig
  if (!config.sttApiKey && !config.llmApiKey) {
    downloadVideo()
    return
  }

  if (confirm(t('recording.complete'))) {
    downloadVideo()

    try {
      const confirmStart = confirm(t('recording.convertConfirm'))
      if (!confirmStart) return

      // Convert to MP3
      alert(t('recording.converting'))
      const { convertWebMToMp3 } = await import('@/utils/audioConverter')
      const mp3Blob = await convertWebMToMp3(blob)

      // Download MP3
      const mp3Url = URL.createObjectURL(mp3Blob)
      const a = document.createElement('a')
      a.href = mp3Url
      a.download = `meeting-audio-${Date.now()}.mp3`
      a.click()

      const { text } = await transcribeAudio(mp3Blob, config)

      // 简单显示转录结果提示
      console.log('Transcription:', text)

      const summaryRes = await summarizeText(text, config)
      const summary = summaryRes.choices[0].message.content

      // 下载摘要
      const summaryBlob = new Blob([summary], { type: 'text/markdown' })
      const url = URL.createObjectURL(summaryBlob)
      const a2 = document.createElement('a')
      a2.href = url
      a2.download = `meeting-summary-${Date.now()}.md`
      a2.click()

      alert(t('recording.summaryDone'))
    } catch (e: unknown) {
      console.error(e)
      alert(t('recording.aiFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  } else {
    downloadVideo()
  }
}

const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault()
}

const updateFullscreenStatus = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = document as any
  isFullscreen.value = !!(doc.fullscreenElement || doc.webkitFullscreenElement)
}

// Lifecycle
onMounted(() => {
  if (!userName) {
    router.replace({ path: '/', query: { code: roomId } })
    return
  }

  window.addEventListener('beforeunload', handleBeforeUnload)
  document.addEventListener('fullscreenchange', updateFullscreenStatus)
  document.addEventListener('webkitfullscreenchange', updateFullscreenStatus)

  // 没什么必要，这提示也不要了
  // if (isMobile.value) {
  //   setTimeout(() => alert('移动端功能受限：无法屏幕共享和录制'), 1000)
  // }

  init()
})

watch(
  () => socket.value,
  (newSocket) => {
    if (newSocket) {
      newSocket.on('chat-message', (data: ChatMessageData) => {
        let senderName = t('room.unknownUser')
        if (users.has(data.senderId)) {
          senderName = users.get(data.senderId)!.name
        }

        const msg: ChatMessage = {
          id: Date.now(),
          senderId: data.senderId,
          senderName: senderName,
          content: data.message,
          timestamp: data.timestamp,
          isSelf: false,
        }

        chatMessages.value.push(msg)
        showQuickMessage(senderName, data.message)
      })

      // 初始化同传 socket 监听
      setupInterpretationListeners()
    }
  },
)

// 当远端用户流变化时（如对方开麦），重新应用同传静音
watch(
  users,
  () => {
    reapplyInterpretationMutes()
  },
  { deep: true },
)

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  document.removeEventListener('fullscreenchange', updateFullscreenStatus)
  document.removeEventListener('webkitfullscreenchange', updateFullscreenStatus)
  stopAllInterpretation()
  closeSharedAudioContext()
})
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.5s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
