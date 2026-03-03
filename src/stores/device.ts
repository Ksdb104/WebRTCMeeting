import { defineStore } from 'pinia'
import { computed } from 'vue'

export const useDeviceStore = defineStore('device', () => {
  const userAgent = navigator.userAgent

  const isMobile = computed(() => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)
  })

  //不包含macOS和ipadOS
  const isIOS = computed(() => {
    return /iPhone|iPod/.test(userAgent)
  })

  const isAPPLE = computed(() => {
    return /iPhone|iPod|iPad|Macintosh/i.test(userAgent)
  })

  return {
    isMobile,
    isIOS,
    isAPPLE,
  }
})
