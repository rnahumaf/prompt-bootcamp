import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { diffLines } from 'diff'
import {
  Activity,
  Bot,
  Check,
  ClipboardList,
  Diff,
  Download,
  KeyRound,
  Loader2,
  Play,
  Plus,
  RotateCw,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import './App.css'
import {
  createCandidatePrompt,
  createInitialPrompt,
  evaluateRunForCriteria,
  runPromptEvaluation,
} from './lib/bootcamp'
import { DEFAULT_MODEL, RUNS_PER_PROMPT } from './types'
import type {
  BootcampConfig,
  Candidate,
  LogEntry,
  ProgressExport,
  PromptResult,
  PromptRun,
  RunCriterionSuggestion,
  Status,
} from './types'

const starterCriteria = `- O output deve cumprir exatamente o formato solicitado pelo usuário.
- O output deve ser conciso e não incluir informações irrelevantes.
- O output não deve inventar dados ausentes no input.
- O output deve usar PT-BR natural, sem vocabulário artificial ou estrangeirismos desnecessários.
- Se houver limite de caracteres, ele deve ser respeitado.
- Markdown deve ser válido quando solicitado.`

const starterTask = `Melhorar um system prompt para gerar respostas mais consistentes, curtas, claras e aderentes aos critérios definidos.`

const starterInput = `encaminhamento à dermatologia: paciente com lesão descamativa em couro cabeludo há 4 meses, prurido, sem melhora com shampoo comum. Solicitar avaliação especializada e incluir CID provável.`

function nowLabel() {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date())
}

