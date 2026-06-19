import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { diffLines } from 'diff'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Diff,
  Download,
  KeyRound,
  Loader2,
  Moon,
  Play,
  Plus,
  RotateCw,
  Send,
  Square,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import './App.css'
import { generatePromptOutput, revisePromptFromFeedback } from './lib/bootcamp'
import { DEFAULT_MODEL } from './types'
import type {
  AgentName,
  InputSelectionMode,
  LogEntry,
  ProgressExport,
  PromptTrainingConfig,
  Status,
  TrainingMode,
  TrainingRun,
  TrainingTurnHistory,
} from './types'

const starterTask = 'Melhorar um system prompt a partir de outputs gerados e correções humanas sucessivas.'

const starterPrompt = `Você é um assistente objetivo e preciso.
Responda em PT-BR natural.
Siga exatamente a tarefa pedida pelo usuário.
Não invente informações ausentes.`

const starterInput = 'Crie um resumo curto para uma pessoa que precisa entender rapidamente o próximo passo.'

type LegacyProgressExport = {
  schemaVersion?: 2 | 3
  model?: string
  sessionId?: string
  seedPrompt?: string
  taskInstructions?: string
  inputs?: string[]
  bestResult?: { prompt?: string } | null
  lastCandidate?: { prompt?: string } | null
  logs?: LogEntry[]
}

function nowLabel() {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date())
}

function makeSessionId() {
  return `prompt-bootcamp-${Date.now()}-${Math.random().toString(16).slice(2)}`.slice(0, 120)
}

