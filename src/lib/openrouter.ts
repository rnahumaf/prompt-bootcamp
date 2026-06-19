type Message = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type ChatRequest = {
  apiKey: string
  model: string
  sessionId?: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  label?: string
  maxAttempts?: number
  signal?: AbortSignal
}

type ApiError = {
  error?: string
  retryable?: boolean
  details?: Record<string, unknown>
}

class OpenRouterCallError extends Error {
  status: number
  retryable: boolean

  constructor(message: string, status: number, retryable: boolean) {
    super(message)
    this.name = 'OpenRouterCallError'
    this.status = status
    this.retryable = retryable
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Execução interrompida pelo usuário.', 'AbortError'))
      return
    }

    const timeout = window.setTimeout(resolve, ms)

    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout)
        reject(new DOMException('Execução interrompida pelo usuário.', 'AbortError'))
      },
      { once: true },
    )
  })
}

export async function callOpenRouter(request: ChatRequest) {
  const maxAttempts = request.maxAttempts ?? 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callOpenRouterOnce(request, attempt)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }

      lastError = error instanceof Error ? error : new Error('Falha desconhecida na chamada.')
      const retryable = error instanceof OpenRouterCallError ? error.retryable : false

      if (!retryable || attempt === maxAttempts) {
        throw lastError
      }

      const jitter = Math.random() * 800
      await sleep(1000 * attempt + jitter, request.signal)
    }
  }

  throw lastError ?? new Error('Falha desconhecida na chamada.')
}

async function callOpenRouterOnce({
  apiKey,
  model,
  sessionId,
  messages,
  temperature = 0.35,
  maxTokens = 1800,
  jsonMode = false,
  label = 'chamada',
  signal,
}: ChatRequest, attempt: number) {
  const response = await fetch('/api/openrouter/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apiKey,
      model,
      sessionId,
      messages,
      temperature,
      maxTokens,
      jsonMode,
      label,
      attempt,
    }),
    signal,
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiError | null
    const retryable = Boolean(error?.retryable ?? (response.status === 429 || response.status >= 500))
    throw new OpenRouterCallError(
      `${label}: ${error?.error ?? `Falha na OpenRouter: HTTP ${response.status}`}`,
      response.status,
      retryable,
    )
  }

  const data = (await response.json()) as { content?: string }

  if (!data.content) {
    throw new OpenRouterCallError(`${label}: a OpenRouter retornou uma resposta vazia.`, 502, true)
  }

  return data.content
}
