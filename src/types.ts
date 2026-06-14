export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'
export const RUNS_PER_PROMPT = 10

export type AgentName = 'sistema' | 'criador' | 'executor' | 'avaliador' | 'usuario' | 'criterios'

export type Status = 'idle' | 'running' | 'paused' | 'stopped' | 'error' | 'done'

export type LogEntry = {
  id: string
  agent: AgentName
  title: string
  body: string
  timestamp: string
}

export type AutoMetrics = {
  characters: number
  paragraphs: number
  markdownFenceBalanced: boolean
  hasReplacementCharacters: boolean
  hasLikelyEncodingIssue: boolean
}

export type EvaluationItem = {
  criterion: string
  score: number
  max: number
  reason: string
}

export type Evaluation = {
  status: 'ok' | 'failed'
  score: number
  items: EvaluationItem[]
  criticalFailures: string[]
  summary: string
  error?: string
}

export type PromptRun = {
  id: string
  status: 'completed' | 'output_failed' | 'evaluation_failed'
  inputIndex: number
  input: string
  prompt: string
  output: string
  metrics: AutoMetrics
  evaluation: Evaluation
  error?: string
}

export type PromptResult = {
  id: string
  label: string
  prompt: string
  averageScore: number
  minScore: number
  maxScore: number
  completedRuns: number
  failedRuns: number
  criticalFailures: number
  bestOutput: string
  worstOutput: string
  runs: PromptRun[]
}

export type Candidate = {
  prompt: string
  rationale: string
  diff: string
}

export type RunCriterionSuggestion = {
  runId: string
  title: string
  evidence: string
  proposedCriterion: string
  scope: 'global' | 'especialidade' | 'formato' | 'seguranca' | 'concisao' | 'outro'
  risk: string
  scoringExample: string
}

export type ProgressExport = {
  schemaVersion: 2
  exportedAt: string
  model: string
  seedPrompt: string
  taskInstructions: string
  evaluationCriteria: string
  criteriaVersion: number
  inputs: string[]
  userInstruction: string
  currentRuns: PromptRun[]
  history: PromptResult[]
  originalResult: PromptResult | null
  bestResult: PromptResult | null
  lastCandidate: Candidate | null
  diffBefore: string
  logs: LogEntry[]
}

export type BootcampConfig = {
  apiKey: string
  model: string
  seedPrompt: string
  taskInstructions: string
  evaluationCriteria: string
  inputs: string[]
  userInstruction: string
}
