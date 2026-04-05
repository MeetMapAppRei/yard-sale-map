/** Geocoding: use /api/geocode on Vercel (proper Nominatim User-Agent); fall back to direct calls for local Vite. */

let lastCall = 0
const MIN_GAP_MS = 1100

function cleanAddressQuery(input) {
  let q = String(input || '').trim()
  if (!q) return ''
  // Strip common flyer prefixes that confuse Nominatim.
  q = q.replace(/^(where|address|location)\s*:\s*/i, '')
  q = q.replace(/^the address for this sale is\s*:?\s*/i, '')
  q = q.replace(/^sale\s+(at|location)\s*:?\s*/i, '')
  // If the field accidentally contains multiple lines, keep the most address-looking line.
  const lines = q
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length > 1) {
    const streetish = /\b(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|blvd|way|court|ct\.?|circle|hwy|highway|route)\b/i
    const hasNumber = /\d{1,6}/
    const scored = lines.map((line) => {
      let s = 0
      if (hasNumber.test(line)) s += 2
      if (streetish.test(line)) s += 3
      if (/\b[A-Za-z]+\s*,\s*[A-Z]{2}\b/.test(line)) s += 2
      if (/\b\d{5}(-\d{4})?\b/.test(line)) s += 1
      return { line, s }
    })
    scored.sort((a, b) => b.s - a.s)
    q = scored[0]?.line || lines[0] || q
  }
  return q.trim()
}

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
  // Narrow to US to reduce “no match” on short queries.
  url.searchParams.set('countrycodes', 'us')
  url.searchParams.set('addressdetails', '1')
  // Ask for a few hits and pick the best display name.
  url.searchParams.set('limit', '5')

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en',
    },
  })
  if (!res.ok) throw new Error(`Couldn’t look up that address (${res.status}). Try again in a moment.`)
  const data = await res.json()
  const hit = Array.isArray(data) ? data[0] : null
  if (!hit) throw new Error('No match for that address. Try city, state, or a nearby landmark.')
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    displayName: hit.display_name,
  }
}

async function geocodeViaPhoton(query) {
  // Photon (Komoot) is a free OSM-backed geocoder that doesn't require an API key.
  // https://photon.komoot.io/
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '5')
  url.searchParams.set('lang', 'en')
  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en',
    },
  })
  if (!res.ok) throw new Error(`Couldn’t look up that address (${res.status}).`)
  const data = await res.json()
  const feat = Array.isArray(data?.features) ? data.features[0] : null
  const coords = feat?.geometry?.coordinates
  if (!feat || !Array.isArray(coords) || coords.length < 2) throw new Error('No match for that address.')
  const [lon, lat] = coords
  const props = feat?.properties || {}
  const labelParts = [
    props.name,
    props.housenumber && props.street ? `${props.housenumber} ${props.street}` : null,
    props.city || props.town || props.village,
    props.state,
    props.postcode,
  ].filter(Boolean)
  return {
    lat: Number(lat),
    lon: Number(lon),
    displayName: labelParts.join(', ') || String(props?.name || 'Match'),
  }
}

export async function geocodeAddress(query) {
  const q = cleanAddressQuery(query)
  if (!q) throw new Error('Type an address first.')

  const now = Date.now()
  const wait = Math.max(0, MIN_GAP_MS - (now - lastCall))
  if (wait) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()

  try {
    return await geocodeViaApi(q)
  } catch {
    // In local `vite dev`, /api/* doesn't exist. Browser-to-Nominatim can be flaky due to CORS / policy changes.
    // Try Nominatim direct first, then Photon fallback.
    try {
      // If query lacks a country hint, append one.
      const withCountry = /\b(usa|united states)\b/i.test(q) ? q : `${q}, USA`
      return await geocodeDirect(withCountry)
    } catch (e1) {
      try {
        const withCountry = /\b(usa|united states)\b/i.test(q) ? q : `${q}, USA`
        return await geocodeViaPhoton(withCountry)
      } catch (e2) {
        const msg = String(e1?.message || e2?.message || 'No match for that address.')
        // Helpful hint if the user is in local dev mode without Vercel.
        throw new Error(
          `${msg} If you’re running local dev with “vite”, try “npx vercel dev” (so /api/geocode is available) or use a deployed HTTPS URL.`,
        )
      }
    }
  }
}
