const KEY = 'yard-sale-map-v1'

const LIST_SORT_MODES = new Set(['newest', 'distance', 'opens', 'match', 'title'])

export function normalizeListSortMode(v) {
  return LIST_SORT_MODES.has(v) ? v : 'newest'
}

const HIDE_VISITED_DAYS = new Set([0, 7, 14, 30, 60, 90])

export function normalizeHideVisitedDays(v) {
  const n = Number(v)
  return HIDE_VISITED_DAYS.has(n) ? n : 0
}

const TRIP_DAY_MODES = new Set(['today', 'future'])

export function normalizeTripDayMode(v) {
  return TRIP_DAY_MODES.has(v) ? v : 'today'
}

const ROUTE_STRATEGIES = new Set(['fastest', 'keywords'])

/** Fastest = minimize driving between stops; keywords = favor interest matches, then distance. */
export function normalizeRouteStrategy(v) {
  return ROUTE_STRATEGIES.has(v) ? v : 'keywords'
}

const COLOR_SCHEMES = new Set(['dark', 'light'])

/** UI appearance: dark (default) or light. */
export function normalizeColorScheme(v) {
  return COLOR_SCHEMES.has(v) ? v : 'dark'
}

/** Guided wizard vs full single-page layout. */
export function normalizeUiLayout(v) {
  return v === 'full' ? 'full' : 'guided'
}

/** Current step in guided mode (1–4). */
export function normalizeGuidedStep(v) {
  const n = Number(v)
  if (Number.isFinite(n) && n >= 1 && n <= 4) return Math.floor(n)
  return 1
}

export function normalizeIsoDate(v) {
  const s = String(v || '').trim()
  if (!s) return null
  // Prefer the canonical HTML date input format.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    const yyyy = iso[1]
    const mm = String(Math.min(12, Math.max(1, Number(iso[2])))).padStart(2, '0')
    const dd = String(Math.min(31, Math.max(1, Number(iso[3])))).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }

  // Some environments (older webviews / non-date inputs) may yield MM/DD/YYYY.
  const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (us) {
    const mm = String(Math.min(12, Math.max(1, Number(us[1])))).padStart(2, '0')
    const dd = String(Math.min(31, Math.max(1, Number(us[2])))).padStart(2, '0')
    const yyyy = String(Number(us[3]))
    if (/^\d{4}$/.test(yyyy)) return `${yyyy}-${mm}-${dd}`
  }

  // Occasionally: YYYY/MM/DD
  const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/)
  if (ymd) {
    const yyyy = String(Number(ymd[1]))
    const mm = String(Math.min(12, Math.max(1, Number(ymd[2])))).padStart(2, '0')
    const dd = String(Math.min(31, Math.max(1, Number(ymd[3])))).padStart(2, '0')
    if (/^\d{4}$/.test(yyyy)) return `${yyyy}-${mm}-${dd}`
  }

  return null
}

function loadRaw() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function loadState() {
  const raw = loadRaw()
  if (!raw || typeof raw !== 'object') {
    return {
      home: null,
      sales: [],
      interests: defaultInterests(),
      settings: {
        avgKmh: 40,
        dwellMinutes: 20,
        searchRadiusMiles: 50,
        showPriorityOnly: false,
        listSortMode: 'newest',
        hideVisitedWithinDays: 0,
        tripDayMode: 'today',
        tripDayIso: null,
        routeStrategy: 'keywords',
        colorScheme: 'dark',
        gettingStartedDismissed: false,
        uiLayout: 'guided',
        guidedStep: 1,
      },
    }
  }
  const interestsRaw = Array.isArray(raw.interests) ? raw.interests : null
  return {
    home: raw.home ?? null,
    sales: Array.isArray(raw.sales) ? raw.sales : [],
    interests: normalizeInterests(interestsRaw),
    settings: {
      avgKmh: Number(raw.settings?.avgKmh) || 40,
      dwellMinutes: Number(raw.settings?.dwellMinutes) || 20,
      searchRadiusMiles: Number(raw.settings?.searchRadiusMiles) || 50,
      showPriorityOnly: Boolean(raw.settings?.showPriorityOnly),
      listSortMode: normalizeListSortMode(raw.settings?.listSortMode),
      hideVisitedWithinDays: normalizeHideVisitedDays(raw.settings?.hideVisitedWithinDays),
      tripDayMode: normalizeTripDayMode(raw.settings?.tripDayMode),
      tripDayIso: normalizeIsoDate(raw.settings?.tripDayIso),
      routeStrategy: normalizeRouteStrategy(raw.settings?.routeStrategy),
      colorScheme: normalizeColorScheme(raw.settings?.colorScheme),
      gettingStartedDismissed: Boolean(raw.settings?.gettingStartedDismissed),
      uiLayout: normalizeUiLayout(raw.settings?.uiLayout),
      guidedStep: normalizeGuidedStep(raw.settings?.guidedStep),
    },
  }
}

export function saveState(partial) {
  const prev = loadState()
  const next = { ...prev, ...partial }
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}

/** Replace persisted state entirely (e.g. restore from backup). */
export function writeFullState(state) {
  const normalized = {
    home: state.home ?? null,
    sales: Array.isArray(state.sales) ? state.sales : [],
    interests: normalizeInterests(Array.isArray(state.interests) ? state.interests : null),
    settings: {
      avgKmh: Number(state.settings?.avgKmh) || 40,
      dwellMinutes: Number(state.settings?.dwellMinutes) || 20,
      searchRadiusMiles: Number(state.settings?.searchRadiusMiles) || 50,
      showPriorityOnly: Boolean(state.settings?.showPriorityOnly),
      listSortMode: normalizeListSortMode(state.settings?.listSortMode),
      hideVisitedWithinDays: normalizeHideVisitedDays(state.settings?.hideVisitedWithinDays),
      tripDayMode: normalizeTripDayMode(state.settings?.tripDayMode),
      tripDayIso: normalizeIsoDate(state.settings?.tripDayIso),
      routeStrategy: normalizeRouteStrategy(state.settings?.routeStrategy),
      colorScheme: normalizeColorScheme(state.settings?.colorScheme),
      gettingStartedDismissed: Boolean(state.settings?.gettingStartedDismissed),
      uiLayout: normalizeUiLayout(state.settings?.uiLayout),
      guidedStep: normalizeGuidedStep(state.settings?.guidedStep),
    },
  }
  localStorage.setItem(KEY, JSON.stringify(normalized))
  return normalized
}

export function defaultInterests() {
  return [{ id: crypto.randomUUID(), label: 'Keywords', keywords: 'jewelry,video games,tools' }]
}

function normalizeInterests(rows) {
  // New UX: one unified keyword list. For backward compat, merge any older grouped rows into one.
  if (!Array.isArray(rows) || rows.length === 0) return defaultInterests()
  const parts = []
  for (const r of rows) {
    const raw = String(r?.keywords || '')
    raw
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((kw) => parts.push(kw))
  }
  const seen = new Set()
  const deduped = []
  for (const p of parts) {
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(p)
  }
  return [
    {
      id: crypto.randomUUID(),
      label: 'Keywords',
      keywords: deduped.join(', '),
    },
  ]
}

export function upsertSale(sales, sale) {
  const i = sales.findIndex((s) => s.id === sale.id)
  if (i === -1) return [...sales, sale]
  const next = [...sales]
  next[i] = sale
  return next
}

export function removeSale(sales, id) {
  return sales.filter((s) => s.id !== id)
}
