import { guessAddressLine, sanitizeAddressLine } from './ocr.js'
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
  if (String(ai?.address_line || '').trim()) {
    addressGuess = sanitizeAddressLine(String(ai.address_line).trim())
  }
  if (ai?.title) title = String(ai.title).slice(0, 80)
  const aiFieldsBlob = [ai?.title, ai?.address_line, ai?.summary_text].filter(Boolean).join('\n')
  // Vision model summary often has readable dates even when Tesseract misses colored flyer text.
  const schedule = dedupeOccurrencesByDate([
    ...extractSaleSchedule(text),
    ...extractSaleSchedule(String(ai?.summary_text || '')),
    ...extractSaleSchedule(aiFieldsBlob),
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
