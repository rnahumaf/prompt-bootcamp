import { diffLines } from 'diff'
import { callOpenRouter } from './openrouter'
import { parseJsonObject } from './json'
import type { PromptPatch, PromptRevision, PromptTrainingConfig, TrainingTurnHistory } from '../types'

type RevisionPayload = {
  prompt?: string
  rationale?: string
  patches?: PromptPatch[]
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && /abort|interrompida/i.test(error.message))
  )
}

export function applyPatches(prompt: string, patches: PromptPatch[]): string {
  let updatedPrompt = prompt

  for (const patch of patches) {
    const findText = patch.find.trim()
    const replaceText = patch.replace.trim()

    if (!findText) continue

    if (updatedPrompt.includes(findText)) {
      updatedPrompt = updatedPrompt.replace(findText, replaceText)
      continue
    }

    const escapedFind = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const regex = new RegExp(escapedFind, 'm')

    if (regex.test(updatedPrompt)) {
      updatedPrompt = updatedPrompt.replace(regex, replaceText)
      continue
    }

    throw new Error(`Trecho a substituir não encontrado no prompt atual: "${findText.slice(0, 120)}"`)
  }

  return updatedPrompt
}

export function buildDiff(before: string, after: string) {
  return diffLines(before, after)
    .map((part) => {
      const prefix = part.added ? '+ ' : part.removed ? '- ' : '  '
      return part.value
        .split('\n')
        .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
        .map((line) => `${prefix}${line}`)
        .join('\n')
    })
    .filter(Boolean)
    .join('\n')
}

function summarizeHistory(history: TrainingTurnHistory[]) {
  if (history.length === 0) {
    return 'Nenhum turno anterior.'
  }

  return history
    .slice(-8)
    .map((turn) => {
      const parts = [
        `TURNO ${turn.turn}`,
        turn.input ? `INPUT USADO:\n${turn.input}` : 'SEM INPUT EXTERNO',
        `OUTPUT GERADO:\n${turn.output}`,
      ]

      if (turn.editedOutput?.trim()) {
        parts.push(`CORREÇÃO ESCRITA PELO USUÁRIO:\n${turn.editedOutput}`)
      }

      if (turn.comment?.trim()) {
        parts.push(`COMENTÁRIO DO USUÁRIO:\n${turn.comment}`)
      }

      if (turn.rationale?.trim()) {
        parts.push(`AJUSTE APLICADO:\n${turn.rationale}`)
      }

      return parts.join('\n\n')
    })
    .join('\n\n---\n\n')
}

