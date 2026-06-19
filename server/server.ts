import express from 'express'
import { z } from 'zod'

const PORT = Number(process.env.PORT ?? 8787)

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
})

const ChatSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
  sessionId: z.string().min(1).max(256).optional(),
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(12000).optional(),
  jsonMode: z.boolean().optional(),
  label: z.string().max(120).optional(),
  attempt: z.number().int().min(1).max(10).optional(),
})

const app = express()

app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true })
})

app.post('/api/openrouter/chat', async (request, response) => {
  const parsed = ChatSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') })
    return
  }

  const {
    apiKey,
    model,
    sessionId,
    messages,
    temperature = 0.35,
    maxTokens = 1800,
    jsonMode = false,
    label = 'chamada',
  } = parsed.data

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
        'X-Title': 'Prompt Bootcamp',
        ...(sessionId ? { 'x-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        model,
        ...(sessionId ? { session_id: sessionId } : {}),
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        provider: {
          require_parameters: true,
        },
      }),
    })

    const payload = (await upstream.json().catch(() => null)) as
      | {
          choices?: Array<{ finish_reason?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } }>
          error?: { message?: string }
          provider?: string
        }
      | null

    if (!upstream.ok) {
      response.status(upstream.status).json({
        error: `${label}: ${payload?.error?.message ?? `OpenRouter retornou HTTP ${upstream.status}.`}`,
        retryable: upstream.status === 429 || upstream.status >= 500,
      })
      return
    }

    const messageContent = payload?.choices?.[0]?.message?.content
    const content = Array.isArray(messageContent)
      ? messageContent
          .map((part) => part.text ?? '')
          .join('')
          .trim()
      : messageContent?.trim()

    if (!content) {
      response.status(502).json({
        error: `${label}: OpenRouter retornou uma resposta sem conteúdo.`,
        retryable: true,
        details: {
          choices: payload?.choices?.length ?? 0,
          finishReason: payload?.choices?.[0]?.finish_reason ?? null,
          provider: payload?.provider ?? null,
        },
      })
      return
    }

    response.json({ content })
  } catch (error) {
    response.status(502).json({
      error: `${label}: ${error instanceof Error ? error.message : 'Falha desconhecida ao chamar a OpenRouter.'}`,
      retryable: true,
    })
  }
})

app.listen(PORT, () => {
  console.log(`Prompt Bootcamp API em http://localhost:${PORT}`)
})
