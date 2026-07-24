export {}

interface AudioWorkletProcessorInstance {
  readonly port: MessagePort
}

declare const AudioWorkletProcessor: {
  new (): AudioWorkletProcessorInstance
}

declare function registerProcessor(
  name: string,
  processorConstructor: new () => AudioWorkletProcessorInstance,
): void

const CAPTURE_CHUNK_SIZE = 4096

class InterpretationPcmCaptureProcessor extends AudioWorkletProcessor {
  private chunk = new Float32Array(CAPTURE_CHUNK_SIZE)
  private chunkOffset = 0

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    if (!input) return true

    let inputOffset = 0
    while (inputOffset < input.length) {
      const copyLength = Math.min(CAPTURE_CHUNK_SIZE - this.chunkOffset, input.length - inputOffset)
      this.chunk.set(input.subarray(inputOffset, inputOffset + copyLength), this.chunkOffset)
      this.chunkOffset += copyLength
      inputOffset += copyLength

      if (this.chunkOffset === CAPTURE_CHUNK_SIZE) {
        const completedChunk = this.chunk
        this.port.postMessage(completedChunk, [completedChunk.buffer])
        this.chunk = new Float32Array(CAPTURE_CHUNK_SIZE)
        this.chunkOffset = 0
      }
    }

    return true
  }
}

registerProcessor('interpretation-pcm-capture', InterpretationPcmCaptureProcessor)
