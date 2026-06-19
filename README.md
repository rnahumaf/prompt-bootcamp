# Prompt Bootcamp

Sistema local para treinar prompts por ciclos curtos: gerar output, receber correção humana, aplicar um patch no prompt e gerar novamente.

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

## Fluxo

### Treino sem input

1. O usuário insere o prompt e clica em `Gerar`.
2. O modelo cria um output a partir do próprio prompt.
3. O usuário reescreve o output ideal ou descreve a correção.
4. Ao clicar em `Corrigir`, o app pede um patch para o prompt e gera um novo output.
5. O ciclo se repete até o usuário clicar em `OK`.
6. O prompt final aparece lado a lado com o prompt inicial, com diff e botão de copiar.

### Treino com input

1. O usuário insere o prompt e uma lista de inputs.
2. Ao clicar em `Gerar`, o app escolhe um input aleatório e gera o output.
3. O usuário corrige o output por reescrita ou comentário.
4. Antes de corrigir, o usuário escolhe se o próximo turno repete o mesmo input ou usa outro input aleatório.
5. Ao clicar em `Corrigir`, o app atualiza o prompt e gera o próximo output.
6. O ciclo se repete até `OK`, quando o diff final é exibido.

## Exportar e importar

- `Exportar` gera um JSON com prompt, histórico, inputs e logs, sem incluir a chave.
- `Importar` carrega uma sessão anterior; a chave precisa ser carregada novamente.
- Arquivos antigos `schemaVersion` 2 ou 3 também são aceitos para migração básica: o app importa o prompt e a lista de inputs, ignorando notas, critérios e runs do fluxo antigo.

## Scripts

```bash
npm run dev      # API local + Vite
npm run build    # typecheck + build do frontend
npm run lint     # ESLint
```

## Estrutura

- `server/server.ts`: proxy local para OpenRouter.
- `src/lib/bootcamp.ts`: geração de outputs e revisão do prompt por patch.
- `src/App.tsx`: interface principal e estado do treino.
- `AGENTS.md`: contrato curto para agentes que forem trabalhar neste repo.
