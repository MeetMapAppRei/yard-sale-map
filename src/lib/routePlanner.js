import { haversineKm, milesToKm } from './haversine.js'

function travelMinutes(from, to, avgKmh) {
  const km = haversineKm(from.lat, from.lon, to.lat, to.lon)
  return (km / Math.max(avgKmh, 5)) * 60
}

/**
 * Greedy route with time windows. Times are minutes from midnight (same day).
 * @param {{
 *   home: { lat: number, lon: number },
 *   startMinutes: number,
 *   sales: Array<{
 *     id: string,
 *     lat: number,
 *     lon: number,
 *     openMinutes: number | null,
 *     closeMinutes: number | null,
 *     priorityScore: number,
 *     title?: string,
 *   }>,
 *   settings: { avgKmh: number, dwellMinutes: number, searchRadiusMiles: number },
 * }} params
 */
export function planRoute({ home, startMinutes, sales, settings }) {
  if (!home || !sales?.length) {
    return { ordered: [], legs: [], message: 'Set home and at least one geocoded sale.' }
  }

  const radiusKm = milesToKm(settings.searchRadiusMiles)
  const dwell = Math.max(5, settings.dwellMinutes)
  const avgKmh = Math.max(5, settings.avgKmh)

  const inRadius = sales.filter((s) => {
    if (s.lat == null || s.lon == null) return false
    return haversineKm(home.lat, home.lon, s.lat, s.lon) <= radiusKm
  })

  if (!inRadius.length) {
    return { ordered: [], legs: [], message: 'No sales within your search radius with coordinates.' }
  }

  const unvisited = new Set(inRadius.map((s) => s.id))
  const ordered = []
  const legs = []

  let current = { lat: home.lat, lon: home.lon }
  let time = startMinutes

  while (unvisited.size > 0) {
    let best = null
    let bestMerit = -Infinity

    for (const id of unvisited) {
      const sale = inRadius.find((s) => s.id === id)
      if (!sale) continue
      const travel = travelMinutes(current, sale, avgKmh)
      let arrival = time + travel

      if (sale.openMinutes != null && arrival < sale.openMinutes) {
        arrival = sale.openMinutes
      }

      if (sale.closeMinutes != null && arrival > sale.closeMinutes) {
        continue
      }

      const priority = Math.max(0, Number(sale.priorityScore) || 0)
      // Prefer earlier-opening sales slightly when scores are close (tie-break).
      const earlyOpenBonus =
        sale.openMinutes != null ? (24 * 60 - sale.openMinutes) / 20000 : 0.05
      const merit = priority * 15 - travel + earlyOpenBonus

      if (merit > bestMerit) {
        bestMerit = merit
        best = { sale, travel, arrival }
      }
    }

    if (!best) {
      break
    }

    const { sale, travel, arrival } = best
    unvisited.delete(sale.id)

    legs.push({
      from: current,
      to: { lat: sale.lat, lon: sale.lon },
      travelMinutes: travel,
      arrivalMinutes: arrival,
      saleId: sale.id,
    })

    ordered.push({
      ...sale,
      plannedArrivalMinutes: arrival,
      travelFromPreviousMinutes: travel,
    })

    current = { lat: sale.lat, lon: sale.lon }
    time = arrival + dwell
  }

  const skipped = inRadius.filter((s) => !ordered.find((o) => o.id === s.id))

  return {
    ordered,
    legs,
    skipped,
    message:
      skipped.length > 0
        ? `${skipped.length} sale(s) could not be fit (time windows or optimizer stopped early).`
        : null,
  }
}
