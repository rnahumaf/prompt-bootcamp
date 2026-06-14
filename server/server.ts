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
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(12000).optional(),
  jsonMode: z.boolean().optional(),
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

  const { apiKey, model, messages, temperature = 0.35, maxTokens = 1800, jsonMode = false } = parsed.data

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
        'X-Title': 'Prompt Bootcamp',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    })

    const payload = (await upstream.json().catch(() => null)) as
      | {
          choices?: Array<{ message?: { content?: string } }>
          error?: { message?: string }
        }
      | null

    if (!upstream.ok) {
      response.status(upstream.status).json({
        error: payload?.error?.message ?? `OpenRouter retornou HTTP ${upstream.status}.`,
      })
      return
    }

    const content = payload?.choices?.[0]?.message?.content

    if (!content) {
      response.status(502).json({ error: 'OpenRouter retornou uma resposta sem conteúdo.' })
      return
    }

    response.json({ content })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Falha desconhecida ao chamar a OpenRouter.',
    })
  }
})

app.listen(PORT, () => {
  console.log(`Prompt Bootcamp API em http://localhost:${PORT}`)
})
