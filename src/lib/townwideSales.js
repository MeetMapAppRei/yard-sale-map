function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function mmddyyyyToIso(s) {
  const m = norm(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const mm = String(m[1]).padStart(2, '0')
  const dd = String(m[2]).padStart(2, '0')
  const yyyy = m[3]
  return `${yyyy}-${mm}-${dd}`
}

function parseTimeTokenToMinutes(token) {
  const t = norm(token).toLowerCase()
  let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (m) {
    let hh = Number(m[1])
    const mm = Number(m[2] || '0')
    const ap = String(m[3]).toLowerCase()
    if (ap === 'pm' && hh < 12) hh += 12
    if (ap === 'am' && hh === 12) hh = 0
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null
    return hh * 60 + mm
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/)
  if (m) {
    const hh = Number(m[1])
    const mm = Number(m[2])
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null
    return hh * 60 + mm
  }
  return null
}

function extractTimeRangeFromComments(comments) {
  const c = norm(comments)
  if (!c) return { openMinutes: null, closeMinutes: null }
  const m =
    c.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i) ||
    c.match(/(\d{1,2}:\d{2})\s*[-–—to]+\s*(\d{1,2}:\d{2})/i)
  if (m?.[1] && m?.[2]) {
    return {
      openMinutes: parseTimeTokenToMinutes(m[1]),
      closeMinutes: parseTimeTokenToMinutes(m[2]),
    }
  }
  const one = c.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i) || c.match(/\b(\d{1,2}:\d{2})\b/)
  if (one?.[1]) {
    return { openMinutes: parseTimeTokenToMinutes(one[1]), closeMinutes: null }
  }
  return { openMinutes: null, closeMinutes: null }
}

/**
 * Parse copied table text with columns like:
 * Sale Date | Rain Date | Street Address | Town | Comments
 *
 * Key rule: **never confuse Sale Date with Rain Date**.
 * We always use the FIRST date in the row as the sale date.
 */
export function extractTownwideRowsFromText(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n')
  if (!raw.trim()) return []

  const lines = raw
    .split('\n')
    .map((l) => norm(l))
    .filter(Boolean)

  const out = []
  for (const line of lines) {
    if (/^sale date\b/i.test(line)) continue
    if (/^rain date\b/i.test(line)) continue
    if (/^street address\b/i.test(line)) continue
    if (/^town\b/i.test(line)) continue
    if (/^comments?\b/i.test(line)) continue

    const parts = line.includes('\t')
      ? line.split('\t').map(norm)
      : line.split(/\s{2,}/).map(norm)

    const dates = Array.from(line.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g)).map((m) => m[0])
    const saleDateIso = mmddyyyyToIso(dates[0] || '')
    if (!saleDateIso) continue

    // Find likely address cell: first cell with a leading number OR a street suffix.
    const address =
      parts.find((p) => /^\d{1,6}\b/.test(p)) ||
      parts.find((p) =>
        /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|pl|place|way|pkwy|parkway|ter|terrace|trl|trail)\b/i.test(
          p,
        ),
      ) ||
      ''
    if (!address) continue

    const addrIdx = parts.findIndex((p) => norm(p).toLowerCase() === norm(address).toLowerCase())
    const town = addrIdx >= 0 ? norm(parts[addrIdx + 1] || '') : ''
    const comments = addrIdx >= 0 ? norm(parts.slice(addrIdx + 2).join(' ')) : ''
    const { openMinutes, closeMinutes } = extractTimeRangeFromComments(comments)

    out.push({
      saleDateIso,
      address: norm(address),
      town,
      comments,
      openMinutes,
      closeMinutes,
    })
  }

  const seen = new Set()
  const deduped = []
  for (const r of out) {
    const k = `${r.saleDateIso}|${r.address.toLowerCase()}|${(r.town || '').toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(r)
  }
  return deduped
}

/**
 * Parse OCR text from Laserfiche mobile/table-like forms where each sale appears as:
 * SaleDate line, RainDate line, Address line, Town line, Comments line (sometimes comments span multiple lines).
 *
 * Key rule: **never confuse Sale Date with Rain Date**.
 * We use the first date in the block as the sale date; the second date is ignored.
 */
export function extractLaserficheRowsFromOcr(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n')
  if (!raw.trim()) return []
  const lines = raw
    .split('\n')
    .map((l) => norm(l))
    .filter(Boolean)

  const isDate = (s) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(norm(s))
  const isNoise = (s) => {
    const v = norm(s).toLowerCase()
    return v === 'mm/dd/yyyy' || v === 'default page' || v === 'laserfiche' || v === 'new submission'
  }

  const looksLikeTown = (s) => /^[A-Za-z .'-]{3,}$/.test(norm(s)) && !/\d/.test(s)
  const looksLikeAddressLine = (s) => {
    const v = norm(s)
    if (!v) return false
    if (v.length < 5) return false
    if (isDate(v) || isNoise(v)) return false
    // Start with number (house or street number) OR include common street tokens.
    if (/^\d{1,6}\b/.test(v)) return true
    if (/\b(ave|avenue|st|street|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|pkwy|parkway|way|pl|place|trl|trail)\b/i.test(v))
      return true
    return false
  }

  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]
    if (!isDate(a)) continue
    const saleDateIso = mmddyyyyToIso(a)
    if (!saleDateIso) continue

    // Skip rain date if present on next line.
    let j = i + 1
    if (j < lines.length && isDate(lines[j])) j += 1

    // Address/Town: within the next few lines, pick the best address-looking line and the next town-looking line.
    const window = lines.slice(j, Math.min(lines.length, j + 7)).filter((x) => !isDate(x) && !isNoise(x))
    const address = window.find(looksLikeAddressLine) || window[0] || ''
    if (!address) continue
    const addrPos = lines.indexOf(address, j)
    let k = addrPos >= 0 ? addrPos + 1 : j + 1
    while (k < lines.length && (isDate(lines[k]) || isNoise(lines[k]))) k += 1
    const town = k < lines.length && looksLikeTown(lines[k]) ? lines[k] : ''
    j = k + 1

    // Comments: collect until the next date (start of next block) or blank.
    const commentParts = []
    while (j < lines.length && !isDate(lines[j])) {
      if (!isNoise(lines[j])) commentParts.push(lines[j])
      j += 1
      // Most entries have 1 line of comments; stop early if it looks like we already captured enough
      // and the next line looks like the start of another block.
      if (commentParts.length >= 2 && j < lines.length && isDate(lines[j])) break
    }
    const comments = norm(commentParts.join(' '))
    const { openMinutes, closeMinutes } = extractTimeRangeFromComments(comments)

    rows.push({
      saleDateIso,
      address: norm(address),
      town: norm(town),
      comments,
      openMinutes,
      closeMinutes,
    })

    // Continue scanning from where we stopped to avoid re-detecting inside the block.
    i = Math.max(i, j - 1)
  }

  const seen = new Set()
  const deduped = []
  for (const r of rows) {
    const k = `${r.saleDateIso}|${r.address.toLowerCase()}|${(r.town || '').toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(r)
  }
  return deduped
}