export async function generatePromptOutput(
  config: PromptTrainingConfig,
  input: string | undefined,
  signal?: AbortSignal,
) {
  const userMessage = input?.trim()
    ? input.trim()
    : `Execute a tarefa definida no system prompt.

Crie internamente um caso/input realista e desafiador se o prompt precisar de contexto para funcionar.
Entregue somente o output final que o prompt produziria, sem explicar o input criado e sem comentar o processo.`

  return callOpenRouter({
    apiKey: config.apiKey,
    model: config.model,
    sessionId: config.sessionId,
    temperature: 0.35,
    maxTokens: 2400,
    label: 'gerador: output',
    signal,
    messages: [
      {
        role: 'system',
        content: config.prompt,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
  })
}

export async function revisePromptFromFeedback(
  config: PromptTrainingConfig,
  feedback: {
    output: string
    input?: string
    editedOutput?: string
    comment?: string
  },
  history: TrainingTurnHistory[],
  signal?: AbortSignal,
): Promise<PromptRevision> {
  let lastError: Error | null = null
  let lastRawContent = ''

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repairInstruction = attempt > 1
      ? `\n\nSua resposta anterior falhou ao ser processada.\nERRO:\n${lastError?.message ?? 'Erro desconhecido'}\n\nRESPOSTA ANTERIOR:\n${lastRawContent}\n\nCorrija e responda somente JSON válido.`
      : ''

    try {
      const content = await callOpenRouter({
        apiKey: config.apiKey,
        model: config.model,
        sessionId: config.sessionId,
        temperature: attempt === 1 ? 0.2 : 0,
        maxTokens: 7000,
        jsonMode: true,
        label: `otimizador: patch ${attempt}`,
        signal,
        messages: [
          {
            role: 'system',
            content:
              'Você é um otimizador de system prompts. Sua única tarefa é melhorar o prompt com base no feedback humano. Responda somente JSON válido.',
          },
          {
            role: 'user',
            content: `SYSTEM PROMPT ATUAL:
\`\`\`md
${config.prompt}
\`\`\`

DESCRIÇÃO DA TAREFA:
${config.taskInstructions}

HISTÓRICO RECENTE:
${summarizeHistory(history)}

ÚLTIMO CASO:
${feedback.input ? `INPUT USADO:\n\`\`\`txt\n${feedback.input}\n\`\`\`` : 'SEM INPUT EXTERNO: o output foi gerado a partir do próprio prompt.'}

OUTPUT GERADO:
\`\`\`txt
${feedback.output}
\`\`\`

${feedback.editedOutput?.trim() ? `CORREÇÃO ESCRITA PELO USUÁRIO:\n\`\`\`txt\n${feedback.editedOutput.trim()}\n\`\`\`` : ''}

${feedback.comment?.trim() ? `COMENTÁRIO DO USUÁRIO:\n\`\`\`txt\n${feedback.comment.trim()}\n\`\`\`` : ''}

Aplique um patch cirúrgico no SYSTEM PROMPT ATUAL para evitar esse erro nas próximas gerações.

Regras:
- Não crie notas, placares, rankings nem processo competitivo.
- Não adicione instruções sobre este protocolo de JSON ao prompt final.
- Preserve a intenção original do prompt e altere só o necessário.
- Prefira "patches" com trechos exatos de find/replace.
- Se um patch não for viável, retorne o prompt completo em "prompt".

Responda estritamente neste formato:
{
  "rationale": "explicação curta da mudança",
  "patches": [
    {
      "find": "trecho exato do prompt atual",
      "replace": "novo trecho"
    }
  ]
}

Formato alternativo aceito:
{
  "rationale": "explicação curta da mudança",
  "prompt": "system prompt completo atualizado"
}${repairInstruction}`,
          },
        ],
      })

      lastRawContent = content
      const parsed = parseJsonObject<RevisionPayload>(content)
      const revisedPrompt = normalizeRevisionPrompt(config.prompt, parsed)

      return {
        prompt: revisedPrompt,
        rationale: parsed.rationale?.trim() || 'Prompt ajustado com base no feedback humano.',
        diff: buildDiff(config.prompt, revisedPrompt),
        patches: parsed.patches,
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      lastError = error instanceof Error ? error : new Error('Falha desconhecida ao revisar prompt.')
    }
  }

  throw lastError ?? new Error('O otimizador não retornou um prompt válido.')
}

function normalizeRevisionPrompt(currentPrompt: string, parsed: RevisionPayload) {
  if (parsed.patches?.length) {
    const patched = applyPatches(currentPrompt, parsed.patches).trim()
    validatePromptUpdate(currentPrompt, patched)
    return patched
  }

  if (parsed.prompt?.trim()) {
    const prompt = parsed.prompt.trim()
    validatePromptUpdate(currentPrompt, prompt)
    return prompt
  }

  throw new Error('O otimizador não retornou patches nem prompt completo.')
}

function validatePromptUpdate(previousPrompt: string, nextPrompt: string) {
  if (!nextPrompt.trim()) {
    throw new Error('O prompt revisado ficou vazio.')
  }

  const lowerPrompt = nextPrompt.toLowerCase()
  const lowerPrevious = previousPrompt.toLowerCase()
  const protocolTerms = ['objeto json', 'json válido', 'patches', 'find', 'replace', 'nota média', 'placar automático']

  for (const term of protocolTerms) {
    if (lowerPrompt.includes(term) && !lowerPrevious.includes(term)) {
      throw new Error(`O prompt revisado parece conter instruções internas do treino ("${term}").`)
    }
  }

  if (previousPrompt.length > 500 && nextPrompt.length < previousPrompt.length * 0.45) {
    throw new Error('O prompt revisado ficou curto demais em relação ao prompt atual.')
  }
}
