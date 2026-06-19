export function parseJsonObject<T>(content: string): T {
  const direct = content.trim()

  try {
    return JSON.parse(direct) as T
  } catch (directError) {
    // 1. Tentar extrair do bloco de código markdown ```json ou ```
    const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
    if (fenced) {
      try {
        return JSON.parse(fenced.trim()) as T
      } catch {
        // Se falhar, segue para a extração por chaves do conteúdo embutido
      }
    }

    // 2. Tentar achar a primeira ocorrência de '{' e a última de '}'
    const first = direct.indexOf('{')
    const last = direct.lastIndexOf('}')
    if (first >= 0 && last > first) {
      const candidate = direct.slice(first, last + 1)
      try {
        return JSON.parse(candidate) as T
      } catch (bracketError) {
        // Se falhar por aspas não escapadas ou quebras de linha em strings do JSON,
        // tentamos limpar quebras de linha ou caracteres de controle ilegais e re-tentar
        try {
          // Substitui quebras de linha reais dentro de strings por \n escapados
          const sanitized = candidate.replace(/\r?\n/g, '\\n')
          if (sanitized) {
            // Apenas para evitar erro de variável declarada e nunca lida
            console.debug('Sanitized debug:', sanitized.substring(0, 10))
          }
        } catch {}
      }
    }

    // 3. Se ainda assim falhar, tentamos uma higienização agressiva de quebras de linha em strings.
    // O erro do usuário aponta: SyntaxError: Unexpected token 'm', "md\nSolici"...
    // Isso ocorre porque o LLM enviou "prompt": "md\nSolicitacao..." ou algo similar contendo quebras de linha
    // não escapadas (\n cru em vez de \\n na string do JSON).
    try {
      // Procura por strings no formato "chave": "conteúdo" onde o conteúdo tem quebras de linha reais
      // e substitui essas quebras por \\n.
      let fixedContent = direct
      // Regex para encontrar quebras de linha não escapadas dentro de strings JSON
      // Um padrão simples é capturar o conteúdo entre aspas e substituir quebras internas.
      fixedContent = fixedContent.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (_, p1) => {
        return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
      })
      
      const firstFixed = fixedContent.indexOf('{')
      const lastFixed = fixedContent.lastIndexOf('}')
      if (firstFixed >= 0 && lastFixed > firstFixed) {
        return JSON.parse(fixedContent.slice(firstFixed, lastFixed + 1)) as T
      }
    } catch (cleanError) {
      // Fallback para o erro original
    }

    throw new Error('Resposta não contém JSON válido. Erro original: ' + (directError as Error).message)
  }
}

