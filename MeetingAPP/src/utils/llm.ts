export interface LLMConfig {
  // STT (Speech to Text)
  sttBaseUrl: string
  sttApiKey: string
  sttModel: string

  // LLM (Summary)
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
}

export const defaultPresets = [
  {
    name: 'OpenAI (Default)',
    sttBaseUrl: 'https://api.openai.com/v1/audio/transcriptions',
    sttModel: 'whisper-1',
    llmBaseUrl: 'https://api.openai.com/v1/chat/completions',
    llmModel: 'gpt-4o',
  },
  {
    name: 'Groq (Fast)',
    sttBaseUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
    sttModel: 'whisper-large-v3',
    llmBaseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    llmModel: 'llama3-8b-8192',
  },
]

export async function transcribeAudio(blob: Blob, config: LLMConfig) {
  const formData = new FormData()
  formData.append('file', blob, 'recording.mp3') // 这里假设已经转为 mp3
  formData.append('model', config.sttModel)

  const res = await fetch(`${config.sttBaseUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.sttApiKey || config.llmApiKey}`, // Fallback to llmKey if sttKey empty
    },
    body: formData,
  })

  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`Transcription failed: ${errorText}`)
  }
  return await res.json()
}

export async function summarizeText(text: string, config: LLMConfig) {
  const res = await fetch(`${config.llmBaseUrl}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [
        {
          role: 'system',
          content:
            '你是专业的会议记录员。请将以下会议录音转录文本进行归纳总结，提取关键点和行动项，并使用 Markdown 格式输出。',
        },
        { role: 'user', content: text },
      ],
    }),
  })

  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`Summarization failed: ${errorText}`)
  }
  return await res.json()
}
