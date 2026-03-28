/**
 * Best-effort parse of "opens at" from OCR text. Returns minutes from midnight if found.
 */
export function extractOpenMinutes(text) {
  const t = String(text || '')
  const found = []

  const re12 = /\b(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?\b/gi
  let m
  while ((m = re12.exec(t)) !== null) {
    let h = parseInt(m[1], 10)
    const min = parseInt(m[2], 10)
    const ap = m[3]?.toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) found.push(h * 60 + min)
  }

  const reAmpm = /\b(\d{1,2})\s*(am|pm)\b/gi
  while ((m = reAmpm.exec(t)) !== null) {
    let h = parseInt(m[1], 10)
    const ap = m[2].toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h >= 0 && h <= 23) found.push(h * 60)
  }

  if (found.length === 0) return null
  found.sort((a, b) => a - b)
  return found[0]
}

export function minutesToLabel(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`
}

/** "14:30" or "09:00" 24h → minutes from midnight */
export function minutesFromHHMM24(s) {
  if (!s || typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

export function parseTimeInput(value) {
  const s = String(value || '').trim()
  if (!s) return null
  const lower = s.toLowerCase()
  const m = lower.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const ap = m[3]
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (!ap && h <= 11) {
    /* assume morning if no am/pm */
  }
  return h * 60 + min
}
