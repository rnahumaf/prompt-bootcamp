import { diffLines } from 'diff'
import { callOpenRouter } from './openrouter'
import { parseJsonObject } from './json'
import { collectAutoMetrics, emptyAutoMetrics, summarizeMetrics } from './metrics'
import type {
  BootcampConfig,
  Candidate,
  Evaluation,
  PromptResult,
  PromptRun,
  RunCriterionSuggestion,
} from '../types'
import { RUNS_PER_PROMPT } from '../types'

type Runtime = Pick<
  BootcampConfig,
  'apiKey' | 'model' | 'maxParallelRuns' | 'sessionId' | 'taskInstructions' | 'evaluationCriteria' | 'inputs'
>

type PatchPayload = {
  find: string
  replace: string
}

type CandidatePayload = {
  prompt?: string
  rationale?: string
  diff?: string
  patches?: PatchPayload[]
}

type EvaluationPayload = Partial<Evaluation>
type RunCriterionSuggestionPayload = Partial<Omit<RunCriterionSuggestion, 'runId'>>

function safeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && /abort|interrompida/i.test(error.message))
  )
}

function formatScore(result?: PromptResult) {
  if (!result) {
    return 'AINDA SEM NOTA, ESTE É O PRIMEIRO TURNO'
  }

  return JSON.stringify(
    {
      media: result.averageScore,
      minima: result.minScore,
      maxima: result.maxScore,
      falhasCriticas: result.criticalFailures,
    },
    null,
    2,
  )
}

export function applyPatches(prompt: string, patches: PatchPayload[]): string {
  let updatedPrompt = prompt

  for (const patch of patches) {
    const findText = patch.find.trim()
    const replaceText = patch.replace.trim()

    if (!findText) continue

    // 1. Tenta correspondência exata simples
    if (updatedPrompt.includes(findText)) {
      updatedPrompt = updatedPrompt.replace(findText, replaceText)
      continue
    }

    // 2. Se falhar, tenta normalizar espaços e quebras de linha usando regex
    const normalizeText = (txt: string) => txt.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
    const normalizedPrompt = normalizeText(updatedPrompt)
    const normalizedFind = normalizeText(findText)

    if (normalizedPrompt.includes(normalizedFind)) {
      // Escapa caracteres especiais de regex
      const escapedFind = findText
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+') // Permite qualquer tipo/quantidade de espaços/novas linhas

      const regex = new RegExp(escapedFind, 'm')
      if (regex.test(updatedPrompt)) {
        updatedPrompt = updatedPrompt.replace(regex, replaceText)
        continue
      }
    }

    // Se falhar de vez, lança erro descritivo
    throw new Error(`Trecho a substituir não encontrado no prompt atual. Copie exatamente o trecho caractere por caractere. Falhou ao buscar:\n"${findText.slice(0, 100)}..."`)
  }

  return updatedPrompt
}

