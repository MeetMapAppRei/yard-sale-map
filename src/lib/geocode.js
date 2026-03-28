/** Geocoding: use /api/geocode on Vercel (proper Nominatim User-Agent); fall back to direct calls for local Vite. */

let lastCall = 0
const MIN_GAP_MS = 1100

async function geocodeViaApi(query) {
  const res = await fetch('/api/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query }),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(
      text.slice(0, 120) || `Couldn’t look up that address right now (${res.status}). Try again in a moment.`,
    )
  }
  if (!res.ok) {
    throw new Error(
      data.error || `Couldn’t look up that address right now (${res.status}). Try again in a moment.`,
    )
  }
  return {
    lat: data.lat,
    lon: data.lon,
    displayName: data.displayName,
  }
}

async function geocodeDirect(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en',
    },
  })
  if (!res.ok) throw new Error(`Couldn’t look up that address (${res.status}). Try again in a moment.`)
  const data = await res.json()
  const hit = data[0]
  if (!hit) throw new Error('No match for that address. Try city, state, or a nearby landmark.')
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    displayName: hit.display_name,
  }
}

export async function geocodeAddress(query) {
  const q = String(query || '').trim()
  if (!q) throw new Error('Type an address first.')

  const now = Date.now()
  const wait = Math.max(0, MIN_GAP_MS - (now - lastCall))
  if (wait) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()

  try {
    return await geocodeViaApi(q)
  } catch {
    return geocodeDirect(q)
  }
}
