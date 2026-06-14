# Prompt Bootcamp

Sistema local para melhorar prompts por iteração adversarial. O usuário informa a própria chave da OpenRouter, define tarefa, critérios e inputs de teste. O app roda um baseline, cria candidatos, executa 10 avaliações por prompt e mantém somente o candidato que superar o melhor resultado atual.

## Como rodar

```bash
npm install
npm run dev
```

Abra o endereço mostrado pelo Vite, normalmente `http://127.0.0.1:5173`.

## Modelo padrão

O modelo inicial da UI é:

```txt
deepseek/deepseek-v4-flash
```

O campo é editável caso o ID do modelo na OpenRouter precise de ajuste.

## Segurança da chave

- A chave é digitada na UI e enviada apenas ao proxy local em `http://127.0.0.1:8787`.
- Depois de clicar em `Usar chave`, o campo é limpo e a chave fica apenas em memória durante a sessão.
- O servidor local repassa a chamada para `https://openrouter.ai/api/v1/chat/completions`.
- A chave não é salva por padrão em arquivo, banco ou `localStorage`.

## Fluxo V1

1. Se houver prompt inicial, ele vira o baseline. Se o campo estiver vazio, o CRIADOR gera um prompt do zero.
2. O baseline é executado 10 vezes contra os inputs de teste.
3. O AVALIADOR avalia cada output isoladamente, com métricas automáticas anexadas.
4. O CRIADOR propõe um novo prompt com diff conceitual e prompt final completo.
5. O candidato é executado 10 vezes.
6. Se a média superar o melhor prompt atual, o sistema pausa e mostra o diff visual.
7. Se três candidatos consecutivos não melhorarem a nota, a sessão é encerrada.

Falhas operacionais de API ou de parsing do avaliador não entram na média do prompt. O app tenta retries e reparo de JSON antes de marcar um run como falho.

## V2

- O CRIADOR também tem reparo de JSON quando retorna Markdown ou texto livre.
- `Exportar` gera um arquivo JSON com progresso, histórico, runs, critérios e melhor prompt, sem incluir a chave.
- `Importar` carrega um arquivo de progresso para continuar uma sessão anterior após carregar uma nova chave.
- Cada run tem o botão `Avaliar run`, que aciona um avaliador de critérios.
- Sugestões aceitas são adicionadas aos critérios, incrementam a versão dos critérios e reiniciam a avaliação do zero.
- Notas antigas não são comparadas após alteração de critérios.

## Performance e cache

- O app envia um `session_id` estável para a OpenRouter durante a sessão. Isso favorece sticky routing e prompt caching em modelos/provedores compatíveis.
- O progresso exportado preserva o `session_id`, permitindo continuar a sessão anterior com a mesma afinidade de roteamento após importar o JSON.
- O response cache explícito da OpenRouter não é ativado por padrão nos runs de avaliação, porque respostas idênticas por cache poderiam reduzir a variância que o bootcamp tenta medir.
- Os 10 runs de cada prompt são executados em paralelo por padrão. O campo `Execuções paralelas` permite reduzir de 10 até 1 se houver rate limit, erro transitório do provedor ou instabilidade local.

## Scripts

```bash
npm run dev      # API local + Vite
npm run build    # typecheck + build do frontend
npm run lint     # ESLint
```

## Estrutura

- `server/server.ts`: proxy local para OpenRouter.
- `src/lib/bootcamp.ts`: orquestra CRIADOR, EXECUTOR e AVALIADOR.
- `src/lib/metrics.ts`: métricas automáticas de output.
- `src/App.tsx`: interface principal.
- `AGENTS.md`: contrato curto para agentes que forem trabalhar neste repo.
