import { diffLines } from 'diff'
import { callOpenRouter } from './openrouter'
import { parseJsonObject } from './json'
import { collectAutoMetrics, emptyAutoMetrics, summarizeMetrics } from './metrics'
import type { BootcampConfig, Candidate, Evaluation, PromptResult, PromptRun } from '../types'
import { RUNS_PER_PROMPT } from '../types'

type Runtime = Pick<BootcampConfig, 'apiKey' | 'model' | 'taskInstructions' | 'evaluationCriteria' | 'inputs'>

type CandidatePayload = {
  prompt?: string
  rationale?: string
  diff?: string
}

type EvaluationPayload = Partial<Evaluation>

function safeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
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

Responda neste formato:
{
  "prompt": "system prompt completo em PT-BR",
  "rationale": "explicação curta do desenho do prompt",
  "diff": "PROMPT NOVO DO ZERO"
}`,
      },
    ],
  })

  const parsed = parseJsonObject<CandidatePayload>(content)

  if (!parsed.prompt?.trim()) {
    throw new Error('O CRIADOR não retornou um prompt inicial válido.')
  }

  return parsed.prompt.trim()
}

export async function createCandidatePrompt(
  runtime: Runtime,
  best: PromptResult,
  original: PromptResult,
  userInstruction: string,
  signal?: AbortSignal,
): Promise<Candidate> {
  const content = await callOpenRouter({
    apiKey: runtime.apiKey,
    model: runtime.model,
    temperature: 0.45,
    maxTokens: 2800,
    jsonMode: true,
    label: 'criador: candidato',
    signal,
    messages: [
      {
        role: 'system',
        content:
          'Você é o CRIADOR, um agente de melhoria de prompts em um sistema adversarial. Modifique prompts com parcimônia, preserve requisitos úteis e responda somente JSON válido.',
      },
      {
        role: 'user',
        content: `O prompt a ser melhorado atualmente é este:
\`\`\`md
${best.prompt}
\`\`\`

Esse prompt recebeu a seguinte nota média pelo AVALIADOR:
${formatScore(best)}

Nota do prompt original para comparação:
${formatScore(original)}

Veja um exemplo do pior output do melhor prompt atual:
\`\`\`txt
${best.worstOutput || 'AINDA SEM OUTPUT, ESTE É O PRIMEIRO TURNO'}
\`\`\`

Tarefa do usuário:
${runtime.taskInstructions}

Critérios de avaliação:
${runtime.evaluationCriteria}

Instrução humana adicional:
${userInstruction || 'Sem instrução adicional.'}

Agora modifique o SYSTEM PROMPT por meio de um DIFF conceitual e forneça também o prompt completo final, que será usado no próximo turno.

Responda somente neste JSON:
{
  "rationale": "mudança proposta em uma frase objetiva",
  "diff": "diff unificado ou lista objetiva de alterações",
  "prompt": "system prompt completo revisado"
}`,
      },
    ],
  })

  const parsed = parseJsonObject<CandidatePayload>(content)

  if (!parsed.prompt?.trim()) {
    throw new Error('O CRIADOR não retornou um candidato válido.')
  }

  return {
    prompt: parsed.prompt.trim(),
    rationale: parsed.rationale?.trim() || 'Candidato criado sem justificativa detalhada.',
    diff: parsed.diff?.trim() || buildDiff(best.prompt, parsed.prompt.trim()),
  }
}

export async function runPromptEvaluation(
  runtime: Runtime,
  prompt: string,
  label: string,
  onRun?: (run: PromptRun) => void,
  signal?: AbortSignal,
): Promise<PromptResult> {
  const runs: PromptRun[] = []

  for (let index = 0; index < RUNS_PER_PROMPT; index += 1) {
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
        status: evaluation.status === 'ok' ? 'completed' : 'evaluation_failed',
        inputIndex,
        input,
        output,
        metrics,
        evaluation,
        error: evaluation.error,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha desconhecida ao gerar output.'
      run = {
        id: safeId('run'),
        status: 'output_failed',
        inputIndex,
        input,
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

    runs.push(run)
    onRun?.(run)
  }

  const scoredRuns = runs.filter((run) => run.status === 'completed' && run.evaluation.status === 'ok')
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
    failedRuns: runs.length - scoredRuns.length,
    criticalFailures: scoredRuns.reduce((sum, run) => sum + run.evaluation.criticalFailures.length, 0),
    bestOutput: sorted.at(-1)?.output ?? '',
    worstOutput: sorted[0]?.output ?? '',
    runs,
  }
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
    const firstError = error instanceof Error ? error.message : 'Falha desconhecida do avaliador.'

    try {
      const repaired = await repairEvaluation(runtime, messages.at(-1)?.content ?? '', firstError, signal)
      return normalizeEvaluation(parseJsonObject<EvaluationPayload>(repaired))
    } catch (repairError) {
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
