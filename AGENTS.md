# AGENTS.md

## Regras do repo

- Use PT-BR com UTF-8 em UI, README e textos gerados.
- Mantenha mudanças pequenas e ligadas ao pedido.
- Não salve chaves OpenRouter em arquivo, banco, `localStorage` ou logs.
- Preserve o modelo padrão `deepseek/deepseek-v4-flash`, salvo pedido explícito.
- Rode `npm run build` após mudanças em TypeScript, Vite, servidor ou fluxo de agentes.

## Arquitetura

- `server/server.ts` expõe o proxy local `/api/openrouter/chat`.
- `src/lib/bootcamp.ts` contém a lógica de baseline, candidato, execução e avaliação.
- `src/App.tsx` deve ficar como composição de UI e estado, sem lógica pesada de prompt.

## Gotchas

- O avaliador deve receber um output por vez, sem saber se veio do prompt antigo ou novo.
- Cada candidato deve ser comparado contra o melhor prompt atual, não contra o candidato imediatamente anterior.
- A chave da OpenRouter deve permanecer efêmera durante a sessão.
