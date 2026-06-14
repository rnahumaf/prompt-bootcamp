import type { AutoMetrics } from '../types'

export function collectAutoMetrics(output: string): AutoMetrics {
  const trimmed = output.trim()
  const paragraphs = trimmed.length === 0 ? 0 : trimmed.split(/\n\s*\n/).filter(Boolean).length
  const fenceCount = (output.match(/```/g) ?? []).length

  return {
    characters: [...output].length,
    paragraphs,
    markdownFenceBalanced: fenceCount % 2 === 0,
    hasReplacementCharacters: output.includes('�'),
    hasLikelyEncodingIssue: /Ã.|Â.|â€|â€™|â€œ|â€/.test(output),
  }
}

export function emptyAutoMetrics(): AutoMetrics {
  return {
    characters: 0,
    paragraphs: 0,
    markdownFenceBalanced: true,
    hasReplacementCharacters: false,
    hasLikelyEncodingIssue: false,
  }
}

export function summarizeMetrics(metrics: AutoMetrics) {
  return [
    `Caracteres: ${metrics.characters}`,
    `Parágrafos: ${metrics.paragraphs}`,
    `Markdown íntegro: ${metrics.markdownFenceBalanced ? 'sim' : 'não'}`,
    `Caracteres quebrados: ${
      metrics.hasReplacementCharacters || metrics.hasLikelyEncodingIssue ? 'sim' : 'não'
    }`,
  ].join('; ')
}
