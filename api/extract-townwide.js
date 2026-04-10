/**
 * Best-effort URL -> townwide rows extractor.
 * Works for pages where the table is server-rendered in HTML.
 *
 * NOTE: Laserfiche sandbox/grid pages often require session-bound API calls; those may return 0 rows.
 */

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36'

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function safeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|table|thead|tbody|tfoot|section|article|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function extractTableRows(html) {
  const h = String(html || '')
  const rows = []
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let tr
  while ((tr = trRe.exec(h))) {
    const trHtml = tr[1] || ''
    const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
    const cells = []
    let c
    while ((c = cellRe.exec(trHtml))) {
      const cellHtml = c[2] || ''
      const text = norm(decodeEntities(stripTags(cellHtml)))
      cells.push(text)
    }
    if (cells.length) rows.push(cells)
  }
  return rows
}

function isTownwideHeaderRow(cells) {
  const blob = cells.map((c) => norm(c).toLowerCase()).join(' | ')
  return (
    blob.includes('sale date') &&
    blob.includes('rain date') &&
    (blob.includes('street address') || blob.includes('address')) &&
    blob.includes('town')
  )
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
    return { openMinutes: parseTimeTokenToMinutes(m[1]), closeMinutes: parseTimeTokenToMinutes(m[2]) }
  }
  const one = c.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i) || c.match(/\b(\d{1,2}:\d{2})\b/)
  if (one?.[1]) return { openMinutes: parseTimeTokenToMinutes(one[1]), closeMinutes: null }
  return { openMinutes: null, closeMinutes: null }
}

function parseTownwideFromRows(rows) {
  // Find the townwide table by header row if possible.
  let startIdx = rows.findIndex(isTownwideHeaderRow)
  if (startIdx < 0) startIdx = 0
  const slice = rows.slice(startIdx, startIdx + 2500)

  const out = []
  for (const cells of slice) {
    const line = cells.map((c) => norm(c)).filter((c) => c !== '')
    if (!line.length) continue
    if (isTownwideHeaderRow(cells)) continue

    const dateRaw = line.find((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c)) || ''
    const saleDateIso = mmddyyyyToIso(dateRaw)
    if (!saleDateIso) continue

    const address =
      line.find((c) => /^\d{1,6}\b/.test(c)) ||
      line.find((c) =>
        /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|pl|place|way|pkwy|parkway|ter|terrace|trl|trail)\b/i.test(
          c,
        ),
      ) ||
      ''
    if (!address) continue

    const addrIdx = line.findIndex((c) => norm(c).toLowerCase() === norm(address).toLowerCase())
    const town = addrIdx >= 0 ? norm(line[addrIdx + 1] || '') : ''
    const comments = addrIdx >= 0 ? norm(line.slice(addrIdx + 2).join(' ')) : ''
    const { openMinutes, closeMinutes } = extractTimeRangeFromComments(comments)

    out.push({ saleDateIso, address: norm(address), town, comments, openMinutes, closeMinutes })
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

async function fetchHtml(url) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller?.signal,
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, text }
    return { ok: true, status: res.status, text }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(status).send(JSON.stringify(body))
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return json(res, 400, { error: 'Invalid JSON' })
    }
  }

  const url = safeHttpUrl(body?.url)
  if (!url) return json(res, 400, { error: 'Missing or invalid url' })

  const fetched = await fetchHtml(url)
  if (!fetched.ok) {
    return json(res, 200, { rows: [], warning: `Could not fetch page (${fetched.status}).` })
  }

  const rows = extractTableRows(fetched.text)
  const parsed = rows.length ? parseTownwideFromRows(rows) : []
  return json(res, 200, {
    rows: parsed,
    warning: parsed.length ? '' : 'No townwide table rows found on that page.',
  })
}

