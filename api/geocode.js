/**
 * Server-side Nominatim proxy — proper User-Agent + same-origin from the deployed app.
 * https://operations.osmfoundation.org/policies/nominatim/
 */

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
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' })
  }

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return json(res, 400, { error: 'Invalid JSON' })
    }
  }

  const q = String(body?.q || '').trim()
  if (!q) {
    return json(res, 400, { error: 'Missing q' })
  }

  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', q)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')

  try {
    const r = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en',
        'User-Agent': 'YardSaleMap/1.0 (personal deployment; contact via app owner)',
      },
    })
    if (!r.ok) {
      return json(res, 502, { error: `Geocode upstream ${r.status}` })
    }
    const data = await r.json()
    const hit = data[0]
    if (!hit) {
      return json(res, 404, { error: 'No results for that address' })
    }
    return json(res, 200, {
      lat: parseFloat(hit.lat),
      lon: parseFloat(hit.lon),
      displayName: hit.display_name,
    })
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) })
  }
}
