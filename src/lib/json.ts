export function parseJsonObject<T>(content: string): T {
  const direct = content.trim()

  try {
    return JSON.parse(direct) as T
  } catch {
    const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
    if (fenced) {
      return JSON.parse(fenced) as T
    }

    const first = direct.indexOf('{')
    const last = direct.lastIndexOf('}')
    if (first >= 0 && last > first) {
      return JSON.parse(direct.slice(first, last + 1)) as T
    }

    throw new Error('Resposta não contém JSON válido.')
  }
}
