<template>
  <div
    v-if="modelValue"
    class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm"
  >
    <div
      class="bg-slate-900 border border-white/20 p-6 rounded-2xl w-full max-w-md text-white shadow-2xl"
    >
      <h2 class="text-xl font-bold mb-6 flex items-center gap-2">
        <Settings class="w-5 h-5 text-blue-400" />
        会议归纳设置 (LLM)
      </h2>

      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1 uppercase tracking-wider">预设配置</label>
          <select
            v-model="localSelectedPresetIndex"
            @change="applyPreset"
            class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          >
            <option v-for="(preset, index) in defaultPresets" :key="index" :value="index">
              {{ preset.name }}
            </option>
            <option :value="-1">自定义</option>
          </select>
        </div>

        <div>
          <div class="pb-2">
            <label class="block text-xs text-gray-400 mb-1 uppercase tracking-wider"
              >STT Base URL</label
            >
            <input
              v-model="localConfig.sttBaseUrl"
              type="text"
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1 uppercase tracking-wider"
              >LLM Base URL</label
            >
            <input
              v-model="localConfig.llmBaseUrl"
              type="text"
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
        </div>

        <div>
          <div class="pb-2">
            <label class="block text-xs text-gray-400 mb-1 uppercase tracking-wider"
              >STT API Key (可选)</label
            >
            <input
              v-model="localConfig.sttApiKey"
              type="password"
              placeholder="若空则用LLM Key"
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1 uppercase tracking-wider"
              >LLM API Key</label
            >
            <input
              v-model="localConfig.llmApiKey"
              type="password"
              placeholder="sk-..."
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1 uppercase tracking-wider"
              >STT Model</label
            >
            <input
              v-model="localConfig.sttModel"
              type="text"
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1 uppercase tracking-wider"
              >LLM Model</label
            >
            <input
              v-model="localConfig.llmModel"
              type="text"
              class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
        </div>
      </div>

      <div class="mt-8 flex justify-end gap-3">
        <button
          @click="close"
          class="px-4 py-2 hover:bg-white/10 rounded-lg text-sm transition-colors cursor-pointer"
        >
          取消
        </button>
        <button
          @click="save"
          class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-blue-500/20 cursor-pointer"
        >
          保存配置
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, reactive } from 'vue'
import { Settings } from 'lucide-vue-next'
import { defaultPresets, type LLMConfig } from '@/utils/llm'

interface Props {
  modelValue: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  save: [config: LLMConfig, presetIndex: number]
}>()

const localSelectedPresetIndex = ref(0)
const localConfig = reactive<LLMConfig>({
  sttBaseUrl: defaultPresets[0]!.sttBaseUrl,
  sttApiKey: '',
  sttModel: defaultPresets[0]!.sttModel,
  llmBaseUrl: defaultPresets[0]!.llmBaseUrl,
  llmApiKey: '',
  llmModel: defaultPresets[0]!.llmModel,
})

// 加载保存的配置
const loadSettings = () => {
  const savedConfig = localStorage.getItem('llm_config')
  const savedIndex = localStorage.getItem('llm_preset_index')

  if (savedConfig) {
    Object.assign(localConfig, JSON.parse(savedConfig))
  }

  if (savedIndex !== null) {
    localSelectedPresetIndex.value = Number(savedIndex)
  } else if (savedConfig) {
    localSelectedPresetIndex.value = -1
  }
}

// 监听模态框打开，加载配置
watch(
  () => props.modelValue,
  (newValue) => {
    if (newValue) {
      loadSettings()
    }
  },
)

const applyPreset = () => {
  if (localSelectedPresetIndex.value >= 0) {
    const preset = defaultPresets[localSelectedPresetIndex.value]
    if (preset) {
      localConfig.sttBaseUrl = preset.sttBaseUrl
      localConfig.sttModel = preset.sttModel
      localConfig.llmBaseUrl = preset.llmBaseUrl
      localConfig.llmModel = preset.llmModel
    }
  }
}

const close = () => {
  emit('update:modelValue', false)
}

const save = () => {
  localStorage.setItem('llm_config', JSON.stringify(localConfig))
  localStorage.setItem('llm_preset_index', String(localSelectedPresetIndex.value))
  emit('save', { ...localConfig }, localSelectedPresetIndex.value)
  close()
}
</script>
