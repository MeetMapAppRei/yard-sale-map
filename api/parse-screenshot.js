/**
 * Vercel Node serverless: vision extract via Anthropic Claude (screenshots).
 * Set ANTHROPIC_API_KEY in Vercel (or .env.local for `vercel dev`).
 */

function jsonResponse(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(status).send(JSON.stringify(body))
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
    'You extract yard sale, garage sale, and estate sale listings from screenshots. Reply with ONLY valid JSON, no markdown or code fences.'

  const userText = `Extract these fields for the flyer/post in the image:
- title: short human title (e.g. "Multi-family sale")
- address_line: best full street address + city + state + ZIP if visible; else best address fragment
- occurrences: array of one or more sale days. If the flyer lists multiple days (Fri + Sat), include one entry per day.
  - date_iso: "YYYY-MM-DD" (REQUIRED whenever any date/time appears — e.g. "Thu Apr 2 2026", "4/2/2026", "When: ...")
  - open_time_24h: "HH:MM" 24h clock, or null if unknown
  - close_time_24h: "HH:MM" 24h, or null if unknown
  If NO date is visible anywhere, return [].
- summary_text: all readable sale-related text, concatenated sensibly. MUST include the sale date/time line verbatim if present (e.g. "When: Thu, Apr 2, 2026 @ 8:00 AM - 2:00 PM").

JSON shape exactly:
{"title":"","address_line":"","occurrences":[{"date_iso":"","open_time_24h":null,"close_time_24h":null}],"summary_text":""}`

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
        max_tokens: 1024,
        temperature: 0.2,
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

    return jsonResponse(res, 200, {
      title: String(parsed.title || '').trim(),
      address_line: String(parsed.address_line || '').trim(),
      occurrences: Array.isArray(parsed.occurrences) ? parsed.occurrences : [],
      summary_text: String(parsed.summary_text || '').trim(),
    })
  } catch (e) {
    return jsonResponse(res, 500, { error: e.message || String(e) })
  }
}