function buildDiff(before: string, after: string) {
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

export async function createInitialPrompt(runtime: Runtime, signal?: AbortSignal) {
  const content = await callOpenRouter({
    apiKey: runtime.apiKey,
    model: runtime.model,
    sessionId: runtime.sessionId,
    temperature: 0.25,
    maxTokens: 2200,
    jsonMode: true,
    label: 'criador: prompt inicial',
    signal,
    messages: [
      {
        role: 'system',
        content:
          'Você é o CRIADOR, um especialista em criar system prompts robustos. Responda somente JSON válido.',
      },
      {
        role: 'user',
        content: `Crie um system prompt do zero para a tarefa abaixo.

TAREFA:
${runtime.taskInstructions}

CRITÉRIOS DE AVALIAÇÃO:
${runtime.evaluationCriteria}

INPUTS DE TESTE:
${runtime.inputs.map((input, index) => `[${index + 1}] ${input}`).join('\n\n')}

Responda neste formato JSON:
{
  "prompt": "system prompt completo em PT-BR",
  "rationale": "explicação curta do desenho do prompt"
}`,
      },
    ],
  })

  const parsed = await parseOrRepairCandidate(runtime, content, 'prompt inicial', signal)
  return parsed.prompt
}

function buildErrorDiagnostic(best: PromptResult): string {
  if (!best.runs || best.runs.length === 0) {
    return 'Nenhum run disponível para análise no turno anterior.'
  }

  // Filtrar os runs concluídos com avaliação válida
  const completedRuns = best.runs.filter(
    (run) => run.status === 'completed' && run.evaluation.status === 'ok'
  )

  if (completedRuns.length === 0) {
    return 'Nenhum run foi concluído com sucesso para análise de feedback.'
  }

  // Ordenamos de forma crescente pela nota (piores notas primeiro)
  const sortedRuns = [...completedRuns].sort((a, b) => a.evaluation.score - b.evaluation.score)
  
  // Selecionamos os 3 piores runs para diagnóstico
  const targetRuns = sortedRuns.slice(0, 3)

  return targetRuns
    .map((run, idx) => {
      const evalData = run.evaluation
      const failedCriteria = evalData.items
        .filter((item) => item.score < item.max)
        .map((item) => `- Critério: "${item.criterion}" | Pontuação: ${item.score}/${item.max} | Motivo: ${item.reason}`)
        .join('\n')

      const criticals = evalData.criticalFailures && evalData.criticalFailures.length > 0
        ? `- Falhas Críticas: ${evalData.criticalFailures.join('; ')}`
        : ''

      return `--- CASO DE FALHA OU PONTUAÇÃO BAIXA ${idx + 1} (Input de Teste #${run.inputIndex + 1}) ---
INPUT DE TESTE:
"""
${run.input}
"""

OUTPUT GERADO DO RUN:
"""
${run.output}
"""

DIAGNÓSTICO DA AVALIAÇÃO (Nota: ${evalData.score}/10):
${evalData.summary}
${criticals}
${failedCriteria ? `Critérios não atendidos:\n${failedCriteria}` : 'Todos os critérios individuais foram atendidos nesta execução.'}
`
    })
    .join('\n\n')
}

export async function createCandidatePrompt(
  runtime: Runtime,
  best: PromptResult,
  original: PromptResult,
  userInstruction: string,
  messagesHistory: { role: 'system' | 'user' | 'assistant'; content: string }[],
  lastEvaluationResult: PromptResult | null,
  wasAccepted: boolean,
  signal?: AbortSignal,
): Promise<{ candidate: Candidate; updatedHistory: { role: 'system' | 'user' | 'assistant'; content: string }[] }> {
  let lastError: Error | null = null
  let lastRawContent: string | null = null

  const messages = [...messagesHistory]

  if (messages.length === 0) {
    messages.push({
      role: 'system',
      content:
        'Você é o CRIADOR, um agente de melhoria de prompts. Sua resposta DEVE ser estritamente um objeto JSON válido com exatamente duas chaves ("rationale" e "patches"). Você não deve gerar explicações, introduções ou blocos markdown de código fora do JSON. Responda apenas o JSON solicitado.',
    })

    messages.push({
      role: 'user',
      content: `Crie uma estratégia de melhoria para o SYSTEM PROMPT atual.
Você deve propor modificações cirúrgicas por meio de blocos de substituição de texto (patches) simples no prompt atual.

SYSTEM PROMPT ATUAL:
\`\`\`md
${best.prompt}
\`\`\`

Esse prompt recebeu a seguinte nota média pelo AVALIADOR:
${formatScore(best)}

Nota do prompt original para comparação:
${formatScore(original)}

DIAGNÓSTICO INICIAL (Análise das piores execuções do melhor prompt atual):
${buildErrorDiagnostic(best)}

Tarefa do usuário:
${runtime.taskInstructions}

Critérios de avaliação:
${runtime.evaluationCriteria}

Instrução humana adicional:
${userInstruction || 'Sem instrução adicional.'}

Por favor, proponha o primeiro conjunto de alterações cirúrgicas. Identifique as regras ou seções que estão falhando no diagnóstico acima e substitua-as para melhorar a pontuação geral.

IMPORTANTE:
- Você não reescreve o prompt completo. Em vez disso, retorne um array de "patches" indicando o trecho exato a ser localizado ("find") e o novo texto ("replace").
- O trecho "find" deve ser copiado CARACTERE POR CARACTERE, exatamente como aparece no prompt atual, incluindo pontuações, títulos de seções e quebras de linha.
- Se o trecho a localizar não for encontrado de forma exata, a modificação falhará.
- Mantenha os patches focados nas falhas apontadas no diagnóstico.

Responda estritamente neste formato JSON:
{
  "rationale": "explicação curta da alteração",
  "patches": [
    {
      "find": "texto exato a ser substituído",
      "replace": "novo texto"
    }
  ]
}

Exemplo de resposta válida:
{
  "rationale": "Reforçada a regra de concisão nos títulos de encaminhamentos.",
  "patches": [
    {
      "find": "11. Antes de cada bloco, usar título em caixa alta:\\n    - \`ENCAMINHAMENTO [ESPECIALIDADE OU SERVIÇO] - [GRAU DE PRIORIDADE]\`",
      "replace": "11. Antes de cada bloco, usar título curto em caixa alta:\\n    - \`ENCAMINHAMENTO [ESPECIALIDADE] - [GRAU DE PRIORIDADE]\`"
    }
  ]
}`,
    })
  } else if (lastEvaluationResult) {
    let feedbackContent = ''
    if (wasAccepted) {
      feedbackContent = `O patch anterior foi APROVADO e aplicado ao prompt! A nota média subiu para ${lastEvaluationResult.averageScore}/10 (melhor nota atual).

Aqui está o novo diagnóstico das piores execuções do prompt atualizado:
${buildErrorDiagnostic(lastEvaluationResult)}

Instrução humana adicional para este turno: ${userInstruction || 'Sem instrução adicional.'}

Por favor, proponha o próximo patch incremental (ou array de patches) em cima do prompt atualizado para continuar evoluindo o desempenho.

Responda apenas com o JSON contendo "rationale" e "patches".`
    } else {
      feedbackContent = `O patch anterior foi REJEITADO porque não melhorou a nota geral (obteve nota média ${lastEvaluationResult.averageScore}/10, que não superou o melhor anterior de ${best.averageScore}/10).

Abaixo está o diagnóstico das execuções do candidato que foi rejeitado:
${buildErrorDiagnostic(lastEvaluationResult)}

Por favor, ignore o patch anterior, retorne ao estado anterior do prompt, e proponha uma estratégia de patch DIFERENTE para corrigir os erros que continuam ocorrendo.

Instrução humana adicional para este turno: ${userInstruction || 'Sem instrução adicional.'}

Responda apenas com o JSON contendo "rationale" e "patches".`
    }

    messages.push({
      role: 'user',
      content: feedbackContent,
    })
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (attempt > 1 && lastRawContent && lastError) {
        messages.push({
          role: 'assistant',
          content: lastRawContent,
        })
        messages.push({
          role: 'user',
          content: `Sua resposta anterior não pôde ser processada porque falhou no parsing de JSON ou na correspondência do patch.
Erro observado: ${lastError.message}

Por favor, corrija. Lembre-se de que a correspondência de texto para substituir ("find") deve ser exata.
Retorne apenas o JSON correto:
{
  "rationale": "explicação curta",
  "patches": [
    {
      "find": "trecho exato a ser substituído",
      "replace": "novo texto"
    }
  ]
}`,
        })
      }

      const content = await callOpenRouter({
        apiKey: runtime.apiKey,
        model: runtime.model,
        sessionId: runtime.sessionId,
        temperature: attempt === 1 ? 0.2 : 0.1,
        maxTokens: 3200,
        jsonMode: true,
        label: `criador: candidato tentativa ${attempt}`,
        signal,
        messages,
      })

      lastRawContent = content

      let parsed: CandidatePayload
      try {
        parsed = parseJsonObject<CandidatePayload>(content)
      } catch (parseErr) {
        const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr)
        console.error(`[CRIADOR] Falha de JSON na tentativa ${attempt}. Erro: ${errMsg}\nResposta bruta recebida:\n${content}`)
        throw new Error(`Resposta não contém JSON válido. Detalhes: ${errMsg}`)
      }

      let updatedPrompt = best.prompt
      if (parsed.patches && parsed.patches.length > 0) {
        try {
          updatedPrompt = applyPatches(best.prompt, parsed.patches)
        } catch (patchErr) {
          const errMsg = patchErr instanceof Error ? patchErr.message : String(patchErr)
          console.error(`[CRIADOR] Falha ao aplicar patches na tentativa ${attempt}. Erro: ${errMsg}`)
          throw new Error(`Falha ao aplicar patches. Detalhes: ${errMsg}`)
        }
      } else if (parsed.prompt) {
        updatedPrompt = parsed.prompt
        validateCandidatePrompt({
          prompt: updatedPrompt,
          rationale: parsed.rationale || '',
          diff: '',
        }, best.prompt)
      } else {
        throw new Error('Nenhum patch ou prompt completo foi retornado pelo CRIADOR no JSON.')
      }

      messages.push({
        role: 'assistant',
        content,
      })

      return {
        candidate: {
          prompt: updatedPrompt,
          rationale: parsed.rationale?.trim() || 'Melhoria incremental do prompt.',
          diff: buildDiff(best.prompt, updatedPrompt),
        },
        updatedHistory: messages,
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      lastError = error instanceof Error ? error : new Error('Falha desconhecida ao propor candidato.')
    }
  }

  throw lastError ?? new Error('O CRIADOR não retornou candidato válido.')
}

