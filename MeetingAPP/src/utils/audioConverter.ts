// @ts-expect-error lamejs types are missing
import lamejs from 'lamejs'

export async function convertWebMToMp3(webmBlob: Blob): Promise<Blob> {
  const arrayBuffer = await webmBlob.arrayBuffer()
  const AudioContextClass =
    window.AudioContext ||
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const audioContext = new AudioContextClass()
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

  const mp3Data = []
  const sampleRate = audioBuffer.sampleRate
  const channels = audioBuffer.numberOfChannels

  // 限制声道数
  const encodingChannels = channels > 1 ? 2 : 1
  const mp3encoder = new lamejs.Mp3Encoder(encodingChannels, sampleRate, 128)

  const samplesLeft = audioBuffer.getChannelData(0)
  const samplesRight = channels > 1 ? audioBuffer.getChannelData(1) : null

  // Float32 -> Int16
  const convertBuffer = (buffer: Float32Array) => {
    const l = buffer.length
    const buf = new Int16Array(l)
    for (let i = 0; i < l; i++) {
      const val = buffer[i] || 0
      const s = Math.max(-1, Math.min(1, val))
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return buf
  }

  const pcmLeft = convertBuffer(samplesLeft)
  const pcmRight = samplesRight ? convertBuffer(samplesRight) : undefined

  const sampleBlockSize = 1152

  for (let i = 0; i < pcmLeft.length; i += sampleBlockSize) {
    const leftChunk = pcmLeft.subarray(i, i + sampleBlockSize)
    let mp3Buf

    if (encodingChannels === 2 && pcmRight) {
      const rightChunk = pcmRight.subarray(i, i + sampleBlockSize)
      mp3Buf = mp3encoder.encodeBuffer(leftChunk, rightChunk)
    } else {
      mp3Buf = mp3encoder.encodeBuffer(leftChunk)
    }

    if (mp3Buf.length > 0) {
      mp3Data.push(mp3Buf)
    }
  }

  const mp3Buf = mp3encoder.flush()
  if (mp3Buf.length > 0) {
    mp3Data.push(mp3Buf)
  }

  audioContext.close()

  return new Blob(mp3Data, { type: 'audio/mp3' })
}
