export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'
export const RUNS_PER_PROMPT = 10

export type AgentName = 'sistema' | 'criador' | 'executor' | 'avaliador' | 'usuario'

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
  score: number
  items: EvaluationItem[]
  criticalFailures: string[]
  summary: string
}

export type PromptRun = {
  id: string
  inputIndex: number
  input: string
  output: string
  metrics: AutoMetrics
  evaluation: Evaluation
}

export type PromptResult = {
  id: string
  label: string
  prompt: string
  averageScore: number
  minScore: number
  maxScore: number
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

export type BootcampConfig = {
  apiKey: string
  model: string
  seedPrompt: string
  taskInstructions: string
  evaluationCriteria: string
  inputs: string[]
  userInstruction: string
}
