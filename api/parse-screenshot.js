/**
 * Vercel Node serverless: vision extract via Anthropic Claude (screenshots).
 * Set ANTHROPIC_API_KEY in Vercel (or .env.local for `vercel dev`).
 */

import { checkRateLimit, parseLimitEnv } from './lib/rateLimit.js'
import { extractSaleSchedule } from '../src/lib/parseSaleSchedule.js'

function jsonResponse(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(status).send(JSON.stringify(body))
}

function isUsSlashDate(s) {
  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(s || '').trim())
}

function mmddyyyyToIso(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return ''
  const mm = String(m[1]).padStart(2, '0')
  const dd = String(m[2]).padStart(2, '0')
  return `${m[3]}-${mm}-${dd}`
}

function stripLeadingPinDigit(s) {
  let raw = String(s || '').trim()
  raw = raw.replace(/^[\s@#•]+/, '').trim()
  // - "9 107 Fieldstone Dr"  -> "107 Fieldstone Dr"
  // - "9107 Fieldstone Dr"   -> "107 Fieldstone Dr"
  raw = raw.replace(/^(\d)\s+(\d{1,5}\s+)/, '$2')
  raw = raw.replace(/^(\d)(\d{1,5}\s+)/, '$2')
  return raw.trim()
}

/** Anthropic accepts image/jpeg, image/png, image/gif, image/webp */
function normalizeMediaType(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return 'image/png'
  if (m.includes('gif')) return 'image/gif'
  if (m.includes('webp')) return 'image/webp'
  return 'image/jpeg'
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }
  if (req.method !== 'POST') {
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  const parseMax = parseLimitEnv('RATE_LIMIT_PARSE_MAX', 20)
  const parseWindow = parseLimitEnv('RATE_LIMIT_PARSE_WINDOW_MS', 60_000)
  const limited = checkRateLimit(req, { prefix: 'parse', max: parseMax, windowMs: parseWindow })
  if (!limited.ok) {
    res.setHeader('Retry-After', String(limited.retryAfterSec))
    return jsonResponse(res, 429, {
      error: 'Too many smart-reader requests. Try again shortly or rely on on-device text scan.',
    })
  }

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    return jsonResponse(res, 503, {
      error:
        'Server missing ANTHROPIC_API_KEY. Add it in Vercel → Environment Variables (or .env.local for vercel dev).',
    })
  }

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON body' })
    }
  }

  const imageBase64 = body?.imageBase64
  const mimeType = normalizeMediaType(body?.mimeType)
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing imageBase64' })
  }

  const approxBytes = (imageBase64.length * 3) / 4
  if (approxBytes > 6 * 1024 * 1024) {
    return jsonResponse(res, 413, { error: 'Image too large (max ~6MB)' })
  }

  const system =
    'You are an expert at reading yard sale, garage sale, and estate sale listings from photos, screenshots, and flyers. ' +
    'You carefully extract dates, times, and addresses even from stylized fonts, handwriting, colorful backgrounds, and busy designs. ' +
    'Reply with ONLY valid JSON — no markdown, no code fences, no explanation text before or after.'

  const userText = `Examine this image carefully. It may contain ONE sale listing or MULTIPLE listings (e.g. a townwide form, bulletin board, or table with many rows).

Return ONLY valid JSON matching this schema — every field shown here is required in each sale object:
{
  "sales": [
    {
      "title": "type of sale (e.g. 'Garage Sale', 'Estate Sale', 'Multi-Family Sale')",
      "sale_date_iso": "YYYY-MM-DD format ONLY (e.g. '2026-04-12')",
      "rain_date_iso": "YYYY-MM-DD format ONLY — leave empty string if no rain date label",
      "street_address": "house number + street name only (e.g. '123 Main St')",
      "town": "city or town name only (e.g. 'Woodbridge')",
      "state": "2-letter code if visible (e.g. 'NJ'), else empty string",
      "zip": "5-digit ZIP if visible, else empty string",
      "open_time_24h": "HH:MM 24-hour string (e.g. '09:00') or null if absent",
      "close_time_24h": "HH:MM 24-hour string (e.g. '15:00') or null if absent",
      "comments": "items for sale, special notes, or other details for this listing"
    }
  ],
  "summary_text": "any remaining useful text from the image not captured in sales"
}

━━━ DATE EXTRACTION ━━━
Read every visible date carefully. Common formats on yard sale flyers:
  • Written month:  "Saturday, April 12"  /  "Sat. Apr 12, 2026"  /  "April 12th, 2026"
  • Numeric slash:  "4/12"  /  "4/12/26"  /  "04/12/2026"
  • Numeric dash:   "4-12-26"  /  "2026-04-12"
  • Multi-day:      "April 12 & 13"  or  "Fri-Sat 4/11-4/12"  → create ONE entry per day, same address
  • Year missing:   If no year is shown (e.g. "Apr 12" or "4/12"), use 2026 as the year.
  • sale_date_iso must always be YYYY-MM-DD: "April 12, 2026" → "2026-04-12", "4/12/26" → "2026-04-12"
  • rain_date_iso: ONLY fill when there is an explicit "Rain Date" or "Alternate Date" field label.
    NEVER copy the sale date into rain_date_iso. NEVER use rain_date_iso as the sale date.
  • If only one date visible: put it in sale_date_iso, leave rain_date_iso as empty string "".

━━━ TIME EXTRACTION ━━━
Look carefully — times are often small or on a busy background. Common formats:
  • "9am – 3pm"  /  "9:00 AM – 3:00 PM"  /  "9-3pm"  /  "Opens at 8am"  /  "8:00-2:00"
  • Bare ranges on flyers: "9-3" = 9 AM to 3 PM, "8-1" = 8 AM to 1 PM, "7-12" = 7 AM to 12 PM
  • open_time_24h and close_time_24h must be "HH:MM" 24-hour strings:
      9am → "09:00",  9:00 AM → "09:00",  2pm → "14:00",  3:30 PM → "15:30",  noon → "12:00"
  • If only one time visible (e.g. "Starts at 9am"): set open_time_24h, leave close_time_24h null.
  • Use null (not empty string) when a time field is not found.

━━━ ADDRESS EXTRACTION ━━━
  • street_address = house number + street name + suffix ONLY. Examples: "47 Oak Ave", "123 Main St Apt 2"
    – Do NOT include town, state, or ZIP in street_address.
    – Strip labels like "Where:", "Address:", "Location:" — include only the address text itself.
    – If a single stray digit appears before the real house number (map pin OCR artifact like "9 107 Maple Dr"), remove the leading digit → "107 Maple Dr".
  • town = city/town name only. state = 2-letter code only if visible. zip = 5 digits only if visible.
  • Do NOT invent an address if none is shown — leave street_address as empty string "".

━━━ MULTIPLE LISTINGS ━━━
  • Laserfiche/townwide forms: each block with Sale Date / Rain Date / Address / Town / Comments = one entry.
  • Tables: each row that contains a date or address = one entry.
  • Extract EVERY visible listing — do not skip any.

━━━ FINAL RULES ━━━
  • String fields absent from image → empty string "". Time fields absent → null.
  • Do NOT guess, infer, or fabricate any field not clearly visible in the image.
  • If no listings at all: return {"sales":[], "summary_text":""}`

  // For best vision accuracy on complex flyers, set ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
  // in your Vercel environment variables. Haiku is faster/cheaper but may miss stylized text.
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022'

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.1,
        system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: imageBase64,
                },
              },
              {
                type: 'text',
                text: userText,
              },
            ],
          },
        ],
      }),
    })

    const raw = await anthropicRes.text()
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return jsonResponse(res, 502, { error: 'Anthropic returned non-JSON', detail: raw.slice(0, 200) })
    }

    if (!anthropicRes.ok) {
      const msg = data?.error?.message || data?.error?.type || JSON.stringify(data?.error) || 'Anthropic request failed'
      return jsonResponse(res, 502, { error: msg })
    }

    const blocks = data?.content
    const textOut =
      Array.isArray(blocks)
        ? blocks
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : ''

    if (!textOut || typeof textOut !== 'string') {
      return jsonResponse(res, 502, { error: 'Empty model response' })
    }

    let parsed
    const trimmed = textOut.trim()
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : trimmed)
    } catch {
      return jsonResponse(res, 502, { error: 'Could not parse model JSON', detail: trimmed.slice(0, 300) })
    }

    const summary_text = String(parsed.summary_text || '').trim()
    const salesRaw = Array.isArray(parsed.sales) ? parsed.sales : []
    const sales = salesRaw
      .map((s) => ({
        title: String(s?.title || '').trim(),
        sale_date_iso: String(s?.sale_date_iso || '').trim(),
        rain_date_iso: String(s?.rain_date_iso || '').trim(),
        street_address: String(s?.street_address || '').trim(),
        town: String(s?.town || '').trim(),
        state: String(s?.state || '').trim(),
        zip: String(s?.zip || '').trim(),
        open_time_24h: s?.open_time_24h ?? null,
        close_time_24h: s?.close_time_24h ?? null,
        comments: String(s?.comments || '').trim(),
      }))
      .filter((s) => s.sale_date_iso || s.street_address || s.town || s.comments)

    // Fix common model mis-assignments for Laserfiche forms:
    // - street_address accidentally contains "MM/DD/YYYY"
    // - town accidentally contains "MM/DD/YYYY"
    for (const s of sales) {
      s.street_address = stripLeadingPinDigit(s.street_address)
      if (isUsSlashDate(s.street_address) && !s.sale_date_iso) {
        s.sale_date_iso = mmddyyyyToIso(s.street_address)
        s.street_address = ''
      } else if (isUsSlashDate(s.street_address) && s.sale_date_iso) {
        s.street_address = ''
      }
      if (isUsSlashDate(s.town)) s.town = ''
      if (isUsSlashDate(s.state)) s.state = ''
    }

    // Backfill sale_date_iso when model missed it but the date is present in surrounding text.
    // Strategy: try the listing's own fields first; if still ambiguous, try the whole summary.
    if (sales.length) {
      for (const s of sales) {
        if (s.sale_date_iso) continue
        // Try listing-specific fields first (most precise)
        const listingBlob = [s.title, s.comments, s.street_address, s.town].filter(Boolean).join('\n')
        const fromListing = extractSaleSchedule(listingBlob)
        if (fromListing.length >= 1 && fromListing[0]?.isoDate) {
          s.sale_date_iso = fromListing[0].isoDate
          if (!s.open_time_24h && fromListing[0].openMinutes != null) {
            const h = Math.floor(fromListing[0].openMinutes / 60)
            const m = fromListing[0].openMinutes % 60
            s.open_time_24h = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
          }
          if (!s.close_time_24h && fromListing[0].closeMinutes != null) {
            const h = Math.floor(fromListing[0].closeMinutes / 60)
            const m = fromListing[0].closeMinutes % 60
            s.close_time_24h = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
          }
          continue
        }
        // Fall back: try the whole summary_text if there is only one sale total
        if (sales.length === 1 && summary_text) {
          const fromSummary = extractSaleSchedule(summary_text)
          if (fromSummary.length === 1 && fromSummary[0]?.isoDate) {
            s.sale_date_iso = fromSummary[0].isoDate
          }
        }
      }
    }

    // Backward compatibility for existing client code paths:
    // if there's exactly one sale, also populate legacy top-level fields.
    const legacy = (() => {
      if (sales.length !== 1) return null
      const one = sales[0]
      const address_line = [one.street_address, one.town, one.state, one.zip].filter(Boolean).join(', ')
      return {
        title: one.title,
        address_line,
        occurrences: one.sale_date_iso
          ? [{ date_iso: one.sale_date_iso, open_time_24h: one.open_time_24h, close_time_24h: one.close_time_24h }]
          : [],
      }
    })()

    return jsonResponse(res, 200, {
      sales,
      summary_text,
      ...(legacy ? legacy : {}),
    })
  } catch (e) {
    return jsonResponse(res, 500, { error: e.message || String(e) })
  }
}
