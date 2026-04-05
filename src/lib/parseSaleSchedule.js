import { minutesFromHHMM24, parseTimeInput } from './parseTimes.js'
import { normalizeIsoDate } from './storage.js'

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function isoFromYmd(y, m, d) {
  const yyyy = String(y).padStart(4, '0')
  const mm = String(clamp(m, 1, 12)).padStart(2, '0')
  const dd = String(clamp(d, 1, 31)).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function normalizeIsoDateLoose(v) {
  let s = String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!s) return null
  const embedded = s.match(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/)
  if (embedded) s = embedded[1]
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return isoFromYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (us) return isoFromYmd(Number(us[3]), Number(us[1]), Number(us[2]))
  const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/)
  if (ymd) return isoFromYmd(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))
  return null
}

/** Normalize OCR quirks before date extraction (Tesseract often mangles spacing/punctuation). */
function normalizeScheduleInput(t) {
  let s = String(t || '')
  try {
    s = s.normalize('NFKC')
  } catch {
    /* ignore */
  }
  s = s.replace(/\u00a0/g, ' ')
  // Fullwidth digits / punctuation (common in screenshots)
  s = s.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
  s = s.replace(/\uFF0C/g, ',')
  s = s.replace(/\uFF20/g, '@')
  s = s.replace(/[\u2013\u2014\u2212]/g, '-')
  // Common split-letter month reads from green flyer text
  s = s.replace(/\bAp\s+r\b/gi, 'Apr')
  s = s.replace(/\bAu\s+g\b/gi, 'Aug')
  s = s.replace(/\bSe\s+pt\b/gi, 'Sept')
  s = s.replace(/\bO\s+ct\b/gi, 'Oct')
  s = s.replace(/\bNo\s+v\b/gi, 'Nov')
  s = s.replace(/\bDe\s+c\b/gi, 'Dec')
  return s
}

function extractTimeRangeMinutes(text) {
  const t = String(text || '')
  // Prefer explicit "9:00 AM - 3:00 PM" style ranges.
  const range = t.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i)
  if (range) {
    const open = parseTimeInput(range[1])
    const close = parseTimeInput(range[2])
    return { openMinutes: open, closeMinutes: close }
  }
  // Or a single time like "9am" -> open.
  const single = t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i)
  if (single) return { openMinutes: parseTimeInput(single[1]), closeMinutes: null }
  return { openMinutes: null, closeMinutes: null }
}

export function dedupeOccurrencesByDate(out) {
  const bestByDate = new Map()
  for (const occ of out) {
    if (!occ?.isoDate) continue
    const key = occ.isoDate
    const prev = bestByDate.get(key)
    const score = (occ.openMinutes != null ? 1 : 0) + (occ.closeMinutes != null ? 1 : 0)
    const prevScore =
      prev == null ? -1 : (prev.openMinutes != null ? 1 : 0) + (prev.closeMinutes != null ? 1 : 0)
    if (!prev || score > prevScore) bestByDate.set(key, occ)
  }
  const list = Array.from(bestByDate.values())
  list.sort((a, b) => String(a.isoDate).localeCompare(String(b.isoDate)))
  return list
}

/**
 * Extract one-or-more dated occurrences from flyer text.
 * Returns list of { isoDate, openMinutes, closeMinutes } (sorted, de-duped).
 */