export async function evaluateRunForCriteria(
  runtime: Runtime,
  run: PromptRun,
  signal?: AbortSignal,
): Promise<RunCriterionSuggestion> {
  const content = await callOpenRouter({
    apiKey: runtime.apiKey,
    model: runtime.model,
    sessionId: runtime.sessionId,
    temperature: 0.2,
    maxTokens: 1800,
    jsonMode: true,
    label: `avaliador de run: ${run.id}`,
    signal,
    messages: [
      {
        role: 'system',
        content:
          'Você é o AVALIADOR DE RUNS. Sua tarefa não é dar nota ao output. Sua tarefa é identificar lacunas nos CRITÉRIOS DE AVALIAÇÃO atuais que poderiam melhorar o treinamento futuro. Responda somente JSON válido.',
      },
      {
        role: 'user',
        content: `PROMPT USADO NO RUN:
\`\`\`md
${run.prompt}
\`\`\`

CRITÉRIOS DE AVALIAÇÃO ATUAIS:
\`\`\`md
${runtime.evaluationCriteria}
\`\`\`

INPUT DO RUN:
\`\`\`txt
${run.input}
\`\`\`

OUTPUT DO RUN:
\`\`\`txt
${run.output || run.error || 'Sem output disponível.'}
\`\`\`

AVALIAÇÃO ORIGINAL DO RUN:
${JSON.stringify(run.evaluation, null, 2)}

Proponha no máximo UMA melhoria objetiva aos critérios. Evite duplicar critérios existentes. Não transforme uma preferência local em regra global sem declarar o risco.

Responda neste JSON:
{
  "title": "nome curto da sugestão",
  "evidence": "evidência concreta observada no input/output",
  "proposedCriterion": "- critério de avaliação novo ou revisado",
  "scope": "global|especialidade|formato|seguranca|concisao|outro",
  "risk": "risco de overfitting ou rigidez excessiva",
  "scoringExample": "exemplo curto de como pontuar esse critério"
}`,
      },
    ],
  })

  try {
    return normalizeRunCriterionSuggestion(run.id, parseJsonObject<RunCriterionSuggestionPayload>(content))
  } catch (error) {
    const repaired = await repairRunCriterionSuggestion(runtime, content, error instanceof Error ? error.message : 'JSON inválido.', signal)
    return normalizeRunCriterionSuggestion(run.id, parseJsonObject<RunCriterionSuggestionPayload>(repaired))
  }
}

