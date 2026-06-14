type Message = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type ChatRequest = {
  apiKey: string
  model: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  signal?: AbortSignal
}

export async function callOpenRouter({
  apiKey,
  model,
  messages,
  temperature = 0.35,
  maxTokens = 1800,
  jsonMode = false,
  signal,
}: ChatRequest) {
  const response = await fetch('/api/openrouter/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apiKey,
      model,
      messages,
      temperature,
      maxTokens,
      jsonMode,
    }),
    signal,
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(error?.error ?? `Falha na OpenRouter: HTTP ${response.status}`)
  }

  const data = (await response.json()) as { content?: string }

  if (!data.content) {
    throw new Error('A OpenRouter retornou uma resposta vazia.')
  }

  return data.content
}
