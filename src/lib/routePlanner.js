import { haversineKm, milesToKm } from './haversine.js'

/**
 * Plain-language summary of how the ordered list was built (kept in sync with planRoute).
 */
function orderExplanationText({
  strategy,
  searchRadiusMiles,
  inRadiusCount,
  skippedCount,
}) {
  const strategySentence =
    strategy === 'fastest'
      ? 'From each stop, the next sale is whichever remaining one is the shortest drive away (estimated from distance and your speed—not live traffic).'
      : 'From each stop, the next sale favors your keyword matches, then shorter drives when scores are similar (same distance estimates as above).'

  let text = `Only sales on the map within ${searchRadiusMiles} miles of your starting point are considered (${inRadiusCount} here). ${strategySentence} If you’d arrive before a sale opens, the plan waits until opening time; if you’d arrive after closing, that sale is skipped for that step.`

  if (skippedCount > 0) {
    text += ` ${skippedCount} sale(s) could not be slotted in—usually because of hours or no valid “next stop” left.`
  }

  return text
}

function travelMinutes(from, to, avgKmh) {
  const km = haversineKm(from.lat, from.lon, to.lat, to.lon)
  return (km / Math.max(avgKmh, 5)) * 60
}

function stripRouteTimingFields(s) {
  const { plannedArrivalMinutes, travelFromPreviousMinutes, arrivalAfterClose, ...rest } = s
  return rest
}

/**
 * Recompute legs and arrival times for a fixed stop order (e.g. after the user reorders).
 * Same travel + dwell + open-wait rules as {@link planRoute}, but visits sales in array order.
 */
export function computeRouteSequence({ home, startMinutes, orderedSales, settings }) {
  if (!home || !orderedSales?.length) {
    return { ordered: [], legs: [] }
  }
  const dwell = Math.max(5, settings.dwellMinutes)
  const avgKmh = Math.max(5, settings.avgKmh)
  const legs = []
  const ordered = []
  let current = { lat: home.lat, lon: home.lon }
  let time = startMinutes

  for (const raw of orderedSales) {
    const sale = stripRouteTimingFields(raw)
    if (sale.lat == null || sale.lon == null) continue
    const travel = travelMinutes(current, sale, avgKmh)
    let arrival = time + travel
    if (sale.openMinutes != null && arrival < sale.openMinutes) {
      arrival = sale.openMinutes
    }
    const arrivalAfterClose = sale.closeMinutes != null && arrival > sale.closeMinutes

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
      arrivalAfterClose,
    })

    current = { lat: sale.lat, lon: sale.lon }
    time = arrival + dwell
  }

  return { ordered, legs }
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
 *   settings: { avgKmh: number, dwellMinutes: number, searchRadiusMiles: number, routeStrategy?: 'fastest' | 'keywords' },
 * }} params
 */
export function planRoute({ home, startMinutes, sales, settings }) {
  const strategy = settings?.routeStrategy === 'fastest' ? 'fastest' : 'keywords'
  if (!home || !sales?.length) {
    return {
      ordered: [],
      legs: [],
      routeStrategy: strategy,
      orderExplanation: null,
      message: 'Set your starting point and use “Put on map” on at least one sale first.',
    }
  }

  const radiusKm = milesToKm(settings.searchRadiusMiles)
  const dwell = Math.max(5, settings.dwellMinutes)
  const avgKmh = Math.max(5, settings.avgKmh)

  const inRadius = sales.filter((s) => {
    if (s.lat == null || s.lon == null) return false
    return haversineKm(home.lat, home.lon, s.lat, s.lon) <= radiusKm
  })

  if (!inRadius.length) {
    return {
      ordered: [],
      legs: [],
      routeStrategy: strategy,
      orderExplanation: null,
      message: 'No sales on the map within your distance limit—or they still need addresses placed on the map.',
    }
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
      let merit
      if (strategy === 'fastest') {
        // Nearest-neighbor on travel time: minimize minutes driving to the next stop.
        merit = -travel + earlyOpenBonus * 0.25
      } else {
        // Keywords: weight interest score heavily, then prefer shorter hops.
        merit = priority * 15 - travel + earlyOpenBonus
      }

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
    routeStrategy: strategy,
    orderExplanation:
      ordered.length > 0
        ? orderExplanationText({
            strategy,
            searchRadiusMiles: settings.searchRadiusMiles,
            inRadiusCount: inRadius.length,
            skippedCount: skipped.length,
          })
        : null,
    message:
      skipped.length > 0
        ? `${skipped.length} sale(s) didn’t fit open/close times or the planner stopped early—check times or try again.`
        : null,
  }
}

const KM_TO_MI = 0.621371

/**
 * Total straight-line driving distance across legs plus time-on-road (same estimates as the planner, not live traffic).
 * @param {{ legs?: Array<{ travelMinutes?: number, from?: { lat: number, lon: number }, to?: { lat: number, lon: number } }>, ordered?: Array<{ travelFromPreviousMinutes?: number }> }} p
 */
export function summarizeRouteDrivingStats({ legs, ordered }) {
  let driveMin = 0
  let km = 0
  if (Array.isArray(legs) && legs.length) {
    for (const leg of legs) {
      driveMin += Number(leg.travelMinutes) || 0
      if (leg.from?.lat != null && leg.to?.lat != null) {
        km += haversineKm(leg.from.lat, leg.from.lon, leg.to.lat, leg.to.lon)
      }
    }
  } else if (Array.isArray(ordered) && ordered.length) {
    for (const s of ordered) {
      driveMin += Number(s.travelFromPreviousMinutes) || 0
    }
  }
  return {
    totalMiles: km > 0 ? km * KM_TO_MI : 0,
    totalDriveMinutes: Math.round(driveMin),
  }
}