function makeLog(agent: AgentName, title: string, body: string): LogEntry {
  return {
    id: `${agent}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    agent,
    title,
    body,
    timestamp: nowLabel(),
  }
}

function makeRunId() {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isAbortLikeError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && /abort|interrompida/i.test(error.message))
  )
}

function splitInputs(inputs: string[]) {
  return inputs.map((input) => input.trim()).filter(Boolean)
}

function randomInputIndex(inputs: string[]) {
  return Math.floor(Math.random() * inputs.length)
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('prompt-bootcamp-theme')
    return saved === 'dark' || saved === 'light' ? saved : 'light'
  })
  const [collapsedPanels, setCollapsedPanels] = useState<Record<string, boolean>>({
    config: false,
    prompt: false,
    inputs: false,
    feedback: false,
  })
  const [copied, setCopied] = useState(false)

  const apiKeyRef = useRef('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [sessionId, setSessionId] = useState(makeSessionId)
  const [mode, setMode] = useState<TrainingMode>('sem-input')
  const [inputSelectionMode, setInputSelectionMode] = useState<InputSelectionMode>('aleatorio')
  const [seedPrompt, setSeedPrompt] = useState(starterPrompt)
  const [currentPrompt, setCurrentPrompt] = useState(starterPrompt)
  const [originalPrompt, setOriginalPrompt] = useState('')
  const [taskInstructions, setTaskInstructions] = useState(starterTask)
  const [inputs, setInputs] = useState([starterInput])
  const [activeRun, setActiveRun] = useState<TrainingRun | null>(null)
  const [history, setHistory] = useState<TrainingTurnHistory[]>([])
  const [editedOutput, setEditedOutput] = useState('')
  const [comment, setComment] = useState('')
  const [lastDiff, setLastDiff] = useState('')
  const [lastPatchBefore, setLastPatchBefore] = useState('')
  const [lastRationale, setLastRationale] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([
    makeLog('sistema', 'Pronto', 'Cole a chave OpenRouter, ajuste o prompt e clique em gerar.'),
  ])

  const abortRef = useRef<AbortController | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const cleanInputs = useMemo(() => splitInputs(inputs), [inputs])
  const isBusy = status === 'generating' || status === 'correcting'
  const canReview = status === 'reviewing' && activeRun !== null
  const finalDiffParts = useMemo(() => diffLines(originalPrompt || seedPrompt, currentPrompt), [currentPrompt, originalPrompt, seedPrompt])
  const lastDiffParts = useMemo(() => diffLines(lastPatchBefore || currentPrompt, currentPrompt), [currentPrompt, lastPatchBefore])

  function appendLog(agent: AgentName, title: string, body: string) {
    setLogs((entries) => [makeLog(agent, title, body), ...entries].slice(0, 80))
  }

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light'
      localStorage.setItem('prompt-bootcamp-theme', next)
      return next
    })
  }

  function togglePanel(key: string) {
    setCollapsedPanels((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function loadApiKey() {
    const key = apiKeyDraft.trim()

    if (!key) {
      setErrorMessage('Cole a chave da OpenRouter antes de carregá-la.')
      return
    }

    apiKeyRef.current = key
    setApiKeyDraft('')
    setHasApiKey(true)
    setErrorMessage('')
    appendLog('sistema', 'Chave carregada', 'A chave foi guardada somente em memória nesta sessão.')
  }

  function clearApiKey() {
    apiKeyRef.current = ''
    setApiKeyDraft('')
    setHasApiKey(false)
    appendLog('sistema', 'Chave removida', 'A chave em memória foi apagada.')
  }

  function buildConfig(prompt = currentPrompt): PromptTrainingConfig {
    if (!apiKeyRef.current.trim()) {
      throw new Error('Informe a chave da OpenRouter antes de gerar.')
    }

    if (!model.trim()) {
      throw new Error('Informe o modelo que será usado nas chamadas.')
    }

    if (!prompt.trim()) {
      throw new Error('Insira o prompt que será treinado.')
    }

    if (!taskInstructions.trim()) {
      throw new Error('Descreva a tarefa do prompt.')
    }

    if (mode === 'com-input' && cleanInputs.length === 0) {
      throw new Error('Inclua pelo menos um input de teste ou mude para treino sem input.')
    }

    return {
      apiKey: apiKeyRef.current.trim(),
      model: model.trim(),
      sessionId,
      prompt: prompt.trim(),
      taskInstructions: taskInstructions.trim(),
    }
  }

  function chooseInput(previousRun?: TrainingRun | null) {
    if (mode === 'sem-input') {
      return { input: undefined, inputIndex: undefined }
    }

    if (inputSelectionMode === 'mesmo' && previousRun?.input && previousRun.inputIndex !== undefined) {
      return { input: previousRun.input, inputIndex: previousRun.inputIndex }
    }

    const index = randomInputIndex(cleanInputs)
    return { input: cleanInputs[index], inputIndex: index }
  }

  async function createRun(prompt: string, turn: number, previousRun?: TrainingRun | null) {
    const { input, inputIndex } = chooseInput(previousRun)
    const output = await generatePromptOutput(buildConfig(prompt), input, abortRef.current?.signal)

    return {
      id: makeRunId(),
      turn,
      prompt,
      input,
      inputIndex,
      output,
    }
  }

  async function startTraining() {
    try {
      const prompt = seedPrompt.trim()
      buildConfig(prompt)

      const controller = new AbortController()
      abortRef.current = controller
      setStatus('generating')
      setErrorMessage('')
      setHistory([])
      setEditedOutput('')
      setComment('')
      setLastDiff('')
      setLastPatchBefore('')
      setLastRationale('')
      setOriginalPrompt(prompt)
      setCurrentPrompt(prompt)
      appendLog('gerador', 'Geração iniciada', mode === 'com-input' ? 'Gerando output com um input de teste.' : 'Gerando output sem input externo.')

      const run = await createRun(prompt, 1)
      setActiveRun(run)
      setStatus('reviewing')
      appendLog('gerador', 'Output pronto', 'Revise o output, reescreva ou descreva o que precisa mudar.')
    } catch (error) {
      handleRuntimeError(error)
    }
  }

  async function submitCorrection() {
    if (!activeRun) return

    const normalizedEditedOutput = editedOutput.trim()
    const normalizedComment = comment.trim()

    if (!normalizedEditedOutput && !normalizedComment) {
      setErrorMessage('Reescreva o output ou escreva um comentário antes de corrigir.')
      return
    }

    try {
      const controller = new AbortController()
      abortRef.current = controller
      setStatus('correcting')
      setErrorMessage('')
      appendLog('otimizador', `Corrigindo turno ${activeRun.turn}`, 'Aplicando o feedback humano no prompt.')

      const revision = await revisePromptFromFeedback(
        buildConfig(currentPrompt),
        {
          output: activeRun.output,
          input: activeRun.input,
          editedOutput: normalizedEditedOutput || undefined,
          comment: normalizedComment || undefined,
        },
        history,
        controller.signal,
      )

      const finishedTurn: TrainingTurnHistory = {
        ...activeRun,
        editedOutput: normalizedEditedOutput || undefined,
        comment: normalizedComment || undefined,
        revisedPrompt: revision.prompt,
        rationale: revision.rationale,
        diff: revision.diff,
      }
      const nextHistory = [...history, finishedTurn]

      setHistory(nextHistory)
      setCurrentPrompt(revision.prompt)
      setSeedPrompt(revision.prompt)
      setLastDiff(revision.diff)
      setLastPatchBefore(currentPrompt)
      setLastRationale(revision.rationale)
      appendLog('otimizador', 'Prompt atualizado', revision.rationale)

      const nextRun = await createRun(revision.prompt, activeRun.turn + 1, activeRun)
      setActiveRun(nextRun)
      setEditedOutput('')
      setComment('')
      setStatus('reviewing')
      appendLog('gerador', `Turno ${nextRun.turn} gerado`, nextRun.input ? 'Novo output pronto com input de teste.' : 'Novo output pronto sem input externo.')
    } catch (error) {
      handleRuntimeError(error)
    }
  }

  function finishTraining() {
    if (!originalPrompt) {
      setOriginalPrompt(seedPrompt)
    }

    setStatus('done')
    setErrorMessage('')
    appendLog('sistema', 'Treino finalizado', 'O prompt final está disponível em diff e pode ser copiado.')
  }

  function stop() {
    abortRef.current?.abort()
    setStatus('stopped')
    appendLog('sistema', 'Execução interrompida', 'A chamada em andamento foi interrompida.')
  }

  function resetTraining() {
    abortRef.current?.abort()
    setActiveRun(null)
    setHistory([])
    setEditedOutput('')
    setComment('')
    setOriginalPrompt('')
    setCurrentPrompt(seedPrompt)
    setLastDiff('')
    setLastPatchBefore('')
    setLastRationale('')
    setStatus('idle')
    setErrorMessage('')
    appendLog('sistema', 'Sessão reiniciada', 'O histórico do treino foi limpo.')
  }

  function handleRuntimeError(error: unknown) {
    if (isAbortLikeError(error)) {
      setStatus('stopped')
      setErrorMessage('')
      return
    }

    const message = error instanceof Error ? error.message : 'Falha desconhecida.'
    setStatus('error')
    setErrorMessage(message)
    appendLog('sistema', 'Erro', message)
  }

  function updateInput(index: number, value: string) {
    setInputs((items) => items.map((item, itemIndex) => (itemIndex === index ? value : item)))
  }

  function addInput() {
    setInputs((items) => [...items, ''])
  }

  function removeInput(index: number) {
    setInputs((items) => (items.length > 1 ? items.filter((_, itemIndex) => itemIndex !== index) : ['']))
  }

  async function handleCopyPrompt(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
      appendLog('sistema', 'Prompt copiado', 'O prompt atual foi copiado para a área de transferência.')
    } catch {
      setErrorMessage('Não foi possível acessar a área de transferência.')
    }
  }

  function exportProgress() {
    const payload: ProgressExport = {
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      model,
      sessionId,
      mode,
      inputSelectionMode,
      seedPrompt,
      currentPrompt,
      originalPrompt,
      taskInstructions,
      inputs,
      activeRun,
      history,
      logs,
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `prompt-bootcamp-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    appendLog('sistema', 'Progresso exportado', 'Arquivo JSON gerado sem incluir a chave OpenRouter.')
  }

  async function importProgress(file: File | undefined) {
    if (!file) return

    try {
      const parsed = JSON.parse(await file.text()) as Partial<ProgressExport> & LegacyProgressExport & {
        seedPrompt?: string
        currentPrompt?: string
      }

      if (parsed.schemaVersion === 2 || parsed.schemaVersion === 3) {
        importLegacyProgress(parsed)
        return
      }

      if (parsed.schemaVersion !== 4) {
        throw new Error('Arquivo de progresso incompatível. Esperado schemaVersion 2, 3 ou 4.')
      }

      setModel(parsed.model || DEFAULT_MODEL)
      setSessionId(parsed.sessionId || makeSessionId())
      setMode(parsed.mode || 'sem-input')
      setInputSelectionMode(parsed.inputSelectionMode || 'aleatorio')
      setSeedPrompt(parsed.currentPrompt || parsed.seedPrompt || starterPrompt)
      setCurrentPrompt(parsed.currentPrompt || parsed.seedPrompt || starterPrompt)
      setOriginalPrompt(parsed.originalPrompt || parsed.seedPrompt || '')
      setTaskInstructions(parsed.taskInstructions || starterTask)
      setInputs(Array.isArray(parsed.inputs) && parsed.inputs.length ? parsed.inputs : [starterInput])
      setActiveRun(parsed.activeRun ?? null)
      setHistory(Array.isArray(parsed.history) ? parsed.history : [])
      setLogs(Array.isArray(parsed.logs) ? [makeLog('sistema', 'Progresso importado', 'Sessão carregada de JSON; carregue a chave para continuar.'), ...parsed.logs].slice(0, 80) : [
        makeLog('sistema', 'Progresso importado', 'Sessão carregada de JSON; carregue a chave para continuar.'),
      ])
      setStatus(parsed.activeRun ? 'reviewing' : 'idle')
      setEditedOutput('')
      setComment('')
      setLastPatchBefore('')
      setErrorMessage('')
    } catch (error) {
      handleRuntimeError(error)
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = ''
      }
    }
  }

  function importLegacyProgress(parsed: LegacyProgressExport) {
    const legacyPrompt =
      parsed.bestResult?.prompt?.trim() ||
      parsed.lastCandidate?.prompt?.trim() ||
      parsed.seedPrompt?.trim() ||
      starterPrompt
    const hasLegacyInputs = Array.isArray(parsed.inputs) && parsed.inputs.some((input) => input.trim())
    const legacyInputs = hasLegacyInputs ? parsed.inputs ?? [] : [starterInput]

    setModel(parsed.model || DEFAULT_MODEL)
    setSessionId(parsed.sessionId || makeSessionId())
    setMode(hasLegacyInputs ? 'com-input' : 'sem-input')
    setInputSelectionMode('aleatorio')
    setSeedPrompt(legacyPrompt)
    setCurrentPrompt(legacyPrompt)
    setOriginalPrompt(legacyPrompt)
    setTaskInstructions(parsed.taskInstructions || starterTask)
    setInputs(legacyInputs)
    setActiveRun(null)
    setHistory([])
    setEditedOutput('')
    setComment('')
    setLastDiff('')
    setLastPatchBefore('')
    setLastRationale('')
    setLogs(Array.isArray(parsed.logs) ? [
      makeLog('sistema', 'JSON legado importado', 'Prompt e inputs foram migrados para o fluxo novo; notas, critérios e runs antigos foram ignorados.'),
      ...parsed.logs,
    ].slice(0, 80) : [
      makeLog('sistema', 'JSON legado importado', 'Prompt e inputs foram migrados para o fluxo novo; carregue a chave para continuar.'),
    ])
    setStatus('idle')
    setErrorMessage('')
  }

  return (
    <main className={`app-shell theme-${theme}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PB</div>
          <div>
            <h1>Prompt Bootcamp</h1>
            <p>Treino direto por output, correção humana e patch no prompt.</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`status-pill status-${status}`}>
            {isBusy ? <Loader2 className="spin" size={14} /> : null}
            {statusLabel(status)}
          </span>
          <button type="button" className="icon-button theme-toggle" onClick={toggleTheme} aria-label="Alternar tema">
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <Panel title="Configuração" icon={<KeyRound size={17} />} collapsed={collapsedPanels.config} onToggle={() => togglePanel('config')}>
            <label>
              <span>Chave OpenRouter</span>
              <input
                type="password"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder="Cole a chave aqui"
                disabled={isBusy}
              />
            </label>
            <div className="key-row">
              <span className={hasApiKey ? 'key-loaded' : 'key-empty'}>
                {hasApiKey ? 'Chave ativa em memória' : 'Nenhuma chave carregada'}
              </span>
              <div className="key-actions">
                <button type="button" className="secondary-button compact" onClick={loadApiKey} disabled={!apiKeyDraft.trim() || isBusy}>
                  <KeyRound size={14} />
                  Usar chave
                </button>
                <button type="button" className="icon-button" onClick={clearApiKey} disabled={!hasApiKey || isBusy} aria-label="Limpar chave">
                  <X size={15} />
                </button>
              </div>
            </div>
            <label>
              <span>Modelo</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} disabled={isBusy} />
            </label>
            <div className="action-row utility-actions">
              <button type="button" className="secondary-button" onClick={exportProgress}>
                <Download size={15} />
                Exportar
              </button>
              <button type="button" className="secondary-button" onClick={() => importInputRef.current?.click()} disabled={isBusy}>
                <Upload size={15} />
                Importar
              </button>
              <input
                ref={importInputRef}
                className="file-input"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importProgress(event.target.files?.[0])}
              />
            </div>
          </Panel>

          <Panel title="Prompt" icon={<Bot size={17} />} collapsed={collapsedPanels.prompt} onToggle={() => togglePanel('prompt')}>
            <div className="mode-toggle" role="group" aria-label="Modo de treino">
              <button type="button" className={mode === 'sem-input' ? 'active' : ''} onClick={() => setMode('sem-input')} disabled={isBusy}>
                Sem input
              </button>
              <button type="button" className={mode === 'com-input' ? 'active' : ''} onClick={() => setMode('com-input')} disabled={isBusy}>
                Com input
              </button>
            </div>
            <label>
              <span>Prompt para treinar</span>
              <textarea
                value={seedPrompt}
                onChange={(event) => {
                  setSeedPrompt(event.target.value)
                  if (!activeRun && status !== 'done') {
                    setCurrentPrompt(event.target.value)
                  }
                }}
                rows={8}
                disabled={isBusy}
              />
            </label>
            <label>
              <span>Descrição da tarefa</span>
              <textarea value={taskInstructions} onChange={(event) => setTaskInstructions(event.target.value)} rows={4} disabled={isBusy} />
            </label>
          </Panel>

          {mode === 'com-input' ? (
            <Panel title="Inputs de teste" icon={<Send size={17} />} collapsed={collapsedPanels.inputs} onToggle={() => togglePanel('inputs')}>
              <div className="input-list">
                <div className="row-title">
                  <span>Lista de inputs</span>
                  <button type="button" className="icon-button" onClick={addInput} aria-label="Adicionar input" disabled={isBusy}>
                    <Plus size={16} />
                  </button>
                </div>
                {inputs.map((input, index) => (
                  <div className="input-item" key={`input-${index}`}>
                    <textarea
                      value={input}
                      onChange={(event) => updateInput(index, event.target.value)}
                      rows={4}
                      placeholder={`Input ${index + 1}`}
                      disabled={isBusy}
                    />
                    <button type="button" className="icon-button danger" onClick={() => removeInput(index)} aria-label="Remover input" disabled={isBusy}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mode-toggle compact-toggle" role="group" aria-label="Seleção de input">
                <button type="button" className={inputSelectionMode === 'aleatorio' ? 'active' : ''} onClick={() => setInputSelectionMode('aleatorio')} disabled={isBusy}>
                  Aleatório
                </button>
                <button type="button" className={inputSelectionMode === 'mesmo' ? 'active' : ''} onClick={() => setInputSelectionMode('mesmo')} disabled={isBusy || !activeRun?.input}>
                  Mesmo input
                </button>
              </div>
            </Panel>
          ) : null}

          <Panel title="Controle" icon={<Play size={17} />} collapsed={collapsedPanels.feedback} onToggle={() => togglePanel('feedback')}>
            <div className="action-row control-actions">
              <button type="button" className="primary-button" onClick={startTraining} disabled={isBusy}>
                <Play size={16} />
                Gerar
              </button>
              <button type="button" className="secondary-button" onClick={stop} disabled={!isBusy}>
                <Square size={15} />
                Parar
              </button>
              <button type="button" className="secondary-button" onClick={resetTraining} disabled={isBusy}>
                <RotateCw size={15} />
                Reiniciar
              </button>
            </div>
            {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          </Panel>
        </aside>

        <section className="board" aria-label="Treino do prompt">
          <div className="metric-strip">
            <MetricCard label="Modo" value={mode === 'sem-input' ? 'Sem input' : 'Com input'} />
            <MetricCard label="Turno" value={activeRun ? String(activeRun.turn) : '0'} />
            <MetricCard label="Correções" value={String(history.length)} />
            <MetricCard label="Inputs" value={mode === 'com-input' ? String(cleanInputs.length) : 'nenhum'} />
          </div>

          <div className="training-grid">
            <AgentPanel title="Output atual" icon={<Bot size={18} />} tone="generator">
              {activeRun ? (
                <div className="run-list">
                  {activeRun.input ? (
                    <article className="run-card subtle-card">
                      <div className="run-head">
                        <strong>Input usado</strong>
                        <span>{activeRun.inputIndex !== undefined ? `#${activeRun.inputIndex + 1}` : 'manual'}</span>
                      </div>
                      <p>{activeRun.input}</p>
                    </article>
                  ) : null}
                  <article className="run-card">
                    <div className="run-head">
                      <strong>Turno {activeRun.turn}</strong>
                      <span>{mode === 'sem-input' ? 'sem input externo' : 'com input'}</span>
                    </div>
                    <p>{activeRun.output}</p>
                  </article>
                </div>
              ) : (
                <Empty text="Clique em gerar para criar o primeiro output." />
              )}
            </AgentPanel>

            <AgentPanel title="Correção humana" icon={<Send size={18} />} tone="feedback">
              {canReview ? (
                <div className="feedback-form">
                  <label>
                    <span>Output reescrito</span>
                    <textarea value={editedOutput} onChange={(event) => setEditedOutput(event.target.value)} rows={9} placeholder="Cole aqui como o output deveria ficar." />
                  </label>
                  <label>
                    <span>Comentário de correção</span>
                    <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={5} placeholder="Ou descreva a regra que o prompt deve aprender." />
                  </label>
                  <div className="action-row">
                    <button type="button" className="primary-button" onClick={submitCorrection}>
                      <Send size={16} />
                      Corrigir
                    </button>
                    <button type="button" className="secondary-button" onClick={finishTraining}>
                      <Check size={15} />
                      OK
                    </button>
                  </div>
                </div>
              ) : (
                <Empty text={isBusy ? 'Aguarde a chamada em andamento.' : 'A correção aparece quando houver um output para revisar.'} />
              )}
            </AgentPanel>

            <AgentPanel title="Prompt atual" icon={<Diff size={18} />} tone="prompt">
              <div className="prompt-meta">
                <span>{currentPrompt.length} caracteres</span>
                <button type="button" className="secondary-button compact" onClick={() => void handleCopyPrompt(currentPrompt)}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? 'Copiado' : 'Copiar'}
                </button>
              </div>
              <pre className="prompt-box">{currentPrompt || 'Sem prompt.'}</pre>
            </AgentPanel>

            <AgentPanel title="Último patch" icon={<RotateCw size={18} />} tone="patch">
              {lastDiff ? (
                <>
                  <p className="muted">{lastRationale}</p>
                  <div className="diff-grid inline-diff">
                    {lastDiffParts.map((part, index) => (
                      <pre className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-context'} key={`last-diff-${index}`}>
                        {part.value}
                      </pre>
                    ))}
                  </div>
                </>
              ) : (
                <Empty text="O diff do patch aparece após a primeira correção." />
              )}
            </AgentPanel>

            <AgentPanel title="Histórico" icon={<ChevronDown size={18} />} tone="history">
              {history.length ? (
                <div className="history-list">
                  {history.map((item) => (
                    <article key={item.id}>
                      <div className="run-head">
                        <strong>Turno {item.turn}</strong>
                        <span>{item.input ? 'com input' : 'sem input'}</span>
                      </div>
                      <p>{item.rationale}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty text="Sem correções aplicadas ainda." />
              )}
            </AgentPanel>

            <AgentPanel title="Log" icon={<Diff size={18} />} tone="log">
              <div className="log-list">
                {logs.map((entry) => (
                  <article key={entry.id}>
                    <span>{entry.timestamp}</span>
                    <strong>{entry.title}</strong>
                    <p>{entry.body}</p>
                  </article>
                ))}
              </div>
            </AgentPanel>
          </div>
        </section>
      </section>

      {status === 'done' ? (
        <div className="modal-overlay">
          <div className="modal-container diff-modal">
            <div className="modal-header">
              <div>
                <h2>Prompt final</h2>
                <p className="modal-subtitle">Compare o prompt inicial com o prompt treinado.</p>
              </div>
              <button type="button" className="icon-button close-modal" onClick={() => setStatus('reviewing')} aria-label="Fechar diff">
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="side-by-side-diff">
                <section>
                  <h3>Inicial</h3>
                  <pre>{originalPrompt || seedPrompt}</pre>
                </section>
                <section>
                  <h3>Final</h3>
                  <pre>{currentPrompt}</pre>
                </section>
              </div>
              <div className="diff-grid">
                {finalDiffParts.map((part, index) => (
                  <pre className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-context'} key={`final-diff-${index}`}>
                    {part.value}
                  </pre>
                ))}
              </div>
              <div className="modal-actions">
                <button type="button" className="primary-button" onClick={() => void handleCopyPrompt(currentPrompt)}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Copiado' : 'Copiar prompt final'}
                </button>
                <button type="button" className="secondary-button" onClick={() => setStatus('reviewing')}>
                  Fechar
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function statusLabel(status: Status) {
  const labels: Record<Status, string> = {
    idle: 'pronto',
    generating: 'gerando',
    reviewing: 'revisando',
    correcting: 'corrigindo',
    done: 'concluído',
    stopped: 'parado',
    error: 'erro',
  }
  return labels[status]
}

function Panel({
  title,
  icon,
  children,
  collapsed,
  onToggle,
}: {
  title: string
  icon: ReactNode
  children: ReactNode
  collapsed?: boolean
  onToggle?: () => void
}) {
  return (
    <section className={`panel ${collapsed ? 'collapsed' : ''}`}>
      <header onClick={onToggle} style={{ cursor: onToggle ? 'pointer' : 'default', userSelect: 'none' }}>
        <div className="title-row">
          {icon}
          <h2>{title}</h2>
        </div>
        {onToggle ? <div className="collapse-icon">{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</div> : null}
      </header>
      {!collapsed ? <div className="panel-body">{children}</div> : null}
    </section>
  )
}

function AgentPanel({
  title,
  icon,
  tone,
  children,
}: {
  title: string
  icon: ReactNode
  tone: string
  children: ReactNode
}) {
  return (
    <section className={`agent-panel ${tone}`}>
      <header>
        <div className="title-row">
          {icon}
          <h2>{title}</h2>
        </div>
      </header>
      <div className="agent-body">{children}</div>
    </section>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>
}

export default App
