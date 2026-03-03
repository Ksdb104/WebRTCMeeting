let audioContext: AudioContext | null = null

export const getSharedAudioContext = (): AudioContext => {
  if (!audioContext || audioContext.state === 'closed') {
    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audioContext = new AudioContextClass()
  }
  // 尝试恢复 suspend 状态
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch((e) => console.warn('AudioContext resume failed:', e))
  }
  return audioContext
}

export const closeSharedAudioContext = () => {
  if (audioContext) {
    audioContext.close().catch(console.error)
    audioContext = null
  }
}
