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
      },
    }
  }
  return {
    home: raw.home ?? null,
    sales: Array.isArray(raw.sales) ? raw.sales : [],
    interests: Array.isArray(raw.interests) ? raw.interests : defaultInterests(),
    settings: {
      avgKmh: Number(raw.settings?.avgKmh) || 40,
      dwellMinutes: Number(raw.settings?.dwellMinutes) || 20,
      searchRadiusMiles: Number(raw.settings?.searchRadiusMiles) || 50,
      showPriorityOnly: Boolean(raw.settings?.showPriorityOnly),
      listSortMode: normalizeListSortMode(raw.settings?.listSortMode),
      hideVisitedWithinDays: normalizeHideVisitedDays(raw.settings?.hideVisitedWithinDays),
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
    interests: Array.isArray(state.interests) ? state.interests : defaultInterests(),
    settings: {
      avgKmh: Number(state.settings?.avgKmh) || 40,
      dwellMinutes: Number(state.settings?.dwellMinutes) || 20,
      searchRadiusMiles: Number(state.settings?.searchRadiusMiles) || 50,
      showPriorityOnly: Boolean(state.settings?.showPriorityOnly),
      listSortMode: normalizeListSortMode(state.settings?.listSortMode),
      hideVisitedWithinDays: normalizeHideVisitedDays(state.settings?.hideVisitedWithinDays),
    },
  }
  localStorage.setItem(KEY, JSON.stringify(normalized))
  return normalized
}

export function defaultInterests() {
  return [
    { id: crypto.randomUUID(), label: 'Jewelry', keywords: 'jewelry,jewellery,gold,silver,rings,necklace,watches' },
    { id: crypto.randomUUID(), label: 'Video games', keywords: 'video games,games,xbox,playstation,nintendo,console,retro' },
    { id: crypto.randomUUID(), label: 'Tools', keywords: 'tools,drill,saw,wrench,ladder' },
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
