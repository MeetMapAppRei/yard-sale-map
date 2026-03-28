/**
 * Vercel Node serverless: vision extract for yard/garage sale screenshots.
 * Set OPENAI_API_KEY in the Vercel project (or .env.local for `vercel dev`).
 */

function jsonResponse(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(status).send(JSON.stringify(body))
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

  const key = process.env.OPENAI_API_KEY
  if (!key) {
    return jsonResponse(res, 503, {
      error: 'Server missing OPENAI_API_KEY. Add it in Vercel env or run vercel dev with .env.local.',
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
  const mimeType = body?.mimeType || 'image/jpeg'
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing imageBase64' })
  }

  const approxBytes = (imageBase64.length * 3) / 4
  if (approxBytes > 6 * 1024 * 1024) {
    return jsonResponse(res, 413, { error: 'Image too large (max ~6MB)' })
  }

  const system =
    'You extract yard sale, garage sale, and estate sale listings from screenshots. Reply with ONLY valid JSON, no markdown.'

  const userText = `Extract these fields for the flyer/post in the image:
- title: short human title (e.g. "Multi-family sale")
- address_line: best full street address + city + state + ZIP if visible; else best address fragment
- open_time_24h: opening time as "HH:MM" 24h clock, or null if unknown
- close_time_24h: closing time as "HH:MM" 24h, or null if unknown
- summary_text: all readable sale-related text, concatenated sensibly

JSON shape exactly:
{"title":"","address_line":"","open_time_24h":null,"close_time_24h":null,"summary_text":""}`

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
        max_tokens: 900,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
      }),
    })

    const raw = await openaiRes.text()
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return jsonResponse(res, 502, { error: 'OpenAI returned non-JSON', detail: raw.slice(0, 200) })
    }

    if (!openaiRes.ok) {
      return jsonResponse(res, 502, {
        error: data?.error?.message || data?.error || 'OpenAI request failed',
      })
    }

    const content = data?.choices?.[0]?.message?.content
    if (!content || typeof content !== 'string') {
      return jsonResponse(res, 502, { error: 'Empty model response' })
    }

    let parsed
    const trimmed = content.trim()
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : trimmed)
    } catch {
      return jsonResponse(res, 502, { error: 'Could not parse model JSON', detail: trimmed.slice(0, 300) })
    }

    return jsonResponse(res, 200, {
      title: String(parsed.title || '').trim(),
      address_line: String(parsed.address_line || '').trim(),
      open_time_24h: parsed.open_time_24h ?? null,
      close_time_24h: parsed.close_time_24h ?? null,
      summary_text: String(parsed.summary_text || '').trim(),
    })
  } catch (e) {
    return jsonResponse(res, 500, { error: e.message || String(e) })
  }
}