function extractPromptFromRawText(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  // Heurística 1: Tenta encontrar blocos markdown ```md ... ``` ou ``` ... ```
  const blocks = [...trimmed.matchAll(/```(?:md|markdown)?\s*([\s\S]*?)```/gi)]
  if (blocks.length > 0) {
    let longestBlock = ''
    for (const match of blocks) {
      const blockContent = match[1].trim()
      if (blockContent.length > longestBlock.length) {
        longestBlock = blockContent
      }
    }
    if (longestBlock.length > 50) {
      return longestBlock
    }
  }

  // Heurística 2: Se não houver blocos, mas o texto for longo e começar com algo parecido com prompt
  let cleaned = trimmed
  cleaned = cleaned.replace(/^(claro|com certeza|aqui está|segue|este é|conforme solicitado|system prompt)[\s\S]*?:\s*/i, '')
  
  if (cleaned.length > 100) {
    return cleaned
  }

  return null
}

async function parseOrRepairCandidate(
  runtime: Runtime,
  content: string,
  label: string,
  signal?: AbortSignal,
): Promise<Candidate> {
  try {
    return normalizeCandidate(parseJsonObject<CandidatePayload>(content), label)
  } catch (error) {
    try {
      const repaired = await repairCandidate(runtime, content, error instanceof Error ? error.message : 'JSON inválido.', label, signal)
      return normalizeCandidate(parseJsonObject<CandidatePayload>(repaired), `${label} reparado`)
    } catch (repairError) {
      console.warn(`[CRIADOR] O reparo de JSON falhou. Tentando extração de prompt do conteúdo bruto.`)
      const extractedPrompt = extractPromptFromRawText(content)
      if (extractedPrompt) {
        return {
          prompt: extractedPrompt,
          rationale: 'Melhoria direta do prompt (modelo respondeu em texto livre).',
          diff: '',
        }
      }
      throw repairError
    }
  }
}

