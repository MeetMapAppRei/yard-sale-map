/**
 * Trip-day weather using Open-Meteo (no API key).
 * @see https://open-meteo.com/en/docs
 */

function isRainyCode(code) {
  const c = Number(code)
  if (!Number.isFinite(c)) return false
  // Drizzle, rain, freezing rain, showers, thunderstorm ranges (WMO)
  if (c >= 51 && c <= 67) return true
  if (c >= 80 && c <= 82) return true
  if (c >= 95 && c <= 99) return true
  return false
}

/**
 * @param {{ lat: number, lon: number, isoDate: string }} p
 * @returns {Promise<{ level: 'ok' | 'watch' | 'wet', headline: string, detail?: string }>}
 */
export async function fetchTripDayWeather({ lat, lon, isoDate }) {
  const clean = String(isoDate || '').trim()
  if (!clean || lat == null || lon == null) {
    return { level: 'ok', headline: 'Set a starting point and trip day for weather.' }
  }

  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(lat))
  url.searchParams.set('longitude', String(lon))
  url.searchParams.set('daily', 'weathercode,precipitation_probability_max,precipitation_sum')
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', '16')

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const t =
    ctrl &&
    setTimeout(() => {
      try {
        ctrl.abort()
      } catch {
        /* ignore */
      }
    }, 12000)

  let res
  try {
    res = await fetch(url.toString(), { signal: ctrl?.signal })
  } finally {
    if (t) clearTimeout(t)
  }

  if (!res.ok) {
    return { level: 'ok', headline: 'Weather check didn’t load — try again later.' }
  }

  const j = await res.json()
  const daily = j?.daily
  const times = daily?.time
  if (!Array.isArray(times)) {
    return { level: 'ok', headline: 'Weather data unavailable for this area.' }
  }

  const idx = times.indexOf(clean)
  if (idx < 0) {
    return {
      level: 'ok',
      headline: 'No forecast yet for that day (too far out or past).',
      detail: 'Open-Meteo usually covers about two weeks ahead.',
    }
  }

  const code = daily.weathercode?.[idx]
  const pop = Number(daily.precipitation_probability_max?.[idx]) || 0
  const precip = Number(daily.precipitation_sum?.[idx]) || 0
  const rainy = isRainyCode(code)
  const highPop = pop >= 55
  const wetDay = rainy || highPop || precip >= 4

  if (wetDay) {
    const bits = []
    if (rainy) bits.push('rain in the forecast')
    if (highPop) bits.push(`${Math.round(pop)}% chance of precipitation`)
    if (precip >= 4) bits.push(`~${precip.toFixed(1)} mm expected`)
    return {
      level: 'wet',
      headline: 'Wet weather possible — curb sales may cancel or move.',
      detail: bits.length ? bits.join(' · ') : 'Check the sky before you head out.',
    }
  }

  if (pop >= 25 || precip >= 1) {
    return {
      level: 'watch',
      headline: 'Light rain possible — worth an umbrella.',
      detail: `${Math.round(pop)}% chance of precipitation`,
    }
  }

  return {
    level: 'ok',
    headline: 'Mostly dry day in the forecast for your area.',
    detail: 'Forecasts change; Open-Meteo via this app is a hint, not a guarantee.',
  }
}
