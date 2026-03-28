import { guessAddressLine } from './ocr.js'
import { extractOpenMinutes, minutesFromHHMM24 } from './parseTimes.js'

/**
 * @param {null | { summary_text?: string, address_line?: string, title?: string, open_time_24h?: string | null, close_time_24h?: string | null }} ai
 * @param {string} ocrText
 */
export function mergeOcrAndAi(ai, ocrText) {
  const text = String(ocrText || '')
  let rawText = text
  let addressGuess = guessAddressLine(text)
  let openMinutes = extractOpenMinutes(text)
  let closeMinutes = null
  let title = addressGuess.slice(0, 80) || 'Sale'

  if (ai?.summary_text) {
    rawText = [String(ai.summary_text).trim(), '\n---\nAlso read from the photo:\n', text].join('')
  }
  if (ai?.address_line) addressGuess = String(ai.address_line).trim()
  if (ai?.title) title = String(ai.title).slice(0, 80)
  if (ai?.open_time_24h != null) {
    const om = minutesFromHHMM24(String(ai.open_time_24h))
    if (om != null) openMinutes = om
  }
  if (ai?.close_time_24h != null) {
    const cm = minutesFromHHMM24(String(ai.close_time_24h))
    if (cm != null) closeMinutes = cm
  }

  return {
    rawText,
    addressQuery: addressGuess,
    title,
    openMinutes,
    closeMinutes,
  }
}