function normalizeCandidate(parsed: CandidatePayload, label: string): Candidate {
  if (!parsed.prompt?.trim()) {
    throw new Error(`O CRIADOR não retornou um ${label} válido.`)
  }

  return {
    prompt: parsed.prompt.trim(),
    rationale: parsed.rationale?.trim() || 'Candidato criado sem justificativa detalhada.',
    diff: parsed.diff?.trim() || '',
  }
}

function validateCandidatePrompt(candidate: Candidate, previousPrompt: string) {
  const prompt = candidate.prompt.trim()
  const lowerPrompt = prompt.toLowerCase()
  const looksLikeProtocolRepair =
    /campo\s+"?prompt"?|campo\s+"?rationale"?|campo\s+"?diff"?|não proponha mudanças sobre o formato json|remover.*bloco.*(markdown|json)|corrigir.*json|retornar somente json|objeto json válido/.test(
      lowerPrompt,
    )

  if (looksLikeProtocolRepair) {
    throw new Error('O CRIADOR respondeu sobre o protocolo JSON, não sobre o system prompt alvo.')
  }

  if (previousPrompt.length > 600 && prompt.length < previousPrompt.length * 0.45) {
    throw new Error('O CRIADOR retornou um prompt revisado curto demais para substituir o prompt atual.')
  }
}

async function repairCandidate(
  runtime: Runtime,
  rawContent: string,
  errorMessage: string,
  label: string,
  signal?: AbortSignal,
) {
  return callOpenRouter({
    apiKey: runtime.apiKey,
    model: runtime.model,
    sessionId: runtime.sessionId,
    temperature: 0,
    maxTokens: 3200,
    jsonMode: true,
    label: `criador: reparo JSON ${label}`,
    signal,
    messages: [
      {
        role: 'system',
        content:
          'Você converte respostas de melhoria de prompt para JSON estrito. Responda somente um objeto JSON válido.',
      },
      {
        role: 'user',
        content: `A resposta abaixo deveria ser JSON, mas falhou com este erro:
${errorMessage}

Converta para este formato JSON:
{
  "rationale": "mudança proposta em uma frase objetiva",
  "prompt": "system prompt completo"
}

Resposta original:
\`\`\`txt
${rawContent}
\`\`\``,
      },
    ],
  })
}