export function extractSaleSchedule(text, now = new Date()) {
  let t = normalizeScheduleInput(text)
  // Tesseract often drops colored "When:" lines from the main blob; repeating the line helps matching.
  const whenChunks = []
  const reWhen = /(?:^|[\n\r])\s*when\s*:?\s*([^\n\r]+)/gi
  let wm
  while ((wm = reWhen.exec(t)) !== null) {
    whenChunks.push(wm[1].trim())
  }
  if (whenChunks.length) {
    t = `${t}\n${whenChunks.join('\n')}`
  }

  const out = []

  // 0) Inline ISO dates (some OCR/AI emits these even when month-name lines fail).
  const reInlineIso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g
  let im
  while ((im = reInlineIso.exec(t)) !== null) {
    const iso = isoFromYmd(Number(im[1]), Number(im[2]), Number(im[3]))
    const tail = t.slice(im.index, Math.min(t.length, im.index + 90))
    const { openMinutes, closeMinutes } = extractTimeRangeMinutes(tail)
    out.push({ isoDate: iso, openMinutes, closeMinutes })
  }

  // 1) Look for lines like "Fri, Apr 3, 2026 @ 9:00 AM - 3:00 PM" or "Apr 2. 2026 at 8:00 AM"
  const monthNames = Object.keys(MONTHS).join('|')
  const reNamed =
    new RegExp(
      String.raw`(?:\b(?:mon|tue|wed|thu|fri|sat|sun)\b[,\s.]*)?` +
        // OCR: "Apr 2, 2026" / "Apr2,2026" / "Apr. 2. 2026" — year may follow comma, space, or period
        String.raw`\b(${monthNames})\b\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:[,\s.]+(\d{4}))?` +
        // Time often after @ or "at" (OCR drops @); keep captures tight so parseTimeInput works
        String.raw`(?:[^\n\r]{0,120}?(?:@|(?:\bat\b))\s*` +
        String.raw`(\d{1,2}:\d{2}\s*(?:am|pm))\s*(?:-|–|to)\s*(\d{1,2}:\d{2}\s*(?:am|pm)))?`,
      'gi',
    )

  let m
  while ((m = reNamed.exec(t)) !== null) {
    const monStr = m[1]
    const dayStr = m[2]
    const yearStr = m[3]
    const openRaw = m[4]
    const closeRaw = m[5]
    const mon = MONTHS[String(monStr || '').toLowerCase()]
    if (!mon || Number.isNaN(Number(dayStr))) continue
    const day = Number(dayStr)
    const year = yearStr ? Number(yearStr) : now.getFullYear()
    const iso = isoFromYmd(year, mon, day)
    const open = openRaw ? parseTimeInput(openRaw) : null
    const close = closeRaw ? parseTimeInput(closeRaw) : null
    const sliceStart = Math.max(0, (m.index || 0) - 2)
    const slice = t.slice(sliceStart, Math.min(t.length, sliceStart + 160))
    const fallback = extractTimeRangeMinutes(slice)
    out.push({
      isoDate: iso,
      openMinutes: open ?? fallback.openMinutes,
      closeMinutes: close ?? fallback.closeMinutes,
    })
  }

  // 1b) Month + day + year without @ time (still want the date)
  const reNamedDateOnly = new RegExp(
    String.raw`(?:\b(?:mon|tue|wed|thu|fri|sat|sun)\b[,\s.]*)?` +
      String.raw`\b(${monthNames})\b\.?\s*(\d{1,2})(?:st|nd|rd|th)?[,\s.]+(\d{4})\b`,
    'gi',
  )
  while ((m = reNamedDateOnly.exec(t)) !== null) {
    const mon = MONTHS[String(m[1] || '').toLowerCase()]
    if (!mon) continue
    const day = Number(m[2])
    const year = Number(m[3])
    const iso = isoFromYmd(year, mon, day)
    const slice = t.slice(m.index, Math.min(t.length, m.index + 120))
    const { openMinutes, closeMinutes } = extractTimeRangeMinutes(slice)
    out.push({ isoDate: iso, openMinutes, closeMinutes })
  }

  // 2) Numeric dates: 3/30/2026 or 2026-03-30, optionally with a time range nearby.
  const reNumeric = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b([^\n\r]{0,80})/gi
  while ((m = reNumeric.exec(t)) !== null) {
    const iso = normalizeIsoDateLoose(m[1])
    if (!iso) continue
    const nearby = `${m[1]} ${m[2] || ''}`
    const { openMinutes, closeMinutes } = extractTimeRangeMinutes(nearby)
    out.push({ isoDate: iso, openMinutes, closeMinutes })
  }

  return dedupeOccurrencesByDate(out)
}

/**
 * Rows from /api parse-screenshot `occurrences` (always union these — vision often sees dates OCR misses).
 */
export function scheduleRowsFromAiOccurrences(ai) {
  const occ = []
  const aiOcc = ai?.occurrences
  if (!Array.isArray(aiOcc)) return occ
  for (const row of aiOcc) {
    const iso = normalizeIsoDateLoose(row?.date_iso)
    if (!iso) continue
    occ.push({
      isoDate: iso,
      openMinutes: row?.open_time_24h ? minutesFromHHMM24(String(row.open_time_24h)) : null,
      closeMinutes: row?.close_time_24h ? minutesFromHHMM24(String(row.close_time_24h)) : null,
    })
  }
  return occ
}

/**
 * Merge AI schedule (if provided) with OCR-derived schedule.
 * AI format supported:
 * - { occurrences: [{ date_iso, open_time_24h, close_time_24h }] }
 */
export function mergeAiSchedule(ai, ocrText) {
  const occ = scheduleRowsFromAiOccurrences(ai)
  const fromOcr = extractSaleSchedule(ocrText)
  const synthetic = extractSaleSchedule(
    [...occ.map((x) => `${x.isoDate} ${x.openMinutes ?? ''} ${x.closeMinutes ?? ''}`), '\n', String(ocrText || '')].join(
      '',
    ),
  )
  return dedupeOccurrencesByDate([...fromOcr, ...occ, ...synthetic])
}

/**
 * Backfill: infer saleDate from rawText when missing (older imports / OCR missed colored text).
 * Only fills when exactly one calendar day is found.
 */
export function migrateSaleDates(sales) {
  if (!Array.isArray(sales)) return sales
  return sales.map((sale) => {
    if (!sale || typeof sale !== 'object') return sale
    if (normalizeIsoDate(sale.saleDate)) return sale
    const inf = extractSaleSchedule(sale.rawText || '')
    if (inf.length !== 1) return sale
    return {
      ...sale,
      saleDate: inf[0].isoDate,
      openMinutes: sale.openMinutes ?? inf[0].openMinutes,
      closeMinutes: sale.closeMinutes ?? inf[0].closeMinutes,
    }
  })
}

/**
 * Day shown in lists / trip rules: stored saleDate, else a single inferred day from rawText,
 * else earliest date if multiple are parsed (better than showing “unknown”).
 */
export function getSaleDayIso(sale) {
  const stored = normalizeIsoDate(sale?.saleDate)
  if (stored) return stored
  const inferred = extractSaleSchedule(sale?.rawText || '')
  if (inferred.length === 0) return null
  inferred.sort((a, b) => String(a.isoDate).localeCompare(String(b.isoDate)))
  return inferred[0].isoDate
}

