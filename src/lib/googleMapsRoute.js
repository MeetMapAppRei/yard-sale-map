/**
 * Build a Google Maps directions URL (multi-stop) from home and ordered stops with lat/lon.
 * @param {{ lat: number, lon: number }} home
 * @param {Array<{ lat: number, lon: number }>} orderedStops
 */
export function buildGoogleMapsDirectionsUrl(home, orderedStops) {
  const origin = `${home.lat},${home.lon}`
  const base = 'https://www.google.com/maps/dir/?api=1'
  const stops = (orderedStops || []).filter((s) => s.lat != null && s.lon != null && !Number.isNaN(s.lat) && !Number.isNaN(s.lon))

  if (!stops.length) {
    return `${base}&origin=${encodeURIComponent(origin)}`
  }

  if (stops.length === 1) {
    const dest = `${stops[0].lat},${stops[0].lon}`
    return `${base}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&travelmode=driving`
  }

  const last = stops[stops.length - 1]
  const dest = `${last.lat},${last.lon}`
  const wps = stops
    .slice(0, -1)
    .map((s) => `${s.lat},${s.lon}`)
    .join('|')

  return `${base}&origin=${encodeURIComponent(origin)}&waypoints=${encodeURIComponent(wps)}&destination=${encodeURIComponent(dest)}&travelmode=driving`
}
