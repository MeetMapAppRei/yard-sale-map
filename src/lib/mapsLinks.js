/**
 * Open a coordinate as a place in Google / Apple Maps (new tab).
 */
export function buildGoogleMapsPlaceUrl(lat, lon, label) {
  const q = label ? `${lat},${lon} (${label})` : `${lat},${lon}`
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
}

export function buildAppleMapsPlaceUrl(lat, lon, label) {
  const params = new URLSearchParams()
  params.set('ll', `${lat},${lon}`)
  if (label) params.set('q', label)
  return `https://maps.apple.com/?${params.toString()}`
}

/**
 * Multi-stop driving directions (same stop order as our planner). Apple may only honor
 * some stops on certain platforms; Google is the most reliable for full waypoint order.
 */
export function buildAppleMapsDirectionsUrl(home, orderedStops) {
  const origin = `${home.lat},${home.lon}`
  const stops = (orderedStops || []).filter(
    (s) => s.lat != null && s.lon != null && !Number.isNaN(s.lat) && !Number.isNaN(s.lon),
  )

  if (!stops.length) {
    return `https://maps.apple.com/?saddr=${encodeURIComponent(origin)}&dirflg=d`
  }

  let url = `https://maps.apple.com/?saddr=${encodeURIComponent(origin)}&dirflg=d`
  for (const s of stops) {
    url += `&daddr=${encodeURIComponent(`${s.lat},${s.lon}`)}`
  }
  return url
}