function makeLog(agent: LogEntry['agent'], title: string, body: string): LogEntry {
  return {
    id: `${agent}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    agent,
    title,
    body,
    timestamp: nowLabel(),
  }
}

function scoreClass(score?: number) {
  if (score === undefined) return 'score-muted'
  if (score >= 8) return 'score-good'
  if (score >= 6) return 'score-mid'
  return 'score-bad'
}

function App() {
  const apiKeyRef = useRef('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [seedPrompt, setSeedPrompt] = useState('')
  const [taskInstructions, setTaskInstructions] = useState(starterTask)
  const [evaluationCriteria, setEvaluationCriteria] = useState(starterCriteria)
  const [criteriaVersion, setCriteriaVersion] = useState(1)
  const [inputs, setInputs] = useState([starterInput])
  const [userInstruction, setUserInstruction] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [logs, setLogs] = useState<LogEntry[]>([
    makeLog('sistema', 'Pronto', 'Informe a chave OpenRouter, revise critérios e inputs, depois inicie.'),
  ])
  const [currentRuns, setCurrentRuns] = useState<PromptRun[]>([])
  const [history, setHistory] = useState<PromptResult[]>([])
  const [originalResult, setOriginalResult] = useState<PromptResult | null>(null)
  const [bestResult, setBestResult] = useState<PromptResult | null>(null)
  const [lastCandidate, setLastCandidate] = useState<Candidate | null>(null)
  const [diffBefore, setDiffBefore] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [runSuggestion, setRunSuggestion] = useState<RunCriterionSuggestion | null>(null)
  const [suggestionDraft, setSuggestionDraft] = useState('')
  const [evaluatingRunId, setEvaluatingRunId] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const isRunning = status === 'running'
  const canSend = status === 'paused' || status === 'stopped' || status === 'done'

  const cleanInputs = useMemo(() => inputs.map((input) => input.trim()).filter(Boolean), [inputs])
  const currentFailedRuns = currentRuns.filter((run) => run.status !== 'completed').length

  function appendLog(agent: LogEntry['agent'], title: string, body: string) {
    setLogs((entries) => [makeLog(agent, title, body), ...entries].slice(0, 80))
  }

  function resetResultsForCriteriaChange(nextCriteria: string) {
    const promptToKeep = bestResult?.prompt || seedPrompt
    setEvaluationCriteria(nextCriteria)
    setCriteriaVersion((version) => version + 1)
    setSeedPrompt(promptToKeep)
    setCurrentRuns([])
    setHistory([])
    setOriginalResult(null)
    setBestResult(null)
    setLastCandidate(null)
    setDiffBefore('')
    setStatus('idle')
    setErrorMessage('')
    appendLog('criterios', 'Critérios atualizados', 'As notas anteriores foram arquivadas implicitamente; reinicie a avaliação do zero.')
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

  function exportProgress() {
    const payload: ProgressExport = {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      model,
      seedPrompt,
      taskInstructions,
      evaluationCriteria,
      criteriaVersion,
      inputs,
      userInstruction,
      currentRuns,
      history,
      originalResult,
      bestResult,
      lastCandidate,
      diffBefore,
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
      const parsed = JSON.parse(await file.text()) as Partial<ProgressExport>

      if (parsed.schemaVersion !== 2) {
        throw new Error('Arquivo de progresso incompatível. Esperado schemaVersion 2.')
      }

      setModel(parsed.model || DEFAULT_MODEL)
      setSeedPrompt(parsed.seedPrompt || '')
      setTaskInstructions(parsed.taskInstructions || starterTask)
      setEvaluationCriteria(parsed.evaluationCriteria || starterCriteria)
      setCriteriaVersion(Number(parsed.criteriaVersion) || 1)
      setInputs(Array.isArray(parsed.inputs) && parsed.inputs.length ? parsed.inputs : [starterInput])
      setUserInstruction(parsed.userInstruction || '')
      setCurrentRuns(Array.isArray(parsed.currentRuns) ? parsed.currentRuns : [])
      setHistory(Array.isArray(parsed.history) ? parsed.history : [])
      setOriginalResult(parsed.originalResult ?? null)
      setBestResult(parsed.bestResult ?? null)
      setLastCandidate(parsed.lastCandidate ?? null)
      setDiffBefore(parsed.diffBefore || '')
      setLogs(Array.isArray(parsed.logs) ? [makeLog('sistema', 'Progresso importado', 'Sessão carregada de JSON; carregue a chave para continuar.'), ...parsed.logs].slice(0, 80) : [
        makeLog('sistema', 'Progresso importado', 'Sessão carregada de JSON; carregue a chave para continuar.'),
      ])
      setRunSuggestion(null)
      setSuggestionDraft('')
      setStatus('stopped')
      setErrorMessage('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao importar progresso.'
      setStatus('error')
      setErrorMessage(message)
      appendLog('sistema', 'Importação falhou', message)
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = ''
      }
    }
  }

  async function evaluateRun(run: PromptRun) {
    try {
      const config = buildConfig()
      const controller = new AbortController()
      abortRef.current = controller
      setEvaluatingRunId(run.id)
      setErrorMessage('')
      appendLog('criterios', 'Avaliando run', `Buscando lacunas nos critérios a partir do input ${run.inputIndex + 1}.`)

      const suggestion = await evaluateRunForCriteria(config, run, controller.signal)
      setRunSuggestion(suggestion)
      setSuggestionDraft(suggestion.proposedCriterion)
      appendLog('criterios', 'Sugestão criada', suggestion.title)
    } catch (error) {
      handleRuntimeError(error)
    } finally {
      setEvaluatingRunId('')
    }
  }

  function acceptSuggestion() {
    if (!runSuggestion) return

    const criterion = suggestionDraft.trim()
    if (!criterion) {
      setErrorMessage('A sugestão aceita precisa conter um critério.')
      return
    }

    const nextCriteria = `${evaluationCriteria.trim()}\n${criterion.startsWith('-') ? criterion : `- ${criterion}`}`
    resetResultsForCriteriaChange(nextCriteria)
    setRunSuggestion(null)
    setSuggestionDraft('')
  }

  function rejectSuggestion() {
    setRunSuggestion(null)
    setSuggestionDraft('')
    appendLog('criterios', 'Sugestão rejeitada', 'Os critérios atuais foram preservados.')
  }

  function buildConfig(): BootcampConfig {
    if (!apiKeyRef.current.trim()) {
      throw new Error('Informe a chave da OpenRouter antes de iniciar.')
    }

    if (!model.trim()) {
      throw new Error('Informe o modelo que será usado nas chamadas.')
    }

    if (!taskInstructions.trim()) {
      throw new Error('Descreva a tarefa que o prompt deve executar.')
    }

    if (!evaluationCriteria.trim()) {
      throw new Error('Defina os critérios de avaliação.')
    }

    if (cleanInputs.length === 0) {
      throw new Error('Inclua pelo menos um input de teste.')
    }

    return {
      apiKey: apiKeyRef.current.trim(),
      model: model.trim(),
      seedPrompt: seedPrompt.trim(),
      taskInstructions: taskInstructions.trim(),
      evaluationCriteria: evaluationCriteria.trim(),
      inputs: cleanInputs,
      userInstruction: userInstruction.trim(),
    }
  }

  async function start() {
    try {
      const config = buildConfig()
      const controller = new AbortController()
      abortRef.current = controller
      setStatus('running')
      setErrorMessage('')
      setCurrentRuns([])
      setHistory([])
      setOriginalResult(null)
      setBestResult(null)
      setLastCandidate(null)
      setDiffBefore('')
      appendLog('sistema', 'Sessão iniciada', `${RUNS_PER_PROMPT} avaliações serão usadas por prompt.`)

      const initialPrompt =
        config.seedPrompt ||
        (await createInitialPrompt(config, controller.signal).then((prompt) => {
          appendLog('criador', 'Prompt inicial criado', 'O campo de prompt estava vazio; o CRIADOR gerou um system prompt do zero.')
          return prompt
        }))

      appendLog('executor', 'Baseline em execução', 'Rodando o prompt inicial contra os inputs de teste.')
      const baseline = await runPromptEvaluation(
        config,
        initialPrompt,
        'Baseline',
        (run) => setCurrentRuns((runs) => [...runs, run]),
        controller.signal,
      )

      setOriginalResult(baseline)
      setBestResult(baseline)
      setHistory([baseline])
      appendLog('avaliador', 'Baseline avaliado', `Nota média ${baseline.averageScore}/10. Pior run: ${baseline.minScore}/10.`)

      await searchForImprovement(config, baseline, baseline, '', controller)
    } catch (error) {
      handleRuntimeError(error)
    }
  }

  async function continueSession() {
    if (!bestResult || !originalResult) {
      appendLog('sistema', 'Nada para continuar', 'Inicie uma sessão antes de enviar instruções.')
      return
    }

    const instruction = userInstruction.trim()

    if (/^parar$/i.test(instruction)) {
      stop(false)
      setStatus('stopped')
      appendLog('usuario', 'Sessão parada', 'O usuário solicitou parada manual.')
      return
    }

    try {
      const config = buildConfig()
      const controller = new AbortController()
      abortRef.current = controller
      setStatus('running')
      setErrorMessage('')
      setCurrentRuns([])
      appendLog('usuario', 'Instrução enviada', instruction || 'Continuar sem instrução adicional.')

      await searchForImprovement(config, bestResult, originalResult, instruction, controller)
    } catch (error) {
      handleRuntimeError(error)
    }
  }

  async function searchForImprovement(
    config: BootcampConfig,
    currentBest: PromptResult,
    original: PromptResult,
    instruction: string,
    controller: AbortController,
  ) {
    const activeBest = currentBest
    let inferiorTurns = 0

    while (inferiorTurns < 3) {
      appendLog('criador', `Turno ${history.length + inferiorTurns + 1}`, 'Criando um candidato por diff conceitual.')
      const candidate = await createCandidatePrompt(config, activeBest, original, instruction, controller.signal)
      setLastCandidate(candidate)
      setDiffBefore(activeBest.prompt)
      setCurrentRuns([])
      appendLog('criador', 'Candidato pronto', candidate.rationale)

      const result = await runPromptEvaluation(
        config,
        candidate.prompt,
        `Candidato ${history.length + inferiorTurns + 1}`,
        (run) => setCurrentRuns((runs) => [...runs, run]),
        controller.signal,
      )

      setHistory((items) => [result, ...items])

      if (result.averageScore > activeBest.averageScore) {
        setBestResult(result)
        setStatus('paused')
        appendLog(
          'avaliador',
          'Melhora encontrada',
          `Novo prompt: ${result.averageScore}/10 contra ${activeBest.averageScore}/10. A sessão pausou para revisão do diff.`,
        )
        return
      }

      inferiorTurns += 1
      appendLog(
        'avaliador',
        'Candidato descartado',
        `Nota ${result.averageScore}/10 não superou ${activeBest.averageScore}/10. Piora consecutiva ${inferiorTurns}/3.`,
      )
    }

    setStatus('done')
    appendLog('sistema', 'Sem melhora suficiente', 'Três turnos consecutivos não superaram o melhor prompt atual.')
  }

  function handleRuntimeError(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      setStatus('stopped')
      appendLog('sistema', 'Execução interrompida', 'As chamadas em andamento foram canceladas.')
      return
    }

    const message = error instanceof Error ? error.message : 'Erro desconhecido.'
    setStatus('error')
    setErrorMessage(message)
    appendLog('sistema', 'Erro', message)
  }

  function stop(markStatus = true) {
    abortRef.current?.abort()
    abortRef.current = null
    if (markStatus) {
      setStatus('stopped')
      appendLog('sistema', 'Parada solicitada', 'A execução será interrompida assim que a chamada atual responder ao cancelamento.')
    }
  }

  function updateInput(index: number, value: string) {
    setInputs((items) => items.map((item, itemIndex) => (itemIndex === index ? value : item)))
  }

  function addInput() {
    setInputs((items) => [...items, ''])
  }

  function removeInput(index: number) {
    setInputs((items) => (items.length === 1 ? [''] : items.filter((_, itemIndex) => itemIndex !== index)))
  }

  const diffParts = useMemo(() => {
    if (!bestResult || !diffBefore) return []
    return diffLines(diffBefore, bestResult.prompt)
  }, [bestResult, diffBefore])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PB</span>
          <div>
            <h1>Prompt Bootcamp</h1>
            <p>Otimização adversarial local com OpenRouter</p>
          </div>
        </div>
        <div className={`status-pill status-${status}`}>
          {isRunning ? <Loader2 size={15} className="spin" /> : <Activity size={15} />}
          <span>{statusLabel(status)}</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel" aria-label="Configuração da sessão">
          <Panel title="Chave e modelo" icon={<KeyRound size={17} />}>
            <label>
              <span>OpenRouter API key</span>
              <input
                type="password"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder="sk-or-..."
                autoComplete="off"
              />
            </label>
            <div className="key-row">
              <span className={hasApiKey ? 'key-loaded' : 'key-empty'}>
                {hasApiKey ? 'Chave ativa em memória' : 'Nenhuma chave carregada'}
              </span>
              <button type="button" className="secondary-button compact" onClick={loadApiKey} disabled={!apiKeyDraft.trim()}>
                <KeyRound size={14} />
                Usar chave
              </button>
              <button type="button" className="icon-button" onClick={clearApiKey} disabled={!hasApiKey} aria-label="Limpar chave">
                <X size={15} />
              </button>
            </div>
            <label>
              <span>Modelo padrão</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <div className="action-row utility-actions">
              <button type="button" className="secondary-button" onClick={exportProgress}>
                <Download size={15} />
                Exportar
              </button>
              <button type="button" className="secondary-button" onClick={() => importInputRef.current?.click()} disabled={isRunning}>
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

          <Panel title="Prompt e tarefa" icon={<Bot size={17} />}>
            <label>
              <span>Prompt para melhoria</span>
              <textarea
                value={seedPrompt}
                onChange={(event) => setSeedPrompt(event.target.value)}
                placeholder="Opcional. Se ficar vazio, o CRIADOR gera um prompt do zero."
                rows={7}
              />
            </label>
            <label>
              <span>Instruções da tarefa</span>
              <textarea value={taskInstructions} onChange={(event) => setTaskInstructions(event.target.value)} rows={5} />
            </label>
          </Panel>

          <Panel title="Critérios e inputs" icon={<ClipboardList size={17} />}>
            <label>
              <span>Critérios de avaliação · v{criteriaVersion}</span>
              <textarea
                value={evaluationCriteria}
                onChange={(event) => setEvaluationCriteria(event.target.value)}
                rows={8}
              />
            </label>
            <div className="input-list">
              <div className="row-title">
                <span>Inputs de teste</span>
                <button type="button" className="icon-button" onClick={addInput} aria-label="Adicionar input">
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
                  />
                  <button type="button" className="icon-button danger" onClick={() => removeInput(index)} aria-label="Remover input">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Controle humano" icon={<Send size={17} />}>
            <textarea
              value={userInstruction}
              onChange={(event) => setUserInstruction(event.target.value)}
              placeholder="Quando pausar: continuar, parar ou escreva uma instrução adicional."
              rows={4}
            />
            <div className="action-row">
              <button type="button" className="primary-button" onClick={start} disabled={isRunning}>
                <Play size={16} />
                Iniciar
              </button>
              <button type="button" className="secondary-button" onClick={() => stop()} disabled={!isRunning}>
                <Square size={15} />
                Parar
              </button>
              <button type="button" className="secondary-button" onClick={continueSession} disabled={!canSend || isRunning}>
                <Send size={15} />
                Enviar
              </button>
            </div>
            {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          </Panel>
        </aside>

        <section className="board" aria-label="Painel de agentes">
          <div className="score-strip">
            <MetricCard label="Prompt original" value={originalResult ? `${originalResult.averageScore}/10` : 'sem nota'} score={originalResult?.averageScore} />
            <MetricCard label="Melhor prompt" value={bestResult ? `${bestResult.averageScore}/10` : 'sem nota'} score={bestResult?.averageScore} />
            <MetricCard label="Runs do turno" value={`${currentRuns.length}/${RUNS_PER_PROMPT}`} />
            <MetricCard label="Falhas operacionais" value={String(currentFailedRuns)} />
          </div>

          <div className="agent-grid">
            <AgentPanel title="CRIADOR" icon={<Bot size={18} />} tone="creator">
              {lastCandidate ? (
                <>
                  <p className="muted">{lastCandidate.rationale}</p>
                  <pre className="code-block">{lastCandidate.diff}</pre>
                </>
              ) : (
                <Empty text="Aguardando geração de candidato." />
              )}
            </AgentPanel>

            <AgentPanel title="EXECUÇÕES" icon={<RotateCw size={18} />} tone="runner">
              {currentRuns.length ? (
                <div className="run-list">
                  {currentRuns.map((run, index) => (
                    <article className="run-card" key={run.id}>
                      <div className="run-head">
                        <strong>Run {index + 1}</strong>
                        <span className={run.status === 'completed' ? scoreClass(run.evaluation.score) : 'score-muted'}>
                          {run.status === 'completed' ? `${run.evaluation.score}/10` : runStatusLabel(run.status)}
                        </span>
                      </div>
                      <p>{run.output || run.error || 'Run sem output disponível.'}</p>
                      <div className="run-actions">
                        <button
                          type="button"
                          className="secondary-button compact"
                          onClick={() => void evaluateRun(run)}
                          disabled={isRunning || Boolean(evaluatingRunId)}
                        >
                          {evaluatingRunId === run.id ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
                          Avaliar run
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty text="Os outputs aparecem aqui em tempo real." />
              )}
            </AgentPanel>

            <AgentPanel title="AVALIADOR" icon={<ShieldCheck size={18} />} tone="evaluator">
              {currentRuns.length ? (
                <div className="evaluation-list">
                  {currentRuns.map((run, index) => (
                    <div className="evaluation-row" key={`eval-${run.id}`}>
                      <span>#{index + 1}</span>
                      <strong className={run.status === 'completed' ? scoreClass(run.evaluation.score) : 'score-muted'}>
                        {run.status === 'completed' ? `${run.evaluation.score}/10` : 'falhou'}
                      </strong>
                      <p>{run.evaluation.summary}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty text="Cada output será avaliado isoladamente." />
              )}
            </AgentPanel>

            <AgentPanel title="MELHOR PROMPT" icon={<ClipboardList size={18} />} tone="best">
              {bestResult ? (
                <>
                  <div className="prompt-meta">
                    <span>Média {bestResult.averageScore}/10</span>
                    <span>Mín. {bestResult.minScore}/10</span>
                    <span>Máx. {bestResult.maxScore}/10</span>
                    <span>Válidos {bestResult.completedRuns}/{RUNS_PER_PROMPT}</span>
                    <span>Falhas {bestResult.failedRuns}</span>
                  </div>
                  <pre className="prompt-box">{bestResult.prompt}</pre>
                </>
              ) : (
                <Empty text="O melhor prompt será exibido após o baseline." />
              )}
            </AgentPanel>

            <AgentPanel title="HISTÓRICO" icon={<Activity size={18} />} tone="history">
              {history.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Turno</th>
                      <th>Nota</th>
                      <th>Min/Max</th>
                      <th>Válidos</th>
                      <th>Falhas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item) => (
                      <tr key={item.id}>
                        <td>{item.label}</td>
                        <td className={scoreClass(item.averageScore)}>{item.averageScore}/10</td>
                        <td>
                          {item.minScore}/{item.maxScore}
                        </td>
                        <td>{item.completedRuns}/{RUNS_PER_PROMPT}</td>
                        <td>{item.failedRuns}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty text="Sem turnos avaliados ainda." />
              )}
            </AgentPanel>

            <AgentPanel title="LOG" icon={<Diff size={18} />} tone="log">
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

      {runSuggestion ? (
        <section className="suggestion-drawer" aria-label="Sugestão do avaliador de run">
          <div className="diff-header">
            <div>
              <h2>{runSuggestion.title}</h2>
              <p>Escopo: {scopeLabel(runSuggestion.scope)}. Aceitar altera os critérios e reinicia a avaliação do zero.</p>
            </div>
            <button type="button" className="icon-button" onClick={rejectSuggestion} aria-label="Fechar sugestão">
              <X size={15} />
            </button>
          </div>
          <div className="suggestion-body">
            <section>
              <strong>Evidência</strong>
              <p>{runSuggestion.evidence}</p>
            </section>
            <section>
              <strong>Risco</strong>
              <p>{runSuggestion.risk}</p>
            </section>
            <section>
              <strong>Exemplo de pontuação</strong>
              <p>{runSuggestion.scoringExample}</p>
            </section>
            <label>
              <span>Critério proposto</span>
              <textarea value={suggestionDraft} onChange={(event) => setSuggestionDraft(event.target.value)} rows={4} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={acceptSuggestion}>
                <Check size={16} />
                Aceitar e reiniciar
              </button>
              <button type="button" className="secondary-button" onClick={rejectSuggestion}>
                <X size={15} />
                Rejeitar
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {status === 'paused' && bestResult ? (
        <section className="diff-drawer" aria-label="Diff visual do prompt">
          <div className="diff-header">
            <div>
              <h2>Melhora encontrada</h2>
              <p>Revise o diff. Use Enviar para continuar, parar ou orientar o próximo turno.</p>
            </div>
            <span className={scoreClass(bestResult.averageScore)}>{bestResult.averageScore}/10</span>
          </div>
          <div className="diff-grid">
            {diffParts.map((part, index) => (
              <pre
                className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-context'}
                key={`diff-${index}`}
              >
                {part.value}
              </pre>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  )
}

function statusLabel(status: Status) {
  const labels: Record<Status, string> = {
    idle: 'pronto',
    running: 'rodando',
    paused: 'pausado',
    stopped: 'parado',
    error: 'erro',
    done: 'concluído',
  }
  return labels[status]
}

function runStatusLabel(status: PromptRun['status']) {
  const labels: Record<PromptRun['status'], string> = {
    completed: 'ok',
    output_failed: 'output falhou',
    evaluation_failed: 'avaliador falhou',
  }
  return labels[status]
}

function scopeLabel(scope: RunCriterionSuggestion['scope']) {
  const labels: Record<RunCriterionSuggestion['scope'], string> = {
    global: 'global',
    especialidade: 'especialidade',
    formato: 'formato',
    seguranca: 'segurança',
    concisao: 'concisão',
    outro: 'outro',
  }
  return labels[scope]
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header>
        {icon}
        <h2>{title}</h2>
      </header>
      <div className="panel-body">{children}</div>
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
        {icon}
        <h2>{title}</h2>
      </header>
      <div className="agent-body">{children}</div>
    </section>
  )
}

function MetricCard({ label, value, score }: { label: string; value: string; score?: number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong className={scoreClass(score)}>{value}</strong>
    </article>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>
}

export default App
