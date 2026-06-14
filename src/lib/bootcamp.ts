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

type Runtime = Pick<BootcampConfig, 'apiKey' | 'model' | 'taskInstructions' | 'evaluationCriteria' | 'inputs'>

type CandidatePayload = {
  prompt?: string
  rationale?: string
  diff?: string
}

type EvaluationPayload = Partial<Evaluation>
type RunCriterionSuggestionPayload = Partial<Omit<RunCriterionSuggestion, 'runId'>>

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

  const parsed = await parseOrRepairCandidate(runtime, content, 'prompt inicial', signal)
  return parsed.prompt
}

export async function createCandidatePrompt(
  runtime: Runtime,
  best: PromptResult,
  original: PromptResult,
  userInstruction: string,
  signal?: AbortSignal,
): Promise<Candidate> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const content = await callOpenRouter({
        apiKey: runtime.apiKey,
        model: runtime.model,
        temperature: attempt === 1 ? 0.45 : 0.2,
        maxTokens: 3600,
        jsonMode: true,
        label: `criador: candidato tentativa ${attempt}`,
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

IMPORTANTE:
- Não proponha mudanças sobre o formato JSON da sua própria resposta.
- Não responda com instruções como "remover bloco markdown", "corrigir JSON" ou "retornar JSON válido".
- O campo "prompt" deve conter o SYSTEM PROMPT completo revisado, pronto para ser usado na execução dos próximos runs.
- Preserve a tarefa original. A melhoria deve ser no prompt-alvo acima, não no protocolo desta chamada.

Responda somente neste JSON:
{
  "rationale": "mudança proposta em uma frase objetiva",
  "diff": "diff unificado ou lista objetiva de alterações",
  "prompt": "system prompt completo revisado"
}`,
          },
        ],
      })

      const parsed = await parseOrRepairCandidate(runtime, content, 'candidato', signal)
      validateCandidatePrompt(parsed, best.prompt)

      return {
        ...parsed,
        diff: parsed.diff || buildDiff(best.prompt, parsed.prompt),
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Falha desconhecida ao criar candidato.')
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

async function parseOrRepairCandidate(
  runtime: Runtime,
  content: string,
  label: string,
  signal?: AbortSignal,
): Promise<Candidate> {
  try {
    return normalizeCandidate(parseJsonObject<CandidatePayload>(content), label)
  } catch (error) {
    const repaired = await repairCandidate(runtime, content, error instanceof Error ? error.message : 'JSON inválido.', label, signal)
    return normalizeCandidate(parseJsonObject<CandidatePayload>(repaired), `${label} reparado`)
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
  const lowerJoined = `${candidate.rationale}\n${candidate.diff}\n${prompt}`.toLowerCase()
  const looksLikeProtocolRepair =
    /remover.*bloco.*(markdown|json)|corrigir.*json|json válido|retornar somente json|objeto json válido/.test(lowerJoined)

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
    temperature: 0,
    maxTokens: 3200,
    jsonMode: false,
    label: `criador: reparo JSON ${label}`,
    signal,
    messages: [
      {
        role: 'system',
        content:
          'Você converte respostas de melhoria de prompt para JSON estrito. Preserve integralmente o prompt proposto. Não transforme erros de JSON em sugestão de prompt. Responda somente um objeto JSON válido.',
      },
      {
        role: 'user',
        content: `A resposta abaixo deveria ser JSON, mas falhou com este erro:
${errorMessage}

Converta para este formato:
{
  "rationale": "mudança proposta em uma frase objetiva",
  "diff": "diff unificado ou lista objetiva de alterações",
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
        prompt,
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
