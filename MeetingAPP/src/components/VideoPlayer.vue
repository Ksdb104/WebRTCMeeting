<template>
  <div
    class="relative w-full h-full bg-slate-900 rounded-xl overflow-hidden group border border-white/5"
    @dblclick="toggleMode"
  >
    <video
      ref="videoRef"
      autoplay
      playsinline
      webkit-playsinline
      :muted="muted"
      class="w-full h-full"
      :class="[isFillMode ? 'object-cover' : 'object-contain']"
    ></video>

    <!-- 用户名标签 -->
    <div
      class="absolute bottom-3 left-3 bg-black/60 px-2 py-1.5 rounded-lg text-xs text-white flex items-center gap-2 backdrop-blur-sm shadow-lg z-10"
      v-if="!isMobile || !pipMode"
    >
      <span class="font-medium truncate max-w-30">{{ name }}</span>
      <MicOff v-if="!micOpen" class="w-3 h-3 text-red-400" />
      <div v-else class="relative w-3 h-3 flex items-center justify-center">
        <Mic class="w-3 h-3 text-green-400 relative z-10" />
        <!-- 声音电平 -->
        <div
          class="absolute inset-0 bg-green-500/50 rounded-full blur-[2px] transition-transform duration-75"
          :style="{ transform: `scale(${1 + audioLevel / 20})`, opacity: audioLevel > 5 ? 0.8 : 0 }"
        ></div>
      </div>
    </div>

    <!-- 不好看，去掉 -->
    <!-- <div
      class="absolute bottom-3 right-3 bg-black/60 px-1.5 py-1.5 rounded-lg text-xs text-white flex items-center gap-2 backdrop-blur-sm shadow-lg z-10"
      v-if="hasVideo"
    >
      <span class="font-medium truncate max-w-30">双击切换显示模式</span>
    </div> -->

    <!-- 没有视频信号时显示头像 -->
    <div
      v-if="!hasVideo"
      class="absolute inset-0 flex items-center justify-center bg-slate-800 z-0"
    >
      <div
        class="w-20 h-20 rounded-full bg-linear-to-br from-blue-500 to-purple-600 flex items-center justify-center text-3xl font-bold text-white shadow-xl"
      >
        {{ name.charAt(0).toUpperCase() }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { MicOff, Mic } from 'lucide-vue-next'
import { getSharedAudioContext } from '@/utils/globalAudio'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'
const deviceStore = useDeviceStore()
const { isAPPLE, isMobile } = storeToRefs(deviceStore)

const props = defineProps<{
  stream?: MediaStream
  name: string
  muted?: boolean
  micOpen?: boolean
  camOpen?: boolean
  sreenStream?: boolean
  mirror?: boolean
  pipMode?: boolean
  disableDbClick?: boolean
}>()

const isFillMode = ref(false)

const toggleMode = () => {
  if (props.disableDbClick) return
  isFillMode.value = !isFillMode.value
}

const videoRef = ref<HTMLVideoElement | null>(null)
const audioLevel = ref(0) // 0-100
const trackVersion = ref(0) // 用于强制更新 computed

const hasVideo = computed(() => {
  // 依赖 trackVersion 以在 track 变化时更新
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  trackVersion.value

  // 1. 摄像头关闭，关闭video显示
  if (props.camOpen === false && !props.sreenStream) return false
  // 2. 检查其他流是否有效
  return (
    props.stream &&
    props.stream.getVideoTracks().length > 0 &&
    props.stream.getVideoTracks()[0]!.enabled &&
    props.stream.getVideoTracks()[0]!.readyState === 'live'
  )
})

// 音频分析
let analyser: AnalyserNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let animationId: number | null = null

const setupAudioAnalysis = (stream: MediaStream) => {
  if (stream.getAudioTracks().length === 0) return

  try {
    const audioContext = getSharedAudioContext()
    source = audioContext.createMediaStreamSource(stream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)

    const dataArray = new Uint8Array(analyser.frequencyBinCount)

    const update = () => {
      if (!analyser) return
      analyser.getByteFrequencyData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i]!
      }
      const average = sum / dataArray.length
      audioLevel.value = Math.min(average * 2, 100)

      animationId = requestAnimationFrame(update)
    }
    update()
  } catch (e) {
    console.error('Audio analysis setup failed:', e)
  }
}

const cleanupAudio = () => {
  if (animationId) cancelAnimationFrame(animationId)

  if (source) {
    try {
      source.disconnect()
    } catch (e) {
      console.warn('Error disconnecting source:', e)
    }
    source = null
  }

  if (analyser) {
    try {
      analyser.disconnect()
    } catch (e) {
      console.warn('Error disconnecting analyser:', e)
    }
    analyser = null
  }
}

// 监听轨道变化（防抖处理）
let trackChangeTimeout: number | null = null
const handleTrackChange = () => {
  trackVersion.value++
  if (trackChangeTimeout) clearTimeout(trackChangeTimeout)
  trackChangeTimeout = window.setTimeout(() => {
    if (props.stream) {
      cleanupAudio()
      setupAudioAnalysis(props.stream)
    }
  }, 200)
}

watch(
  () => props.stream,
  (newStream, oldStream) => {
    if (oldStream) {
      oldStream.removeEventListener('addtrack', handleTrackChange)
      oldStream.removeEventListener('removetrack', handleTrackChange)
    }

    if (videoRef.value) {
      if (newStream) {
        setTimeout(() => {
          videoRef.value!.srcObject = newStream
          if (isAPPLE.value) {
            // iOS Safari 即使有 autoplay 也经常需要显式调用 play()
            videoRef.value!.play().catch((e) => {
              console.warn('Video play failed (expected on iOS without interaction):', e)
            })
          }
        }, 100)
      } else {
        videoRef.value.srcObject = null
      }
    }

    cleanupAudio()
    if (newStream) {
      newStream.addEventListener('addtrack', handleTrackChange)
      newStream.addEventListener('removetrack', handleTrackChange)
      setupAudioAnalysis(newStream)
    }
  },
  { immediate: true },
)

// 监听 micOpen 变化，重新初始化音频分析 (针对远端流引用不变但轨道变化的情况)
watch(
  () => props.micOpen,
  (isOpen) => {
    if (isOpen && props.stream) {
      // 稍微延迟确保 track 已经 ready
      setTimeout(() => {
        cleanupAudio()
        if (props.stream) setupAudioAnalysis(props.stream)
      }, 100)
    } else if (!isOpen) {
      cleanupAudio()
    }
  },
)

onMounted(() => {
  if (videoRef.value && props.stream) {
    videoRef.value.srcObject = props.stream
    if (isAPPLE.value) {
      // iOS Safari 即使有 autoplay 也经常需要显式调用 play()
      videoRef.value!.play().catch((e) => {
        console.warn('Video play failed (expected on iOS without interaction):', e)
      })
    }
  }
  if (props.stream) {
    setupAudioAnalysis(props.stream)
  }
})

onUnmounted(() => {
  cleanupAudio()
})
</script>