export async function runPromptEvaluation(
  runtime: Runtime,
  prompt: string,
  label: string,
  onRun?: (run: PromptRun, index: number) => void,
  signal?: AbortSignal,
): Promise<PromptResult> {
  const runs = new Array<PromptRun | undefined>(RUNS_PER_PROMPT)
  const maxParallelRuns = Math.max(1, Math.min(RUNS_PER_PROMPT, runtime.maxParallelRuns || RUNS_PER_PROMPT))
  let nextIndex = 0

  async function runOne(index: number): Promise<PromptRun> {
    if (signal?.aborted) {
      throw new DOMException('Execução interrompida pelo usuário.', 'AbortError')
    }

    const inputIndex = index % runtime.inputs.length
    const input = runtime.inputs[inputIndex]

    let run: PromptRun

    try {
      const output = await callOpenRouter({
        apiKey: runtime.apiKey,
        model: runtime.model,
        sessionId: runtime.sessionId,
        temperature: 0.2,
        maxTokens: 1800,
        label: `${label}: execução ${index + 1}`,
        signal,
        messages: [
          {
            role: 'system',
            content: prompt,
          },
          {
            role: 'user',
            content: input,
          },
        ],
      })

      const metrics = collectAutoMetrics(output)
      const evaluation = await evaluateOutput(runtime, input, output, metrics, index + 1, signal)
      run = {
        id: safeId('run'),
        runNumber: index + 1,
        status: evaluation.status === 'ok' ? 'completed' : 'evaluation_failed',
        inputIndex,
        input,
        prompt,
        output,
        metrics,
        evaluation,
        error: evaluation.error,
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      const message = error instanceof Error ? error.message : 'Falha desconhecida ao gerar output.'
      run = {
        id: safeId('run'),
        runNumber: index + 1,
        status: 'output_failed',
        inputIndex,
        input,
        prompt,
        output: '',
        metrics: emptyAutoMetrics(),
        evaluation: {
          status: 'failed',
          score: 0,
          items: [],
          criticalFailures: [],
          summary: 'Falha operacional ao gerar output; este run não entra na média.',
          error: message,
        },
        error: message,
      }
    }

    return run
  }

  async function worker() {
    while (nextIndex < RUNS_PER_PROMPT) {
      const index = nextIndex
      nextIndex += 1

      const run = await runOne(index)
      runs[index] = run
      onRun?.(run, index)
    }
  }

  await Promise.all(Array.from({ length: maxParallelRuns }, () => worker()))

  const orderedRuns = runs.filter((run): run is PromptRun => Boolean(run))
  const scoredRuns = orderedRuns.filter((run) => run.status === 'completed' && run.evaluation.status === 'ok')
  const scores = scoredRuns.map((run) => run.evaluation.score)
  const averageScore = scores.length
    ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
    : 0
  const sorted = [...scoredRuns].sort((a, b) => a.evaluation.score - b.evaluation.score)

  return {
    id: safeId('result'),
    label,
    prompt,
    averageScore,
    minScore: scores.length ? Math.min(...scores) : 0,
    maxScore: scores.length ? Math.max(...scores) : 0,
    completedRuns: scoredRuns.length,
    failedRuns: orderedRuns.length - scoredRuns.length,
    criticalFailures: scoredRuns.reduce((sum, run) => sum + run.evaluation.criticalFailures.length, 0),
    bestOutput: sorted.at(-1)?.output ?? '',
    worstOutput: sorted[0]?.output ?? '',
    runs: orderedRuns,
  }
}

function normalizeRunCriterionSuggestion(
  runId: string,
  parsed: RunCriterionSuggestionPayload,
): RunCriterionSuggestion {
  const allowedScopes = new Set(['global', 'especialidade', 'formato', 'seguranca', 'concisao', 'outro'])
  const scope = allowedScopes.has(parsed.scope ?? '') ? parsed.scope : 'outro'

  if (!parsed.proposedCriterion?.trim()) {
    throw new Error('O avaliador de run não retornou critério proposto.')
  }

  return {
    runId,
    title: parsed.title?.trim() || 'Sugestão de critério',
    evidence: parsed.evidence?.trim() || 'Evidência não detalhada.',
    proposedCriterion: parsed.proposedCriterion.trim(),
    scope: scope as RunCriterionSuggestion['scope'],
    risk: parsed.risk?.trim() || 'Risco não detalhado.',
    scoringExample: parsed.scoringExample?.trim() || 'Sem exemplo de pontuação.',
  }
}

async function repairRunCriterionSuggestion(
  runtime: Runtime,
  rawContent: string,
  errorMessage: string,
  signal?: AbortSignal,
) {
  return callOpenRouter({
    apiKey: runtime.apiKey,
    model: runtime.model,
    sessionId: runtime.sessionId,
    temperature: 0,
    maxTokens: 1400,
    jsonMode: false,
    label: 'avaliador de run: reparo JSON',
    signal,
    messages: [
      {
        role: 'system',
        content:
          'Você converte sugestões de critérios para JSON estrito. Responda somente um objeto JSON válido.',
      },
      {
        role: 'user',
        content: `A resposta abaixo deveria ser JSON, mas falhou com este erro:
${errorMessage}

Converta para este formato:
{
  "title": "nome curto da sugestão",
  "evidence": "evidência concreta",
  "proposedCriterion": "- critério de avaliação novo ou revisado",
  "scope": "global|especialidade|formato|seguranca|concisao|outro",
  "risk": "risco de overfitting ou rigidez",
  "scoringExample": "exemplo curto de pontuação"
}

Resposta original:
\`\`\`txt
${rawContent}
\`\`\``,
      },
    ],
  })
}

async function evaluateOutput(
  runtime: Runtime,
  input: string,
  output: string,
  metrics: ReturnType<typeof collectAutoMetrics>,
  runNumber: number,
  signal?: AbortSignal,
): Promise<Evaluation> {
  const messages = [
    {
      role: 'system' as const,
      content:
        'Você é o AVALIADOR. Avalie um único output sem saber se ele veio do prompt antigo ou novo. Use os critérios fornecidos, não invente critérios. Responda somente JSON válido.',
    },
    {
      role: 'user' as const,
      content: `Critérios de avaliação:
${runtime.evaluationCriteria}

Input original:
\`\`\`txt
${input}
\`\`\`

Métricas automáticas:
${summarizeMetrics(metrics)}

Output a avaliar:
\`\`\`txt
${output}
\`\`\`

Responda neste JSON:
{
  "score": 0-10,
  "items": [
    {
      "criterion": "critério avaliado",
      "score": 0,
      "max": 1,
      "reason": "motivo curto"
    }
  ],
  "criticalFailures": ["falhas críticas, se houver"],
  "summary": "resumo curto"
}`,
    },
  ]

  try {
    const content = await callOpenRouter({
      apiKey: runtime.apiKey,
      model: runtime.model,
      sessionId: runtime.sessionId,
      temperature: 0,
      maxTokens: 1600,
      jsonMode: true,
      label: `avaliador: run ${runNumber}`,
      signal,
      messages,
    })

    const parsed = parseJsonObject<EvaluationPayload>(content)
    return normalizeEvaluation(parsed)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }

    const firstError = error instanceof Error ? error.message : 'Falha desconhecida do avaliador.'

    try {
      const repaired = await repairEvaluation(runtime, messages.at(-1)?.content ?? '', firstError, signal)
      return normalizeEvaluation(parseJsonObject<EvaluationPayload>(repaired))
    } catch (repairError) {
      if (isAbortError(repairError)) {
        throw repairError
      }

      const repairMessage = repairError instanceof Error ? repairError.message : 'Falha desconhecida ao reparar avaliação.'

      return {
        status: 'failed',
        score: 0,
        items: [],
        criticalFailures: [],
        summary: 'Falha operacional do avaliador; este run não entra na média.',
        error: `${firstError}; reparo falhou: ${repairMessage}`,
      }
    }
  }
}

function normalizeEvaluation(parsed: EvaluationPayload): Evaluation {
  const score = Number(parsed.score)

  return {
    status: 'ok',
    score: Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    criticalFailures: Array.isArray(parsed.criticalFailures) ? parsed.criticalFailures : [],
    summary: parsed.summary || 'Avaliação concluída.',
  }
}

async function repairEvaluation(
  runtime: Runtime,
  originalPrompt: string,
  errorMessage: string,
  signal?: AbortSignal,
) {
  return callOpenRouter({
    apiKey: runtime.apiKey,
    model: runtime.model,
    sessionId: runtime.sessionId,
    temperature: 0,
    maxTokens: 1200,
    jsonMode: false,
    label: 'avaliador: reparo JSON',
    signal,
    messages: [
      {
        role: 'system',
        content:
          'Você repara respostas de avaliação para JSON estrito. Não reavalie o caso. Responda somente um objeto JSON válido.',
      },
      {
        role: 'user',
        content: `A avaliação anterior falhou com este erro:
${errorMessage}

Reexecute a avaliação abaixo e responda somente no JSON solicitado, sem markdown:

${originalPrompt}`,
      },
    ],
  })
}
