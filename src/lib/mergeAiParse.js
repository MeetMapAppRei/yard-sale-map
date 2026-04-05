import { guessAddressLine } from './ocr.js'
import { extractOpenMinutes } from './parseTimes.js'
import { dedupeOccurrencesByDate, extractSaleSchedule, mergeAiSchedule } from './parseSaleSchedule.js'

/**
 * @param {null | { summary_text?: string, address_line?: string, title?: string, occurrences?: Array<{ date_iso?: string, open_time_24h?: string | null, close_time_24h?: string | null }> }} ai
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
  // Vision model summary often has readable dates even when Tesseract misses colored flyer text.
  const schedule = dedupeOccurrencesByDate([
    ...extractSaleSchedule(text),
    ...extractSaleSchedule(String(ai?.summary_text || '')),
    ...mergeAiSchedule(ai, rawText),
  ])
  if (schedule.length === 1) {
    if (schedule[0].openMinutes != null) openMinutes = schedule[0].openMinutes
    if (schedule[0].closeMinutes != null) closeMinutes = schedule[0].closeMinutes
  }

  return {
    rawText,
    addressQuery: addressGuess,
    title,
    openMinutes,
    closeMinutes,
    schedule,
  }
}
