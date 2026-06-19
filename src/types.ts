export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'

export type TrainingMode = 'sem-input' | 'com-input'

export type InputSelectionMode = 'mesmo' | 'aleatorio'

export type Status = 'idle' | 'generating' | 'reviewing' | 'correcting' | 'done' | 'stopped' | 'error'

export type AgentName = 'sistema' | 'gerador' | 'otimizador' | 'usuario'

export type LogEntry = {
  id: string
  agent: AgentName
  title: string
  body: string
  timestamp: string
}

export type PromptTrainingConfig = {
  apiKey: string
  model: string
  sessionId: string
  prompt: string
  taskInstructions: string
}

export type PromptPatch = {
  find: string
  replace: string
}

export type PromptRevision = {
  prompt: string
  rationale: string
  diff: string
  patches?: PromptPatch[]
}

export type TrainingRun = {
  id: string
  turn: number
  prompt: string
  input?: string
  inputIndex?: number
  output: string
}

export type TrainingTurnHistory = TrainingRun & {
  editedOutput?: string
  comment?: string
  revisedPrompt?: string
  rationale?: string
  diff?: string
}

export type ProgressExport = {
  schemaVersion: 4
  exportedAt: string
  model: string
  sessionId: string
  mode: TrainingMode
  inputSelectionMode: InputSelectionMode
  seedPrompt: string
  currentPrompt: string
  originalPrompt: string
  taskInstructions: string
  inputs: string[]
  activeRun: TrainingRun | null
  history: TrainingTurnHistory[]
  logs: LogEntry[]
}
