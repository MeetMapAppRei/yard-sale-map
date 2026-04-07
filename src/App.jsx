import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SaleMap from './components/SaleMap.jsx'
import SaleThumb from './components/SaleThumb.jsx'
import {
  loadState,
  saveState,
  writeFullState,
  upsertSale,
  removeSale,
  defaultInterests,
  normalizeRouteStrategy,
  normalizeColorScheme,
} from './lib/storage.js'
import { scoreTextAgainstInterests } from './lib/interests.js'
import { geocodeAddress } from './lib/geocode.js'
import { runOcrOnFile } from './lib/ocr.js'
import { minutesToLabel } from './lib/parseTimes.js'
import { planRoute, computeRouteSequence, summarizeRouteDrivingStats } from './lib/routePlanner.js'
import { haversineKm, milesToKm } from './lib/haversine.js'
import { putSaleImage, deleteSaleImage, getSaleImageBlob } from './lib/imageStore.js'
import { downloadJsonBackup, importBackupJson } from './lib/backup.js'
import { parseScreenshotWithAi, fileToBase64, blobToBase64 } from './lib/parseScreenshotApi.js'
import { mergeOcrAndAi } from './lib/mergeAiParse.js'
import { compressImageFile } from './lib/compressImage.js'
import { stabilizeFile } from './lib/stabilizeFile.js'
import { buildGoogleMapsDirectionsUrl } from './lib/googleMapsRoute.js'
import {
  dedupeOccurrencesByDate,
  extractSaleSchedule,
  getSaleDayIso,
  migrateSaleDates,
  scheduleRowsFromAiOccurrences,
} from './lib/parseSaleSchedule.js'
import {
  buildGoogleMapsPlaceUrl,
  buildAppleMapsPlaceUrl,
  buildAppleMapsDirectionsUrl,
} from './lib/mapsLinks.js'
import { fetchTripDayWeather } from './lib/weatherTrip.js'

function timeInputValue(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return ''
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function parseTimeInputValue(v) {
  if (!v || typeof v !== 'string') return null
  const [h, m] = v.split(':').map((x) => parseInt(x, 10))
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

function newId() {
  return crypto.randomUUID()
}

const AI_PARSE_TIMEOUT_MS = 50_000

/** Map Tesseract worker messages to short UI hints (mobile first load downloads WASM + language data). */
function ocrLoggerToImportPatch(m) {
  const st = String(m?.status || '')
  const prog = typeof m?.progress === 'number' ? m.progress : 0
  if (st === 'recognizing text') {
    const pct = Math.round(prog * 100)
    return {
      phase: 'ocr',
      ocrPct: pct,
      detail: pct > 0 ? `Scanning text… ${pct}%` : 'Scanning text…',
    }
  }
  if (/loading tesseract|loading language|loading core|downloading/i.test(st)) {
    return {
      phase: 'ocr',
      ocrPct: 0,
      detail: 'Loading on-device scanner (first photo may take 1–2 min on slow Wi‑Fi)…',
    }
  }
  if (st === 'initializing api' || st === 'initializing tesseract') {
    return { phase: 'ocr', ocrPct: 0, detail: 'Starting text scanner…' }
  }
  return null
}

/**
 * Full pipeline for one image: compress → store → OCR → optional AI → interest scoring.
 * @param {number} createdAtOffset  ms bump so batch items keep a stable order tie-break
 * @param {(patch: { phase?: string; ocrPct?: number; detail?: string }) => void} [reportImport]  live progress for the import overlay
 */
async function processScreenshotFile(file, interestRows, createdAtOffset = 0, reportImport) {
  reportImport?.({ phase: 'prepare', ocrPct: 0, detail: 'Shrinking photo for storage…' })
  let toStore
  try {
    toStore = await compressImageFile(file)
  } catch {
    toStore = file
  }
  const imageForOcr = toStore instanceof Blob ? toStore : file
  const mimeForApi = (toStore && toStore.type) || file.type || 'image/jpeg'

  const online = typeof navigator === 'undefined' || navigator.onLine
  const ac = new AbortController()
  const tid = setTimeout(() => ac.abort(), AI_PARSE_TIMEOUT_MS)
  let rawText
  let ai = null
  try {
    reportImport?.({ phase: 'ocr', ocrPct: 0, detail: 'Reading text from photo…' })
    const b64 = await fileToBase64(toStore)
    const [ocrResult, aiResult] = await Promise.all([
      runOcrOnFile(imageForOcr, (m) => {
        const patch = ocrLoggerToImportPatch(m)
        if (patch) reportImport?.(patch)
      }),
      online
        ? parseScreenshotWithAi(b64, mimeForApi, { signal: ac.signal }).catch(() => null)
        : Promise.resolve(null),
    ])
    rawText = ocrResult
    ai = aiResult
    if (online && ai == null) {
      reportImport?.({ phase: 'ai', ocrPct: 100, detail: 'Smart reader unavailable — using photo text only.' })
    }
  } catch (e) {
    throw e
  } finally {
    clearTimeout(tid)
  }

  const merged = mergeOcrAndAi(ai, rawText)

  // Union vision occurrences + every text source (colored flyer lines often missing from OCR).
  const schedule = dedupeOccurrencesByDate([
    ...scheduleRowsFromAiOccurrences(ai),
    ...(Array.isArray(merged.schedule) ? merged.schedule : []),
    ...extractSaleSchedule(merged.rawText),
    ...extractSaleSchedule(rawText),
    ...extractSaleSchedule(String(ai?.summary_text || '')),
  ])
  const dated = schedule.filter((x) => x?.isoDate)
  const occurrences = dated.length
    ? dated
    : [{ isoDate: null, openMinutes: merged.openMinutes, closeMinutes: merged.closeMinutes }]

  reportImport?.({ phase: 'prepare', ocrPct: 100, detail: occurrences.length > 1 ? `Found ${occurrences.length} days… saving copies…` : 'Saving photo…' })

  const createdAtBase = Date.now() + createdAtOffset
  const sales = []
  for (let j = 0; j < occurrences.length; j++) {
    const occ = occurrences[j]
    const saleId = newId()
    await putSaleImage(saleId, toStore)
    const { score, matches } = scoreTextAgainstInterests(merged.rawText, interestRows)
    sales.push({
      id: saleId,
      title: merged.title,
      rawText: merged.rawText,
      addressQuery: merged.addressQuery,
      saleDate: occ.isoDate || null,
      lat: null,
      lon: null,
      displayName: null,
      openMinutes: occ.openMinutes ?? merged.openMinutes,
      closeMinutes: occ.closeMinutes ?? merged.closeMinutes,
      priorityScore: score,
      interestMatches: matches,
      createdAt: createdAtBase + j,
      hasImage: true,
      visitedAt: null,
      needsReview: computeSaleNeedsReview({
        saleDate: occ.isoDate || null,
        rawText: merged.rawText,
        addressQuery: merged.addressQuery,
        title: merged.title,
      }),
    })
  }
  return sales
}

function sortSalesForList(sales, mode, home) {
  const list = [...sales]
  const newest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0)

  if (mode === 'match') {
    list.sort((a, b) => {
      const pa = Number(a.priorityScore) || 0
      const pb = Number(b.priorityScore) || 0
      if (pb !== pa) return pb - pa
      return newest(a, b)
    })
    return list
  }
  if (mode === 'opens') {
    list.sort((a, b) => {
      const oa = a.openMinutes
      const ob = b.openMinutes
      const na = oa == null || Number.isNaN(oa) ? 99999 : oa
      const nb = ob == null || Number.isNaN(ob) ? 99999 : ob
      if (na !== nb) return na - nb
      return newest(a, b)
    })
    return list
  }
  if (mode === 'distance') {
    list.sort((a, b) => {
      const da =
        home && a.lat != null && a.lon != null
          ? haversineKm(home.lat, home.lon, a.lat, a.lon)
          : Infinity
      const db =
        home && b.lat != null && b.lon != null
          ? haversineKm(home.lat, home.lon, b.lat, b.lon)
          : Infinity
      if (da !== db) return da - db
      return newest(a, b)
    })
    return list
  }
  if (mode === 'title') {
    list.sort((a, b) => {
      const sa = String(a.title || a.addressQuery || '').toLowerCase()
      const sb = String(b.title || b.addressQuery || '').toLowerCase()
      const c = sa.localeCompare(sb, undefined, { sensitivity: 'base' })
      if (c !== 0) return c
      return newest(a, b)
    })
    return list
  }
  list.sort(newest)
  return list
}

function normalizeIsoDate(v) {
  const s = String(v || '').trim()
  if (!s) return null
  // HTML date input uses YYYY-MM-DD.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    const yyyy = iso[1]
    const mm = String(Math.min(12, Math.max(1, Number(iso[2])))).padStart(2, '0')
    const dd = String(Math.min(31, Math.max(1, Number(iso[3])))).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }

  // Some environments yield MM/DD/YYYY or MM-DD-YYYY (date input fallback).
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

function dateSortKey(iso) {
  // Null/unknown sorts last.
  if (!iso) return '9999-12-31'
  return iso
}

function formatIsoDateLabel(iso) {
  if (!iso) return 'No day set'
  const clean = normalizeIsoDate(iso)
  if (!clean) return 'No day set'
  // Force a stable day label across timezones.
  const dt = new Date(`${clean}T12:00:00Z`)
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function todayIsoLocal() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function tripDayIsoFromSettings(settings) {
  const mode = settings?.tripDayMode || 'today'
  if (mode === 'today') return todayIsoLocal()
  return normalizeIsoDate(settings?.tripDayIso)
}

function saleTripEligibility(sale, tripIso) {
  const saleIso = getSaleDayIso(sale)
  if (!tripIso) return { ok: false, reason: 'Pick a trip day first.' }
  if (!saleIso) {
    return {
      ok: false,
      reason: `No sale day found — set “Day” below or add the When line to the text. (Trip is ${formatIsoDateLabel(tripIso)}.)`,
    }
  }
  if (saleIso !== tripIso) {
    return {
      ok: false,
      reason: `This sale is for ${formatIsoDateLabel(saleIso)}. Trip day is ${formatIsoDateLabel(tripIso)}.`,
    }
  }
  return { ok: true, reason: '' }
}

function kmToMiles(km) {
  return km * 0.621371
}

function matchSummaryLine(score, _matches) {
  const s = Number(score) || 0
  if (s >= 1.5) return 'Strong match for your list'
  if (s > 0) return 'Some matches for your list'
  return 'No keyword matches yet'
}

/** Strip noisy OCR phrasing so list titles read like addresses. */
function displaySaleTitle(title) {
  let t = String(title || '').trim()
  t = t.replace(/^the address for this sale is\s*:?\s*/i, '')
  t = t.replace(/^address\s*:\s*/i, '')
  t = t.replace(/^location\s*:\s*/i, '')
  t = t.replace(/^sale\s+(at|location)\s*:?\s*/i, '')
  return t.trim() || 'Untitled sale'
}

function shortVisitLabel(ts) {
  if (ts == null || Number.isNaN(ts)) return ''
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Clicks on text inside summary may target a Text node (no .closest) — avoid throwing on mobile. */
function eventTargetIsInsideButton(target) {
  if (target == null || typeof target !== 'object') return false
  const el = target.nodeType === 1 ? target : target.parentElement
  return !!(el && typeof el.closest === 'function' && el.closest('button'))
}

function saleVisitedWithinDays(s, days) {
  if (!days || days <= 0) return false
  const v = s.visitedAt
  if (v == null || Number.isNaN(v)) return false
  return Date.now() - v < days * 86400000
}

/** Friendlier geocode errors + concrete next steps. */
function geocodeUserMessage(raw, addressLine) {
  const base = String(raw || 'Something went wrong finding that address.')
  const msg = base.toLowerCase()
  const addr = String(addressLine || '').trim()
  const parts = addr.split(',').map((x) => x.trim()).filter(Boolean)
  const suggestZip = !/\b\d{5}(-\d{4})?\b/.test(addr) ? ' Add a ZIP code if you can.' : ''
  const suggestCity = parts.length < 2 ? ' Include city and state (or town).' : ''

  if (msg.includes('type an address') || msg.includes('empty')) return base
  if (msg.includes('no match') || msg.includes('no results')) {
    return `${base}${suggestZip || suggestCity || ' Try a nearby cross street or town name.'}`
  }
  if (msg.includes('look up') || msg.includes('try again')) {
    return `${base} Check spelling; add city, state, and ZIP when possible.`
  }
  return base
}

function looksLikeAddress(s) {
  const t = String(s || '').trim()
  if (!t) return false
  if (!/\d/.test(t)) return false
  if (t.length < 6) return false
  // Common street tokens; keep conservative to avoid geocoding random OCR junk.
  return /\b(st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|ct|court|cir|circle|hwy|highway|pkwy|parkway|way|pl|place|trl|trail)\b/i.test(
    t,
  ) || /,/.test(t)
}

function bestGeocodeQueryForSale(sale) {
  const direct = String(sale?.addressQuery || '').trim()
  if (direct) return direct

  const title = displaySaleTitle(sale?.title)
  if (looksLikeAddress(title)) return title

  const raw = String(sale?.rawText || '')
  const firstLine = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)[0]
  if (looksLikeAddress(firstLine)) return firstLine

  return ''
}

/** True when sale day or a geocodable address line is missing—prompts review. */
function computeSaleNeedsReview(sale) {
  if (!sale) return false
  if (!getSaleDayIso(sale)) return true
  if (!String(bestGeocodeQueryForSale(sale) || '').trim()) return true
  return false
}

function buildTripShareLines(activeTripIso, routeResult, tripEligibleSales) {
  if (!activeTripIso) return { error: 'Pick a trip day first.' }
  const stops = routeResult?.ordered?.length ? routeResult.ordered : tripEligibleSales
  if (!stops.length) return { error: 'No sales for this trip day — add sales or plan a route first.' }
  const dayLabel = formatIsoDateLabel(activeTripIso)
  const lines = [`Yard sale route — ${dayLabel}`, '']
  stops.forEach((s, i) => {
    const addr = String(s.addressQuery || bestGeocodeQueryForSale(s) || displaySaleTitle(s.title) || '').trim()
    const open = s.openMinutes != null ? minutesToLabel(s.openMinutes) : '—'
    const close = s.closeMinutes != null ? minutesToLabel(s.closeMinutes) : ''
    const timeLine = close ? `${open} – ${close}` : `Opens ${open}`
    lines.push(`${i + 1}. ${displaySaleTitle(s.title)}`)
    lines.push(`   ${addr}`)
    lines.push(`   ${timeLine}`)
    if (s.lat != null && s.lon != null) {
      lines.push(`   ${buildGoogleMapsPlaceUrl(s.lat, s.lon, s.title)}`)
    }
    lines.push('')
  })
  return { text: lines.join('\n').trim(), dayLabel }
}

export default function App() {
  const [home, setHome] = useState(null)
  const [homeInput, setHomeInput] = useState('')
  const [autoCenter, setAutoCenter] = useState(null)
  const [sales, setSales] = useState([])
  const [interests, setInterests] = useState(defaultInterests())
  const [settings, setSettings] = useState({
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
  })
  const [startTime, setStartTime] = useState('08:00')
  const [routeResult, setRouteResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const [busySaleId, setBusySaleId] = useState(null)
  const [photoImportProgress, setPhotoImportProgress] = useState(null)
  const [error, setError] = useState(null)
  /** Which sale cards are expanded (key present and true). */
  const [saleCardOpen, setSaleCardOpen] = useState({})
  /** After a card is opened once, keep its body mounted and use `hidden` when collapsed (avoids mobile blank-screen on unmount). */
  const [saleCardBodyMounted, setSaleCardBodyMounted] = useState({})
  const [geocodingSaleId, setGeocodingSaleId] = useState(null)
  /** Bulk “Put all eligible sales on map”: loading + done feedback near the button (global `busy` is easy to miss below the fold). */
  const [bulkGeocodeStatus, setBulkGeocodeStatus] = useState(null)
  /** Full-screen checklist: addresses + times only (local data; no map tiles required). */
  const [groundMode, setGroundMode] = useState(false)
  const [tripWeather, setTripWeather] = useState(null)
  const [weatherLoading, setWeatherLoading] = useState(false)
  /** null | 'address' | 'location' — which starting-point action is running */
  const [homeStartingPointBusy, setHomeStartingPointBusy] = useState(null)
  /** null | 'address' | 'location' — brief confirmation after success */
  const [homeStartingPointSuccess, setHomeStartingPointSuccess] = useState(null)
  const homeStartingPointFeedbackTimerRef = useRef(null)
  const [shareToast, setShareToast] = useState(null)
  const [offline, setOffline] = useState(() => (typeof navigator !== 'undefined' ? !navigator.onLine : false))
  const [undoDeleteLabel, setUndoDeleteLabel] = useState(null)
  const undoSaleRef = useRef(null)
  const undoBlobRef = useRef(null)
  const undoTimerRef = useRef(null)
  /** Latest list row for merges — async geocode must not upsert from stale loadState() or keyword rows disappear after “Put on map”. */
  const salesRef = useRef(sales)
  salesRef.current = sales

  const needsReviewCount = useMemo(() => sales.filter((s) => s.needsReview).length, [sales])

  const clearUndoTimer = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current)
      undoTimerRef.current = null
    }
  }, [])

  const scheduleUndoExpiry = useCallback(() => {
    clearUndoTimer()
    undoTimerRef.current = setTimeout(() => {
      setUndoDeleteLabel(null)
      undoSaleRef.current = null
      undoBlobRef.current = null
      undoTimerRef.current = null
    }, 12000)
  }, [clearUndoTimer])

  useEffect(() => {
    const t = normalizeColorScheme(settings.colorScheme)
    document.documentElement.setAttribute('data-ysm-theme', t)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', t === 'light' ? '#f1f5f9' : '#0c1322')
  }, [settings.colorScheme])

  useEffect(() => {
    document.documentElement.setAttribute('data-ysm-guided', settings.uiLayout !== 'full' ? 'true' : 'false')
  }, [settings.uiLayout])

  useEffect(() => {
    const s = loadState()
    const sales = migrateSaleDates(s.sales)
    setHome(s.home)
    setSales(sales)
    setInterests(s.interests)
    setSettings(s.settings)
    if (JSON.stringify(sales) !== JSON.stringify(s.sales)) {
      saveState({ sales })
    }
    try {
      const raw = JSON.parse(localStorage.getItem('yard-sale-map-v1') || 'null')
      if (raw?.settings && !Object.prototype.hasOwnProperty.call(raw.settings, 'uiLayout')) {
        saveState({ settings: { ...s.settings, uiLayout: 'guided' } })
      }
    } catch {
      /* ignore */
    }
  }, [])

  // Auto-center the map over the user's current location (without changing the trip starting point).
  useEffect(() => {
    if (home) return
    if (!navigator.geolocation) return
    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return
        setAutoCenter({ lat: pos.coords.latitude, lon: pos.coords.longitude })
      },
      () => {
        /* ignore (permission denied / unavailable) */
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    )
    return () => {
      cancelled = true
    }
  }, [home])

  const globalPhotoBusy = photoImportProgress != null || busySaleId != null

  useEffect(() => {
    if (!globalPhotoBusy) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [globalPhotoBusy])

  useEffect(() => {
    if (!bulkGeocodeStatus || bulkGeocodeStatus.phase !== 'done') return
    const t = window.setTimeout(() => setBulkGeocodeStatus(null), 12000)
    return () => clearTimeout(t)
  }, [bulkGeocodeStatus])

  useEffect(() => {
    if (!groundMode) return
    const onKey = (e) => {
      if (e.key === 'Escape') setGroundMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [groundMode])

  useEffect(() => {
    if (!groundMode) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [groundMode])

  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    return () => clearUndoTimer()
  }, [clearUndoTimer])

  useEffect(() => {
    return () => {
      if (homeStartingPointFeedbackTimerRef.current) {
        clearTimeout(homeStartingPointFeedbackTimerRef.current)
        homeStartingPointFeedbackTimerRef.current = null
      }
    }
  }, [])

  const flashStartingPointSuccess = useCallback((kind) => {
    if (homeStartingPointFeedbackTimerRef.current) {
      clearTimeout(homeStartingPointFeedbackTimerRef.current)
    }
    setHomeStartingPointSuccess(kind)
    homeStartingPointFeedbackTimerRef.current = setTimeout(() => {
      setHomeStartingPointSuccess(null)
      homeStartingPointFeedbackTimerRef.current = null
    }, 2800)
  }, [])

  const persist = useCallback(
    (patch) => {
      const next = saveState(patch)
      if (next.home !== undefined) setHome(next.home)
      if (next.sales) setSales(next.sales)
      if (next.interests) setInterests(next.interests)
      if (next.settings) setSettings(next.settings)
    },
    [],
  )

  const scrollToFirstNeedsReview = useCallback(() => {
    const first = sales.find((s) => s.needsReview)
    if (!first) return
    const el = document.getElementById(`ysm-sale-${first.id}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setSaleCardBodyMounted((m) => ({ ...m, [first.id]: true }))
    setSaleCardOpen((prev) => ({ ...prev, [first.id]: true }))
  }, [sales])

  const onGeocodeHome = async () => {
    setError(null)
    setHomeStartingPointSuccess(null)
    setHomeStartingPointBusy('address')
    try {
      const g = await geocodeAddress(homeInput)
      const h = { lat: g.lat, lon: g.lon, label: g.displayName }
      persist({ home: h })
      flashStartingPointSuccess('address')
    } catch (e) {
      setError(geocodeUserMessage(e.message, homeInput))
    } finally {
      setHomeStartingPointBusy(null)
    }
  }

  const onUseMyLocation = () => {
    setError(null)
    setHomeStartingPointSuccess(null)
    if (!navigator.geolocation) {
      setError("This browser can't use your location. Use \"Use this address\" instead.")
      return
    }
    setHomeStartingPointBusy('location')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const h = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: 'Current location',
        }
        persist({ home: h })
        setHomeStartingPointBusy(null)
        flashStartingPointSuccess('location')
      },
      (err) => {
        setError(
          err.code === 1
            ? 'Location is turned off or blocked. Allow location for this site, or type your address above.'
            : 'Could not get your location. Try again or use your address above.',
        )
        setHomeStartingPointBusy(null)
      },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  const onUpload = async (e) => {
    const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'))
    if (!picked.length) return

    const st0 = loadState()
    const interestRows = st0.interests
    const newSales = []
    const failures = []

    try {
      // Android can revoke handles between sequential awaits — copy every file in parallel first.
      // Avoid setState until after bytes exist (re-renders may contribute to revoked handles).
      const copyResults = await Promise.all(
        picked.map((originalFile, idx) =>
          stabilizeFile(originalFile)
            .then((file) => ({ ok: true, idx, originalFile, file }))
            .catch((err) => ({ ok: false, idx, originalFile, err })),
        ),
      )
      copyResults.sort((a, b) => a.idx - b.idx)
      const stabilized = []
      for (const r of copyResults) {
        if (r.ok) stabilized.push({ originalFile: r.originalFile, file: r.file })
        else failures.push(`${r.originalFile?.name || 'image'}: ${r.err?.message || String(r.err)}`)
      }

      setError(null)

      // Now it's safe to clear the input (we have stable in-memory copies).
      e.target.value = ''

      for (let i = 0; i < stabilized.length; i++) {
        const { originalFile, file } = stabilized[i]
        setPhotoImportProgress({
          current: i + 1,
          total: stabilized.length,
          phase: 'prepare',
          ocrPct: 0,
          detail: 'Shrinking photo for storage…',
        })
        try {
          const salesFromPhoto = await processScreenshotFile(file, interestRows, i, (patch) => {
            setPhotoImportProgress((prev) => (prev ? { ...prev, ...patch } : prev))
          })
          newSales.push(...salesFromPhoto)
        } catch (err) {
          failures.push(`${originalFile?.name || 'image'}: ${err?.message || String(err)}`)
        }
      }

      if (!newSales.length) {
        setError(
          failures.length
            ? `None of the photos worked: ${failures.join(' · ')}`
            : 'No photos could be read. Try clearer pictures or a different format.',
        )
        return
      }

      const combined = [...loadState().sales, ...newSales]
      persist({ sales: combined })
      setRouteResult(null)
      if (failures.length) {
        setError(
          `Added ${newSales.length} sale(s). ${failures.length} photo(s) didn’t work: ${failures.join(' · ')}`,
        )
      }
    } finally {
      setPhotoImportProgress(null)
    }
  }

  const updateSaleField = (id, patch) => {
    const state = loadState()
    const live = salesRef.current
    const s = live.find((x) => x.id === id) ?? state.sales.find((x) => x.id === id)
    if (!s) return
    let next = { ...s, ...patch }
    if (patch.rawText !== undefined || patch.interestsRefresh) {
      const { score, matches } = scoreTextAgainstInterests(next.rawText, state.interests)
      next.priorityScore = score
      next.interestMatches = matches
      delete next.interestsRefresh
      if (patch.rawText !== undefined && !normalizeIsoDate(next.saleDate)) {
        const inf = extractSaleSchedule(next.rawText || '')
        if (inf.length === 1) {
          next.saleDate = inf[0].isoDate
          if (next.openMinutes == null && inf[0].openMinutes != null) next.openMinutes = inf[0].openMinutes
          if (next.closeMinutes == null && inf[0].closeMinutes != null) next.closeMinutes = inf[0].closeMinutes
        }
      }
    } else {
      next.priorityScore = s.priorityScore
      next.interestMatches = s.interestMatches
    }
    if (patch.needsReview === false) {
      next.needsReview = false
    } else if (patch.needsReview === true) {
      next.needsReview = true
    } else {
      next.needsReview = computeSaleNeedsReview(next)
    }
    const list = live.length ? live : state.sales
    persist({ sales: upsertSale(list, next) })
    setRouteResult(null)
  }

  const geocodeSale = async (id) => {
    const s = loadState().sales.find((x) => x.id === id)
    if (!s?.addressQuery?.trim()) return
    setError(null)
    setGeocodingSaleId(id)
    setBusy('Putting this sale on the map…')
    try {
      const g = await geocodeAddress(s.addressQuery)
      updateSaleField(id, {
        lat: g.lat,
        lon: g.lon,
        displayName: g.displayName,
      })
    } catch (e) {
      setError(geocodeUserMessage(e.message, s.addressQuery))
      updateSaleField(id, { needsReview: true })
    } finally {
      setBusy(null)
      setGeocodingSaleId(null)
    }
  }

  const undoDeleteSale = useCallback(async () => {
    const sale = undoSaleRef.current
    const blob = undoBlobRef.current
    if (!sale) return
    clearUndoTimer()
    setUndoDeleteLabel(null)
    undoSaleRef.current = null
    undoBlobRef.current = null
    setError(null)
    try {
      if (blob) await putSaleImage(sale.id, blob)
      persist({ sales: upsertSale(loadState().sales, sale) })
      setRouteResult(null)
    } catch (err) {
      setError(err.message || String(err))
    }
  }, [clearUndoTimer, persist])

  const reparseSale = async (id) => {
    setError(null)
    const blob = await getSaleImageBlob(id)
    if (!blob) {
      setError('No saved photo for this sale. Upload again or restore from a backup that includes pictures.')
      return
    }
    const file = new File([blob], 'screenshot.jpg', { type: blob.type || 'image/jpeg' })
    setBusySaleId(id)
    let aiError = null
    try {
      const [ocrText, ai] = await Promise.all([
        runOcrOnFile(file, () => {}),
        parseScreenshotWithAi(await blobToBase64(blob), blob.type || 'image/jpeg').catch((e) => {
          aiError = e.message || String(e)
          return null
        }),
      ])
      let merged = mergeOcrAndAi(ai, ocrText)
      const state = loadState()
      const s = state.sales.find((x) => x.id === id)
      if (!s) return
      if (merged.openMinutes == null && s.openMinutes != null) merged = { ...merged, openMinutes: s.openMinutes }
      if (merged.closeMinutes == null && s.closeMinutes != null) merged = { ...merged, closeMinutes: s.closeMinutes }
      const schedule = dedupeOccurrencesByDate([
        ...scheduleRowsFromAiOccurrences(ai),
        ...(Array.isArray(merged.schedule) ? merged.schedule : []),
        ...extractSaleSchedule(merged.rawText),
        ...extractSaleSchedule(ocrText),
        ...extractSaleSchedule(String(ai?.summary_text || '')),
      ])
      const dated = schedule.filter((x) => x?.isoDate)
      const first = dated[0]
      const prevAddr = (s.addressQuery || '').trim()
      const addrChanged = (merged.addressQuery || '').trim() !== prevAddr
      const { score, matches } = scoreTextAgainstInterests(merged.rawText, state.interests)
      const next = {
        ...s,
        title: merged.title,
        rawText: merged.rawText,
        addressQuery: merged.addressQuery,
        openMinutes: merged.openMinutes,
        closeMinutes: merged.closeMinutes,
        priorityScore: score,
        interestMatches: matches,
      }
      if (first) {
        next.saleDate = first.isoDate
        if (first.openMinutes != null) next.openMinutes = first.openMinutes
        if (first.closeMinutes != null) next.closeMinutes = first.closeMinutes
      }
      next.needsReview = computeSaleNeedsReview(next)
      if (addrChanged) {
        next.lat = null
        next.lon = null
        next.displayName = null
      }
      persist({ sales: upsertSale(state.sales, next) })
      setRouteResult(null)
      if (aiError) {
        const nowOffline = typeof navigator !== 'undefined' && !navigator.onLine
        setError(
          nowOffline
            ? "You're offline, so the smart reader couldn't run. Text from your photo was still refreshed; try again when you're online for better addresses and times."
            : "The smart reader didn't finish (weak signal or server busy). Text from your photo was still refreshed—try again in a moment.",
        )
      }
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusySaleId(null)
    }
  }

  const onInterestsChange = (rows) => {
    const state = loadState()
    const normalized = Array.isArray(rows) && rows.length ? rows : defaultInterests()
    const nextSales = state.sales.map((s) => {
      const { score, matches } = scoreTextAgainstInterests(s.rawText, normalized)
      return { ...s, priorityScore: score, interestMatches: matches }
    })
    persist({ interests: normalized, sales: nextSales })
    setRouteResult(null)
  }

  const salesSortedForList = useMemo(
    () => sortSalesForList(sales, settings.listSortMode || 'newest', home),
    [sales, settings.listSortMode, home],
  )

  const displayedSales = useMemo(() => {
    let list = salesSortedForList
    if (settings.showPriorityOnly) {
      list = list.filter((s) => {
        const score = Number(s.priorityScore) || 0
        const hasMatches = Array.isArray(s.interestMatches) && s.interestMatches.length > 0
        return score > 0 || hasMatches
      })
    }
    const hideDays = Number(settings.hideVisitedWithinDays) || 0
    if (hideDays > 0) {
      list = list.filter((s) => !saleVisitedWithinDays(s, hideDays))
    }
    return list
  }, [salesSortedForList, settings.showPriorityOnly, settings.hideVisitedWithinDays])

  const activeTripIso = useMemo(
    () => tripDayIsoFromSettings(settings),
    [settings.tripDayMode, settings.tripDayIso],
  )

  const tripEligibleSales = useMemo(() => {
    if (!activeTripIso) return []
    return displayedSales.filter((s) => saleTripEligibility(s, activeTripIso).ok)
  }, [displayedSales, activeTripIso])

  const groundStops = useMemo(() => {
    if (!activeTripIso) return []
    if (routeResult?.ordered?.length) return routeResult.ordered
    return tripEligibleSales
  }, [activeTripIso, routeResult, tripEligibleSales])

  const refreshTripWeather = useCallback(() => {
    if (!home?.lat || !home?.lon || !activeTripIso) {
      setTripWeather(null)
      setWeatherLoading(false)
      return
    }
    setWeatherLoading(true)
    fetchTripDayWeather({ lat: home.lat, lon: home.lon, isoDate: activeTripIso })
      .then(setTripWeather)
      .catch(() => setTripWeather({ level: 'ok', headline: 'Weather check failed — try again later.' }))
      .finally(() => setWeatherLoading(false))
  }, [home?.lat, home?.lon, activeTripIso])

  useEffect(() => {
    if (!home?.lat || !home?.lon || !activeTripIso) {
      setTripWeather(null)
      setWeatherLoading(false)
      return
    }
    let cancelled = false
    setWeatherLoading(true)
    fetchTripDayWeather({ lat: home.lat, lon: home.lon, isoDate: activeTripIso })
      .then((w) => {
        if (!cancelled) setTripWeather(w)
      })
      .catch(() => {
        if (!cancelled) setTripWeather({ level: 'ok', headline: 'Weather check failed — try again later.' })
      })
      .finally(() => {
        if (!cancelled) setWeatherLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [home?.lat, home?.lon, activeTripIso])

  const scrollToSaleId = useCallback((id) => {
    setGroundMode(false)
    window.setTimeout(() => {
      document.getElementById(`ysm-sale-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
  }, [])

  const shareTripList = useCallback(async () => {
    const built = buildTripShareLines(activeTripIso, routeResult, tripEligibleSales)
    if (built.error) {
      setError(built.error)
      return
    }
    const { text, dayLabel } = built
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: `Yard sales ${dayLabel}`, text })
        setError(null)
      } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        setError(null)
        setShareToast('Copied list to clipboard')
        window.setTimeout(() => setShareToast(null), 2500)
      } else {
        setError('Sharing isn’t available in this browser.')
      }
    } catch (e) {
      if (e?.name !== 'AbortError') setError(e?.message || 'Could not share.')
    }
  }, [activeTripIso, routeResult, tripEligibleSales])

  const copyTripList = useCallback(async () => {
    const built = buildTripShareLines(activeTripIso, routeResult, tripEligibleSales)
    if (built.error) {
      setError(built.error)
      return
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(built.text)
        setError(null)
        setShareToast('Copied list to clipboard')
        window.setTimeout(() => setShareToast(null), 2500)
      } else {
        setError('Clipboard isn’t available in this browser.')
      }
    } catch (e) {
      setError(e?.message || 'Could not copy.')
    }
  }, [activeTripIso, routeResult, tripEligibleSales])

  const tripDriveSummary = useMemo(
    () => summarizeRouteDrivingStats({ legs: routeResult?.legs, ordered: routeResult?.ordered }),
    [routeResult],
  )

  const runPlan = () => {
    setError(null)
    const startMinutes = parseTimeInputValue(startTime) ?? 8 * 60
    if (!activeTripIso) {
      setError('Pick a trip day (today or a future day) before planning a route.')
      return
    }
    if (!tripEligibleSales.length) {
      const anyMissingDay = displayedSales.some((s) => !getSaleDayIso(s))
      setError(
        anyMissingDay
          ? `No sales are eligible for ${formatIsoDateLabel(activeTripIso)} yet. Set “Day” on your sales, then try again.`
          : `No sales are scheduled for ${formatIsoDateLabel(activeTripIso)}.`,
      )
      return
    }
    const result = planRoute({
      home,
      startMinutes,
      sales: tripEligibleSales,
      settings,
    })
    setRouteResult(result)
  }

  const moveRouteStop = useCallback(
    (index, delta) => {
      setRouteResult((prev) => {
        if (!prev?.ordered?.length || !home) return prev
        const j = index + delta
        if (j < 0 || j >= prev.ordered.length) return prev
        const swapped = [...prev.ordered]
        const t = swapped[index]
        swapped[index] = swapped[j]
        swapped[j] = t
        const startMinutes = parseTimeInputValue(startTime) ?? 8 * 60
        const { ordered, legs } = computeRouteSequence({
          home,
          startMinutes,
          orderedSales: swapped,
          settings,
        })
        const lateCount = ordered.filter((s) => s.arrivalAfterClose).length
        return {
          ...prev,
          ordered,
          legs,
          userReordered: true,
          orderExplanation:
            'This is your custom order (use ↑/↓). Times assume you visit stops in this sequence; drive estimates are the same as before (not live traffic).' +
            (lateCount > 0
              ? ` ${lateCount} stop(s) would arrive after closing at this pace—check hours or reorder.`
              : ''),
        }
      })
    },
    [home, startTime, settings],
  )

  const bulkGeocodeMissing = async () => {
    const state = loadState()
    // "Put all eligible sales on map" respects filters (keyword-only, visited hiding, etc.)
    // and also try reasonable fallbacks when AI didn't produce a dedicated address field.
    const source = displayedSales
    const tripIso = activeTripIso
    const eligible = tripIso ? source.filter((s) => saleTripEligibility(s, tripIso).ok) : []
    const ineligibleCount = tripIso ? Math.max(0, source.length - eligible.length) : source.length

    const missing = eligible
      .map((s) => ({ sale: s, query: bestGeocodeQueryForSale(s) }))
      .filter(({ sale, query }) => query && (sale.lat == null || sale.lon == null))
    const noAddressQueryIds = eligible
      .filter((s) => (s.lat == null || s.lon == null) && !bestGeocodeQueryForSale(s))
      .map((s) => s.id)
    if (!missing.length) {
      setBulkGeocodeStatus(null)
      if (!tripIso) {
        setError(
          'Pick a trip day first (today or future) so we know which sales are eligible to place on the map.',
        )
        return
      }
      const noPinEligible = eligible.filter((s) => s.lat == null || s.lon == null).length
      const noQueryEligible = eligible.filter((s) => (s.lat == null || s.lon == null) && !bestGeocodeQueryForSale(s)).length
      if (noPinEligible > 0 && noQueryEligible > 0) {
        setError(
          `No addresses found to place on the map. Open a sale and type an address (add city/state/ZIP), then try again.`,
        )
      } else if (ineligibleCount > 0) {
        setError(`No eligible sales needed pins for ${formatIsoDateLabel(tripIso)}. (${ineligibleCount} sale(s) are on a different day.)`)
      } else {
        setError(null)
      }
      return
    }
    setError(null)
    setBulkGeocodeStatus({ phase: 'loading', total: missing.length })
    setBusy(`Finding ${missing.length} address(es) on the map…`)
    const nextSales = [...state.sales]
    let failed = 0
    let skipped = 0
    let skippedWrongDay = 0
    let placed = 0
    const failedIds = []
    try {
      for (const { sale, query } of missing) {
        if (!query) {
          skipped += 1
          continue
        }
        if (tripIso && !saleTripEligibility(sale, tripIso).ok) {
          skippedWrongDay += 1
          continue
        }
        setGeocodingSaleId(sale.id)
        try {
          const g = await geocodeAddress(query)
          const i = nextSales.findIndex((x) => x.id === sale.id)
          if (i >= 0) {
            const merged = {
              ...nextSales[i],
              addressQuery: String(nextSales[i].addressQuery || '').trim() ? nextSales[i].addressQuery : query,
              lat: g.lat,
              lon: g.lon,
              displayName: g.displayName,
            }
            merged.needsReview = computeSaleNeedsReview(merged)
            nextSales[i] = merged
            placed += 1
          }
        } catch {
          failed += 1
          failedIds.push(sale.id)
          const i = nextSales.findIndex((x) => x.id === sale.id)
          if (i >= 0) {
            nextSales[i] = { ...nextSales[i], needsReview: true }
          }
        }
      }
    } finally {
      setGeocodingSaleId(null)
    }
    persist({ sales: nextSales })
    setRouteResult(null)
    setBusy(null)
    setBulkGeocodeStatus({
      phase: 'done',
      placed,
      failed,
      skipped,
      skippedWrongDay,
      failedIds,
      noAddressQueryIds,
    })
    if (failed || skipped || skippedWrongDay || ineligibleCount) {
      const parts = []
      if (failed) parts.push(`Couldn't place ${failed} sale(s) on the map`)
      if (skipped) parts.push(`Skipped ${skipped} sale(s) with no readable address`)
      if (skippedWrongDay) parts.push(`Skipped ${skippedWrongDay} sale(s) not on ${formatIsoDateLabel(tripIso)}`)
      if (ineligibleCount) parts.push(`${ineligibleCount} sale(s) weren’t eligible for this trip day`)
      setError(
        `${parts.join('. ')}. Open each sale and add city, state, or ZIP, then try again.`,
      )
    }
  }

  const withinRadius = useMemo(() => {
    if (!home) {
      const all = {}
      displayedSales.forEach((s) => {
        all[s.id] = true
      })
      return all
    }
    const rKm = milesToKm(settings.searchRadiusMiles)
    const map = {}
    displayedSales.forEach((s) => {
      if (s.lat == null || s.lon == null) return false
      map[s.id] = haversineKm(home.lat, home.lon, s.lat, s.lon) <= rKm
    })
    return map
  }, [home, displayedSales, settings.searchRadiusMiles])

  const importPct = useMemo(() => {
    const p = photoImportProgress
    if (!p?.total) return 0
    const slice = 100 / p.total
    const base = (p.current - 1) * slice
    if (p.phase === 'ai') return Math.min(99, Math.round(base + slice * 0.93))
    if (p.phase === 'prepare') return Math.round(base + slice * 0.05)
    const ocr = Number(p.ocrPct) || 0
    const ocrFrac = (ocr / 100) * slice * 0.88
    return Math.min(99, Math.round(base + slice * 0.06 + ocrFrac))
  }, [photoImportProgress])

  const guided = settings.uiLayout !== 'full'
  const guidedStep = Math.min(4, Math.max(1, Number(settings.guidedStep) || 1))
  const setGuidedStep = (n) => {
    const next = Math.min(4, Math.max(1, n))
    persist({ settings: { ...settings, guidedStep: next } })
  }

  const renderTripTools = () => {
    if (sales.length === 0) return null
    return (
      <div className="ysm-trip-tools">
        <p className="ysm-trip-tools-label">On the road</p>
        <div className="ysm-toolbar" role="toolbar" aria-label="Trip tools">
          <button
            type="button"
            className="ysm-toolbar-btn"
            onClick={() => setGroundMode(true)}
            aria-describedby="ysm-ground-help"
          >
            On-the-ground mode
          </button>
          <button type="button" className="ysm-toolbar-btn" onClick={() => shareTripList()}>
            Share trip
          </button>
          <button type="button" className="ysm-toolbar-btn" onClick={() => copyTripList()}>
            Copy list
          </button>
        </div>
        <p id="ysm-ground-help" className="ysm-toolbar-hint">
          <strong>On-the-ground mode:</strong> full-screen <strong>addresses and hours</strong> for your trip (or route
          order). Stays on this device — use when the map’s slow or you only want a simple list.
        </p>
      </div>
    )
  }

  return (
    <div className="ysm-shell">
      {globalPhotoBusy ? (
        <div
          className="ysm-global-busy"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label={photoImportProgress ? 'Reading photos' : 'Updating sale from photo'}
        >
          <div className="ysm-global-busy-inner">
            <div className="ysm-global-busy-spinner" aria-hidden />
            {photoImportProgress ? (
              <>
                <p className="ysm-global-busy-title">Reading your photos…</p>
                <p className="ysm-global-busy-sub">
                  Photo {photoImportProgress.current} of {photoImportProgress.total}
                </p>
                {photoImportProgress.detail ? (
                  <p className="ysm-global-busy-detail">{photoImportProgress.detail}</p>
                ) : null}
                <div className="ysm-global-busy-track">
                  <div className="ysm-global-busy-fill" style={{ width: `${importPct}%` }} />
                </div>
                <p className="ysm-global-busy-tip">
                  {guided ? (
                    <>
                      When this finishes, go to the <strong>Plan</strong> step, set your starting point, then tap{' '}
                      <strong>Plan my driving order</strong>.
                    </>
                  ) : (
                    <>
                      When this finishes, open <strong>Trip planner</strong> below: use <strong>Plan a trip today</strong> or{' '}
                      <strong>Plan a future trip</strong> (then choose the date).
                    </>
                  )}
                </p>
                <p className="ysm-global-busy-hint">
                  If a step sits for a bit, the app is working around slow phone photo decoding (especially on Android).
                  The <strong>first</strong> text scan also downloads the on-device reader—stay on this tab. The optional
                  smart reader needs internet and times out after about a minute; OCR still runs if it doesn’t finish.
                </p>
              </>
            ) : (
              <>
                <p className="ysm-global-busy-title">Updating this sale…</p>
                <p className="ysm-global-busy-sub">Re-reading your photo (text and details).</p>
                <p className="ysm-global-busy-hint">Hang tight—this usually takes a few seconds.</p>
              </>
            )}
          </div>
        </div>
      ) : null}
      <header className="ysm-header">
        <div className="ysm-header-top">
          <div className="ysm-header-copy">
            <h1 className="ysm-header-title">Yard Sale Route Planner</h1>
            <p className="ysm-header-lede">
              Photograph flyers or screenshots—we read addresses and times, place pins, and rank stops with your keywords.
              Free, private, and runs entirely in your browser.
            </p>
          </div>
          <div className="ysm-header-actions">
            <div className="ysm-theme-toggle" role="group" aria-label="Appearance">
              <button
                type="button"
                className={
                  normalizeColorScheme(settings.colorScheme) === 'dark'
                    ? 'ysm-theme-toggle-btn ysm-theme-toggle-btn--active'
                    : 'ysm-theme-toggle-btn'
                }
                onClick={() => persist({ settings: { ...settings, colorScheme: 'dark' } })}
                aria-pressed={normalizeColorScheme(settings.colorScheme) === 'dark'}
              >
                Dark
              </button>
              <button
                type="button"
                className={
                  normalizeColorScheme(settings.colorScheme) === 'light'
                    ? 'ysm-theme-toggle-btn ysm-theme-toggle-btn--active'
                    : 'ysm-theme-toggle-btn'
                }
                onClick={() => persist({ settings: { ...settings, colorScheme: 'light' } })}
                aria-pressed={normalizeColorScheme(settings.colorScheme) === 'light'}
              >
                Light
              </button>
            </div>
            <button
              type="button"
              className="ysm-layout-toggle-btn"
              onClick={() =>
                persist({
                  settings: {
                    ...settings,
                    uiLayout: guided ? 'full' : 'guided',
                  },
                })
              }
              aria-pressed={guided}
            >
              {guided ? 'All tools' : 'Guided'}
            </button>
          </div>
        </div>
      </header>

      {guided ? (
        <div className="ysm-guided-banner" role="status">
          <span className="ysm-guided-banner-badge">Guided</span>
          <span className="ysm-guided-banner-text">
            One step at a time—only the current step is shown. Tap <strong>All tools</strong> above for the full scrollable
            page.
          </span>
        </div>
      ) : null}

      {offline ? (
        <div className="ysm-offline-banner" role="status">
          You’re offline—you can still add photos and edit text. <strong>Map lookup</strong> and the{' '}
          <strong>smart reader</strong> need internet when you’re back online.
        </div>
      ) : null}

      <main className="ysm-layout">
        {guided ? (
          <nav className="ysm-guided-stepper" aria-label="Setup steps">
            {[
              { n: 1, label: 'Add' },
              { n: 2, label: 'Review' },
              { n: 3, label: 'Plan' },
              { n: 4, label: 'Map' },
            ].map(({ n, label }) => (
              <button
                key={n}
                type="button"
                className={`ysm-guided-step${guidedStep === n ? ' is-active' : ''}${guidedStep > n ? ' is-done' : ''}`}
                onClick={() => setGuidedStep(n)}
                aria-current={guidedStep === n ? 'step' : undefined}
              >
                <span className="ysm-guided-step-num" aria-hidden>
                  {n}
                </span>
                <span className="ysm-guided-step-label">{label}</span>
              </button>
            ))}
          </nav>
        ) : (
          <nav className="ysm-section-nav" aria-label="Jump to section">
            <a className="ysm-section-nav-link" href="#ysm-photos">
              Photos
            </a>
            <a className="ysm-section-nav-link" href="#ysm-sales">
              Sales
            </a>
            <a className="ysm-section-nav-link" href="#ysm-plan">
              Plan
            </a>
            <a className="ysm-section-nav-link" href="#ysm-map">
              Map
            </a>
          </nav>
        )}
        <section className="ysm-main-inner">
          <div className="ysm-main-inner-body">
          {error ? <div className="ysm-banner ysm-banner--error">{error}</div> : null}
          {busy ? <div className="ysm-banner ysm-banner--busy">{busy}</div> : null}

          {sales.length === 0 && !settings.gettingStartedDismissed && (!guided || guidedStep === 1) ? (
            <div className="ysm-getting-started" role="region" aria-label="Getting started">
              <div className="ysm-getting-started-head">
                <span className="ysm-getting-started-kicker">Quick start</span>
                <button
                  type="button"
                  className="ysm-getting-started-dismiss"
                  onClick={() => persist({ settings: { ...settings, gettingStartedDismissed: true } })}
                >
                  Dismiss
                </button>
              </div>
              <ol className="ysm-getting-started-steps">
                <li>
                  <strong>Add photos</strong> — flyer or screenshot with an address. We read text on your device; the smart
                  reader runs when you’re online.
                </li>
                <li>
                  <strong>Pin each stop</strong> — open the sale, fix the address if needed, tap <strong>Put on map</strong>.
                </li>
                <li>
                  <strong>Plan the drive</strong> — in Trip planner, set where you’re starting from, choose the day, then
                  build your route.
                </li>
              </ol>
            </div>
          ) : null}

          {(!guided || guidedStep === 1) && (
            <>
          {guided ? (
            <>
              <h2 className="ysm-section-title ysm-section-title--flush" id="ysm-trip-day">
                Trip day
              </h2>
              <p style={{ fontSize: 13, color: 'var(--ysm-text-muted)', margin: '0 0 10px', lineHeight: 1.45 }}>
                Which day are you driving? Only sales dated for this day can go on your planned route.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--ysm-text-strong)' }}>
                  <input
                    type="radio"
                    name="trip-day-mode-guided"
                    checked={(settings.tripDayMode || 'today') === 'today'}
                    onChange={() => {
                      persist({ settings: { ...settings, tripDayMode: 'today' } })
                      setRouteResult(null)
                    }}
                  />
                  Plan for today
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--ysm-text-strong)' }}>
                  <input
                    type="radio"
                    name="trip-day-mode-guided"
                    checked={(settings.tripDayMode || 'today') === 'future'}
                    onChange={() => {
                      persist({
                        settings: { ...settings, tripDayMode: 'future', tripDayIso: settings.tripDayIso || todayIsoLocal() },
                      })
                      setRouteResult(null)
                    }}
                  />
                  Plan for another day
                </label>
              </div>
              {(settings.tripDayMode || 'today') === 'future' ? (
                <label style={{ ...labelSmall(), display: 'block', marginBottom: 14 }}>
                  Date
                  <input
                    type="date"
                    value={normalizeIsoDate(settings.tripDayIso) || ''}
                    onChange={(e) => {
                      persist({ settings: { ...settings, tripDayIso: normalizeIsoDate(e.target.value) } })
                      setRouteResult(null)
                    }}
                    style={inp()}
                  />
                </label>
              ) : (
                <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ysm-text-muted)' }}>
                  Trip day:{' '}
                  <strong style={{ color: 'var(--ysm-text-strong)' }}>{formatIsoDateLabel(activeTripIso)}</strong>
                </p>
              )}
            </>
          ) : null}
          <h2 className="ysm-section-title ysm-section-title--flush" id="ysm-photos">
            Photos
          </h2>
          <p style={{ fontSize: 13, color: 'var(--ysm-text-muted)', margin: '0 0 8px', lineHeight: 1.45 }}>
            Upload screenshots or pictures of yard sale signs and posts that include an address.
          </p>
          <label className="ysm-btn-primary">
            Upload screenshots / photos
            <input type="file" accept="image/*" multiple onChange={onUpload} style={{ display: 'none' }} />
          </label>

          <h2 className="ysm-section-title" id="ysm-keywords">
            What you’re looking for
          </h2>
          <p style={{ fontSize: 13, color: 'var(--ysm-text-muted)', margin: '0 0 8px', lineHeight: 1.45 }}>
            Type words to hunt for, separated by commas (e.g. <em>Lego, Nintendo, tools</em>). Sales that mention them rank
            higher on the map and in your trip order.
          </p>
          <textarea
            value={String(interests?.[0]?.keywords || '')}
            onChange={(e) => onInterestsChange([{ id: interests?.[0]?.id || newId(), label: 'Keywords', keywords: e.target.value }])}
            placeholder="keywords, separated by commas"
            rows={3}
            style={{ ...inp(), resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 14,
                color: 'var(--ysm-text-strong)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={settings.showPriorityOnly}
                onChange={(e) => {
                  persist({ settings: { ...settings, showPriorityOnly: e.target.checked } })
                  setRouteResult(null)
                }}
              />
              Only include sales that match my keywords
            </label>
          </div>
            </>
          )}

          {(!guided || guidedStep === 2) && (
            <>
          <h2 className="ysm-section-title" id="ysm-sales">
            Your sales ({displayedSales.length}
            {sales.length > 0 && displayedSales.length !== sales.length ? ` of ${sales.length}` : ''})
          </h2>
          <label style={{ ...labelSmall(), display: 'block', marginBottom: 10 }}>
            Sort list
            <select
              value={settings.listSortMode || 'newest'}
              onChange={(e) => {
                persist({ settings: { ...settings, listSortMode: e.target.value } })
                setRouteResult(null)
              }}
              style={inp()}
            >
              <option value="newest">Newest added</option>
              <option value="distance">Distance (nearest first)</option>
              <option value="opens">Opens soonest</option>
              <option value="match">Best keyword matches</option>
              <option value="title">Title (A–Z)</option>
            </select>
          </label>
          <label style={{ ...labelSmall(), display: 'block', marginBottom: 14 }}>
            Visited sales
            <select
              value={String(settings.hideVisitedWithinDays ?? 0)}
              onChange={(e) => {
                persist({ settings: { ...settings, hideVisitedWithinDays: Number(e.target.value) } })
                setRouteResult(null)
              }}
              style={inp()}
            >
              <option value="0">Show all (don’t hide visits)</option>
              <option value="7">Hide if visited in the last 7 days</option>
              <option value="14">Hide if visited in the last 14 days</option>
              <option value="30">Hide if visited in the last 30 days</option>
              <option value="60">Hide if visited in the last 60 days</option>
              <option value="90">Hide if visited in the last 90 days</option>
            </select>
          </label>

          {needsReviewCount > 0 ? (
            <div className="ysm-banner ysm-banner--review" role="status">
              <div className="ysm-banner-review-row">
                <span>
                  <strong>{needsReviewCount}</strong> {needsReviewCount === 1 ? 'sale needs' : 'sales need'} a quick check
                  (day or address) before you drive.
                </span>
                <button type="button" className="ysm-banner-review-btn" onClick={scrollToFirstNeedsReview}>
                  Jump to first
                </button>
              </div>
            </div>
          ) : null}

          {settings.showPriorityOnly ? (
            <p style={{ fontSize: 13, color: 'var(--ysm-text-subtle)', margin: '-8px 0 12px', lineHeight: 1.45 }}>
              The map pin button shows <strong style={{ color: 'var(--ysm-text-success)', fontWeight: 600 }}>On map</strong> when a pin exists.
              Sales without a pin show <span className="ysm-map-badge ysm-map-badge--off">No pin yet</span>.
            </p>
          ) : null}

          <details className="ysm-details">
            <summary>Save or restore everything</summary>
            <p style={{ fontSize: 13, color: 'var(--ysm-text-muted)', margin: '0 0 10px', lineHeight: 1.45 }}>
              Download a file with all your sales, photos, and settings—or bring them back on a new phone. Restoring
              reloads the app.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                onClick={async () => {
                  setError(null)
                  try {
                    await downloadJsonBackup(loadState())
                  } catch (err) {
                    setError(err.message || String(err))
                  }
                }}
                style={btn()}
              >
                Download copy
              </button>
              <label style={{ ...btn(), display: 'inline-block' }}>
                Restore from file
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={async (ev) => {
                    const file = ev.target.files?.[0]
                    ev.target.value = ''
                    if (!file) return
                    setError(null)
                    setBusy('Restoring…')
                    try {
                      const text = await file.text()
                      const state = await importBackupJson(text)
                      writeFullState(state)
                      window.location.reload()
                    } catch (err) {
                      setError(err.message || String(err))
                    } finally {
                      setBusy(null)
                    }
                  }}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          </details>

          <details className="ysm-details" style={{ marginBottom: 12 }}>
            <summary>How this list works</summary>
            <p style={{ fontSize: 13, color: 'var(--ysm-text-subtle)', margin: '10px 0 8px', lineHeight: 1.45 }}>
              Tap a row to open details, mark visited, map links, and hours.
            </p>
            {home ? (
              <p style={{ fontSize: 13, color: 'var(--ysm-text-subtle)', margin: 0, lineHeight: 1.45 }}>
                <strong style={{ color: 'var(--ysm-text-muted)', fontWeight: 600 }}>Dimmed rows</strong> are either not on the map yet
                (no pin) or beyond your “How far out to include” radius in Trip planner. Use <strong>Put on map</strong> on a row,{' '}
                <strong>Put all eligible sales on map</strong> in Trip planner, or widen the radius.
              </p>
            ) : null}
          </details>
          {sales.length === 0 ? (
            <div className="ysm-empty-sales">
              <p style={{ color: 'var(--ysm-text-muted)', fontSize: 14, margin: '0 0 8px', lineHeight: 1.5 }}>
                No sales yet. Use <strong style={{ color: 'var(--ysm-text-strong)' }}>Upload screenshots / photos</strong>{' '}
                above to add flyers, then scroll to <strong style={{ color: 'var(--ysm-text-strong)' }}>Trip planner</strong>{' '}
                to set a starting point and choose <strong style={{ color: 'var(--ysm-text-strong)' }}>Plan a trip today</strong>{' '}
                or <strong style={{ color: 'var(--ysm-text-strong)' }}>Plan a future trip</strong>.
              </p>
            </div>
          ) : displayedSales.length === 0 ? (
            <p style={{ color: 'var(--ysm-text-subtle)', fontSize: 14 }}>
              Nothing matches your filters. Try turning off keyword-only or “visited” hiding, or add different sales.
            </p>
          ) : (
            [...displayedSales]
              .sort((a, b) => {
                const da = dateSortKey(getSaleDayIso(a))
                const db = dateSortKey(getSaleDayIso(b))
                if (da !== db) return da.localeCompare(db)
                return 0
              })
              .reduce((groups, s) => {
                const key = getSaleDayIso(s) || ''
                const last = groups[groups.length - 1]
                if (!last || last.key !== key) groups.push({ key, items: [s] })
                else last.items.push(s)
                return groups
              }, [])
              .map((group) => {
                const daySorted = sortSalesForList(group.items, settings.listSortMode || 'newest', home)
                return (
                  <div key={group.key || 'unknown'} style={{ marginTop: 10 }}>
                    <div className="ysm-day-group-header">
                      <div style={{ fontSize: 13, color: 'var(--ysm-text-strong)', fontWeight: 700 }}>
                        {formatIsoDateLabel(group.key || null)}
                      </div>
                    </div>
                    {daySorted.map((s) => {
              const onMap = s.lat != null && s.lon != null
              const keywordLine = [
                matchSummaryLine(s.priorityScore, s.interestMatches),
                s.interestMatches?.length ? s.interestMatches.map((m) => m.keyword).join(', ') : null,
              ]
                .filter(Boolean)
                .join(' · ')
              const mapVisitParts = []
              if (home && onMap) {
                mapVisitParts.push(`~${kmToMiles(haversineKm(home.lat, home.lon, s.lat, s.lon)).toFixed(1)} mi`)
              }
              if (s.visitedAt != null && !Number.isNaN(s.visitedAt)) {
                mapVisitParts.push(`Visited ${shortVisitLabel(s.visitedAt)}`)
              }
              const mapVisitLine = mapVisitParts.length ? mapVisitParts.join(' · ') : ''

              const cardOpen = saleCardOpen[s.id] === true
              const trip = saleTripEligibility(s, activeTripIso)
              return (
                <div
                  id={`ysm-sale-${s.id}`}
                  key={s.id}
                  className={`ysm-sale-card${withinRadius[s.id] || !home ? '' : ' ysm-sale-out'}${cardOpen ? ' is-open' : ''}`}
                  style={{
                    opacity: withinRadius[s.id] || !home ? 1 : 0.72,
                  }}
                >
                  <div
                    className="ysm-sale-card-header"
                    role="button"
                    tabIndex={0}
                    aria-expanded={cardOpen}
                    onClick={(e) => {
                      if (eventTargetIsInsideButton(e.target)) return
                      setSaleCardBodyMounted((m) => ({ ...m, [s.id]: true }))
                      setSaleCardOpen((prev) => ({ ...prev, [s.id]: !(prev[s.id] === true) }))
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      if (eventTargetIsInsideButton(e.target)) return
                      e.preventDefault()
                      setSaleCardBodyMounted((m) => ({ ...m, [s.id]: true }))
                      setSaleCardOpen((prev) => ({ ...prev, [s.id]: !(prev[s.id] === true) }))
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0, paddingRight: 4 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 15,
                          lineHeight: 1.3,
                          color: 'var(--ysm-text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                      >
                        {displaySaleTitle(s.title)}
                      </div>
                      {settings.showPriorityOnly && !onMap ? (
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 6,
                            alignItems: 'center',
                            marginTop: 6,
                          }}
                        >
                          <span
                            className="ysm-map-badge ysm-map-badge--off"
                            title="Not geocoded yet—use Put on map"
                          >
                            No pin yet
                          </span>
                        </div>
                      ) : null}
                      {s.needsReview ? (
                        <div className="ysm-needs-review">
                          <span className="ysm-badge-review">Needs review</span>
                          <p className="ysm-needs-review-text">
                            AI isn’t perfect — double-check the address and day before you drive.
                          </p>
                          <button
                            type="button"
                            className="ysm-btn-looks-good"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              updateSaleField(s.id, { needsReview: false })
                            }}
                          >
                            Looks good
                          </button>
                        </div>
                      ) : null}
                      {keywordLine ? (
                        <div
                          className="ysm-sale-meta-line ysm-sale-meta-line--keywords"
                          title="Keyword matching (separate from map pin)"
                        >
                          {keywordLine}
                        </div>
                      ) : null}
                      {!trip.ok ? (
                        <div className="ysm-sale-meta-line" style={{ color: 'var(--ysm-text-warning)' }} title={trip.reason}>
                          {trip.reason}
                        </div>
                      ) : null}
                      {mapVisitLine ? (
                        <div className="ysm-sale-meta-line ysm-sale-meta-line--map">{mapVisitLine}</div>
                      ) : null}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        flexShrink: 0,
                        alignItems: 'stretch',
                        width: 108,
                        marginTop: 2,
                      }}
                    >
                      <button
                        type="button"
                        className={`ysm-summary-map-btn${geocodingSaleId === s.id ? ' ysm-summary-map-btn--working' : ''}${onMap ? ' ysm-summary-map-btn--on-map' : ''}`}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (!onMap) geocodeSale(s.id)
                        }}
                        disabled={
                          !s.addressQuery?.trim() ||
                          !!busySaleId ||
                          geocodingSaleId === s.id ||
                          (!!busy && geocodingSaleId !== s.id) ||
                          onMap
                        }
                        title={
                          onMap
                            ? 'Pin already placed — open the card to update the address or refresh the pin'
                            : 'Look up this address and add a pin'
                        }
                      >
                        {geocodingSaleId === s.id ? 'Working…' : onMap ? 'On map' : 'Put on map'}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          ;(async () => {
                            try {
                              const blob = await getSaleImageBlob(s.id)
                              undoSaleRef.current = JSON.parse(JSON.stringify(s))
                              undoBlobRef.current = blob
                              setUndoDeleteLabel((s.title || s.addressQuery || 'Sale').slice(0, 56))
                              scheduleUndoExpiry()
                              await deleteSaleImage(s.id)
                              persist({ sales: removeSale(loadState().sales, s.id) })
                              setRouteResult(null)
                              setSaleCardOpen((prev) => {
                                const next = { ...prev }
                                delete next[s.id]
                                return next
                              })
                              setSaleCardBodyMounted((prev) => {
                                const next = { ...prev }
                                delete next[s.id]
                                return next
                              })
                            } catch (err) {
                              setError(err.message || String(err))
                            }
                          })()
                        }}
                        style={{ ...btnGhost(), flexShrink: 0 }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {saleCardBodyMounted[s.id] ? (
                  <div className="ysm-sale-body" hidden={!cardOpen}>
                    <SaleThumb saleId={s.id} />
                    <label style={{ ...labelSmall(), marginTop: 10 }}>
                      Address (fix if it looks wrong)
                      <input
                        value={s.addressQuery}
                        onChange={(e) => updateSaleField(s.id, { addressQuery: e.target.value })}
                        style={inp()}
                      />
                    </label>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => geocodeSale(s.id)}
                        disabled={
                          !s.addressQuery?.trim() ||
                          !!busySaleId ||
                          geocodingSaleId === s.id ||
                          (!!busy && geocodingSaleId !== s.id)
                        }
                        style={btn()}
                      >
                        {s.lat != null && s.lon != null ? 'Update map pin' : 'Put on map'}
                      </button>
                      <button
                        type="button"
                        onClick={() => reparseSale(s.id)}
                        disabled={busySaleId === s.id}
                        style={btnGhost()}
                        title="Re-run OCR and the smart reader to refresh address, day, and times"
                      >
                        {busySaleId === s.id ? 'Reading…' : 'Read photo again'}
                      </button>
                    </div>
                    {s.lat != null && s.lon != null ? (
                      <div
                        style={{
                          fontSize: 14,
                          marginTop: 10,
                          display: 'flex',
                          gap: 16,
                          flexWrap: 'wrap',
                        }}
                      >
                        <a
                          href={buildGoogleMapsPlaceUrl(s.lat, s.lon, s.title)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--ysm-text-link)', fontWeight: 500 }}
                        >
                          Google Maps
                        </a>
                        <a
                          href={buildAppleMapsPlaceUrl(s.lat, s.lon, s.title)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--ysm-text-link)', fontWeight: 500 }}
                        >
                          Apple Maps
                        </a>
                      </div>
                    ) : null}
                    <div
                      style={{
                        marginTop: 12,
                        paddingTop: 12,
                        borderTop: '1px solid var(--ysm-border)',
                      }}
                    >
                      {s.visitedAt != null && !Number.isNaN(s.visitedAt) ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 14, color: 'var(--ysm-text-success)', fontWeight: 600 }}>
                            Visited {new Date(s.visitedAt).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateSaleField(s.id, { visitedAt: null })}
                            style={btnGhost()}
                          >
                            Forget visit
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => updateSaleField(s.id, { visitedAt: Date.now() })}
                          style={btn()}
                        >
                          Mark as visited
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                      <label style={labelSmall()}>
                        Day (optional)
                        <input
                          type="date"
                          value={normalizeIsoDate(s.saleDate) || getSaleDayIso(s) || ''}
                          onChange={(e) => updateSaleField(s.id, { saleDate: normalizeIsoDate(e.target.value) })}
                          style={inp()}
                        />
                      </label>
                      <label style={labelSmall()}>
                        Opens
                        <input
                          type="time"
                          value={timeInputValue(s.openMinutes)}
                          onChange={(e) =>
                            updateSaleField(s.id, { openMinutes: parseTimeInputValue(e.target.value) })
                          }
                          style={inp()}
                        />
                      </label>
                      <label style={labelSmall()}>
                        Close (optional)
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                          <input
                            type="time"
                            value={timeInputValue(s.closeMinutes)}
                            onChange={(e) =>
                              updateSaleField(s.id, {
                                closeMinutes: e.target.value ? parseTimeInputValue(e.target.value) : null,
                              })
                            }
                            style={{ ...inp(), marginTop: 0, flex: 1 }}
                          />
                          <button
                            type="button"
                            onClick={() => updateSaleField(s.id, { closeMinutes: null })}
                            style={btnGhost()}
                          >
                            Clear
                          </button>
                        </div>
                      </label>
                    </div>
                    <details className="ysm-details ysm-subdetails" style={{ marginTop: 12 }}>
                      <summary>Advanced · full text from photo</summary>
                      <p style={{ fontSize: 12, color: 'var(--ysm-text-subtle)', margin: '0 0 8px', lineHeight: 1.45 }}>
                        Only open this if something looks wrong—you can fix the text here.
                      </p>
                      <textarea
                        value={s.rawText}
                        onChange={(e) => updateSaleField(s.id, { rawText: e.target.value, interestsRefresh: true })}
                        rows={4}
                        style={{ ...inp(), resize: 'vertical', fontSize: 15 }}
                      />
                    </details>
                  </div>
                  ) : null}
                </div>
              )
                    })}
                  </div>
                )
              })
          )}

            </>
          )}

          {(!guided || guidedStep === 3) && (
            <>
          <h2 className="ysm-section-title" id="ysm-plan">
            Trip planner
          </h2>
          {!guided && renderTripTools()}
          <div style={{ display: 'grid', gap: 10, marginBottom: 10 }}>
            <div>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--ysm-text-muted)', fontWeight: 600, letterSpacing: '0.02em' }}>
                Starting point
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <input
                  value={homeInput}
                  onChange={(e) => setHomeInput(e.target.value)}
                  placeholder="Street, city, state"
                  style={{
                    ...inp(),
                    flex: '1 1 180px',
                    minWidth: 0,
                    marginTop: 0,
                    padding: '10px 12px',
                  }}
                />
                <button
                  type="button"
                  onClick={onGeocodeHome}
                  disabled={!!homeStartingPointBusy || !!busy || !!busySaleId}
                  aria-busy={homeStartingPointBusy === 'address'}
                  className={
                    homeStartingPointSuccess === 'address'
                      ? 'ysm-starting-point-btn ysm-starting-point-btn--success'
                      : 'ysm-starting-point-btn'
                  }
                  style={btn()}
                >
                  {homeStartingPointBusy === 'address' ? (
                    <>
                      <span className="ysm-btn-spinner" aria-hidden />
                      Finding address…
                    </>
                  ) : homeStartingPointSuccess === 'address' ? (
                    'Saved — address set'
                  ) : (
                    'Use this address'
                  )}
                </button>
                <button
                  type="button"
                  onClick={onUseMyLocation}
                  disabled={!!homeStartingPointBusy || !!busy || !!busySaleId}
                  aria-busy={homeStartingPointBusy === 'location'}
                  className={
                    homeStartingPointSuccess === 'location'
                      ? 'ysm-starting-point-btn ysm-starting-point-btn--success'
                      : 'ysm-starting-point-btn'
                  }
                  style={btn()}
                >
                  {homeStartingPointBusy === 'location' ? (
                    <>
                      <span className="ysm-btn-spinner" aria-hidden />
                      Getting your location…
                    </>
                  ) : homeStartingPointSuccess === 'location' ? (
                    'Saved — using your location'
                  ) : (
                    'Use where I am now'
                  )}
                </button>
              </div>
              {homeStartingPointSuccess && !homeStartingPointBusy ? (
                <p className="ysm-starting-point-inline-ok" role="status">
                  {homeStartingPointSuccess === 'address'
                    ? 'Starting point updated from the address you entered.'
                    : 'Starting point set to your current location.'}
                </p>
              ) : null}
              {home ? (
                <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--ysm-text-muted)', lineHeight: 1.45 }}>
                  {home.label || `${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}`}
                </p>
              ) : (
                <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--ysm-text-subtle)', lineHeight: 1.45 }}>
                  Add a starting point to see what’s nearby and build a driving order.
                </p>
              )}
            </div>
            {!guided ? (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--ysm-text-strong)' }}>
                    <input
                      type="radio"
                      name="trip-day-mode"
                      checked={(settings.tripDayMode || 'today') === 'today'}
                      onChange={() => {
                        persist({ settings: { ...settings, tripDayMode: 'today' } })
                        setRouteResult(null)
                      }}
                    />
                    Plan a trip today
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--ysm-text-strong)' }}>
                    <input
                      type="radio"
                      name="trip-day-mode"
                      checked={(settings.tripDayMode || 'today') === 'future'}
                      onChange={() => {
                        persist({
                          settings: { ...settings, tripDayMode: 'future', tripDayIso: settings.tripDayIso || todayIsoLocal() },
                        })
                        setRouteResult(null)
                      }}
                    />
                    Plan a future trip
                  </label>
                </div>
                {(settings.tripDayMode || 'today') === 'future' ? (
                  <label style={labelSmall()}>
                    Trip day
                    <input
                      type="date"
                      value={normalizeIsoDate(settings.tripDayIso) || ''}
                      onChange={(e) => {
                        persist({ settings: { ...settings, tripDayIso: normalizeIsoDate(e.target.value) } })
                        setRouteResult(null)
                      }}
                      style={inp()}
                    />
                  </label>
                ) : (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--ysm-text-muted)' }}>
                    Trip day: <strong style={{ color: 'var(--ysm-text-strong)' }}>{formatIsoDateLabel(activeTripIso)}</strong>. Only sales with
                    “Day” set to this date are eligible.
                  </p>
                )}
              </>
            ) : (
              <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--ysm-text-muted)', lineHeight: 1.45 }}>
                Trip day: <strong style={{ color: 'var(--ysm-text-strong)' }}>{formatIsoDateLabel(activeTripIso)}</strong> — set on the{' '}
                <strong>Add</strong> step if you need to change it.
              </p>
            )}
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ysm-text-subtle)', lineHeight: 1.45 }}>
              Eligible for {formatIsoDateLabel(activeTripIso)}:{' '}
              <strong style={{ color: 'var(--ysm-text-strong)' }}>{tripEligibleSales.length}</strong> · Not eligible:{' '}
              <strong style={{ color: 'var(--ysm-text-strong)' }}>{Math.max(0, displayedSales.length - tripEligibleSales.length)}</strong>
            </p>
            {home?.lat != null && home?.lon != null && activeTripIso ? (
              <div
                className={`ysm-weather-strip ysm-weather-strip--${tripWeather?.level || 'ok'}`}
                role="status"
                aria-live="polite"
              >
                <div className="ysm-weather-strip-top">
                  <span className="ysm-weather-strip-label">Trip day weather</span>
                  <button
                    type="button"
                    className="ysm-weather-refresh"
                    onClick={() => refreshTripWeather()}
                    disabled={weatherLoading}
                  >
                    {weatherLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
                {weatherLoading ? (
                  <span>Checking weather for {formatIsoDateLabel(activeTripIso)}…</span>
                ) : tripWeather ? (
                  <>
                    <span className="ysm-weather-headline">{tripWeather.headline}</span>
                    {tripWeather.detail ? (
                      <span className="ysm-weather-detail">{tripWeather.detail}</span>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--ysm-text-subtle)', lineHeight: 1.45 }}>
                Add a starting point above to see a simple weather hint for your trip day (Open-Meteo; no API key).
              </p>
            )}
            <button
              type="button"
              onClick={bulkGeocodeMissing}
              aria-busy={bulkGeocodeStatus?.phase === 'loading'}
              style={{
                ...btnGhost(),
                justifySelf: 'start',
                width: 'fit-content',
                maxWidth: '100%',
                padding: '6px 10px',
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
              disabled={!!busy || !!busySaleId}
            >
              {bulkGeocodeStatus?.phase === 'loading' ? (
                <>
                  <span className="ysm-btn-spinner" aria-hidden />
                  <span>Finding {bulkGeocodeStatus.total} address(es)…</span>
                </>
              ) : (
                'Put all eligible sales on map'
              )}
            </button>
            {bulkGeocodeStatus?.phase === 'done' ? (
              <div className="ysm-bulk-summary" role="status">
                <p className="ysm-bulk-summary-line ysm-bulk-summary-line--ok">
                  <strong>Map pins:</strong>{' '}
                  {bulkGeocodeStatus.placed === 0
                    ? 'None added this run.'
                    : bulkGeocodeStatus.placed === 1
                      ? '1 sale placed on the map.'
                      : `${bulkGeocodeStatus.placed} sales placed on the map.`}
                  {bulkGeocodeStatus.failed > 0
                    ? ` ${bulkGeocodeStatus.failed} couldn’t be placed (map lookup failed).`
                    : ''}
                  {bulkGeocodeStatus.noAddressQueryIds?.length > 0
                    ? ` ${bulkGeocodeStatus.noAddressQueryIds.length} still need a clearer address typed in the card.`
                    : ''}
                </p>
                {(bulkGeocodeStatus.failedIds?.length > 0 || bulkGeocodeStatus.noAddressQueryIds?.length > 0) && (
                  <div className="ysm-bulk-jump">
                    <span className="ysm-bulk-jump-label">Jump to sale</span>
                    <div className="ysm-bulk-jump-btns">
                      {[
                        ...new Set([
                          ...(bulkGeocodeStatus.failedIds || []),
                          ...(bulkGeocodeStatus.noAddressQueryIds || []),
                        ]),
                      ].map((id) => {
                        const sale = sales.find((x) => x.id === id)
                        const label = (sale?.title || sale?.addressQuery || 'Sale').trim().slice(0, 28)
                        return (
                          <button key={id} type="button" className="ysm-bulk-jump-btn" onClick={() => scrollToSaleId(id)}>
                            {label || 'Sale'}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <details className="ysm-details" style={{ marginTop: 0 }}>
            <summary>Driving assumptions (tap to change)</summary>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <label style={labelSmall()}>
              Typical driving speed (km/h — only used to guess how long drives take)
              <input
                type="number"
                min={5}
                value={settings.avgKmh}
                onChange={(e) => persist({ settings: { ...settings, avgKmh: Number(e.target.value) || 40 } })}
                style={inp()}
              />
            </label>
            <label style={labelSmall()}>
              Minutes at each stop
              <input
                type="number"
                min={5}
                value={settings.dwellMinutes}
                onChange={(e) =>
                  persist({ settings: { ...settings, dwellMinutes: Number(e.target.value) || 20 } })
                }
                style={inp()}
              />
            </label>
            <label style={{ ...labelSmall(), gridColumn: '1 / -1' }}>
              How far out to include (miles from starting point)
              <input
                type="number"
                min={1}
                max={200}
                value={settings.searchRadiusMiles}
                onChange={(e) =>
                  persist({ settings: { ...settings, searchRadiusMiles: Number(e.target.value) || 50 } })
                }
                style={inp()}
              />
            </label>
            </div>
          </details>
          <label style={{ ...labelSmall(), marginTop: 12 }}>
            Leave at
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              style={inp()}
            />
          </label>
          <label style={{ ...labelSmall(), marginTop: 12 }}>
            Route style
            <select
              value={normalizeRouteStrategy(settings.routeStrategy)}
              onChange={(e) => {
                persist({
                  settings: { ...settings, routeStrategy: normalizeRouteStrategy(e.target.value) },
                })
                setRouteResult(null)
              }}
              style={{ ...inp(), width: '100%' }}
            >
              <option value="fastest">Shortest driving (minimize time on the road)</option>
              <option value="keywords">Prioritize keyword matches, then shorter drives</option>
            </select>
          </label>
          <button type="button" onClick={runPlan} style={{ ...btn(), marginTop: 12, width: '100%' }}>
            Plan my driving order
          </button>
          {routeResult?.message ? (
            <p style={{ fontSize: 13, color: 'var(--ysm-text-warning)', marginTop: 8 }}>{routeResult.message}</p>
          ) : null}
          {routeResult?.ordered?.length ? (
            <>
              {routeResult.orderExplanation ? (
                <p style={{ fontSize: 12, color: 'var(--ysm-text-subtle)', marginTop: 10, lineHeight: 1.5 }}>
                  {routeResult.orderExplanation}
                </p>
              ) : null}
              {tripDriveSummary.totalDriveMinutes > 0 || tripDriveSummary.totalMiles > 0 ? (
                <p className="ysm-trip-summary" role="status">
                  Trip summary (estimate):{' '}
                  {tripDriveSummary.totalMiles > 0 ? (
                    <>~{tripDriveSummary.totalMiles.toFixed(1)} mi driving</>
                  ) : null}
                  {tripDriveSummary.totalMiles > 0 && tripDriveSummary.totalDriveMinutes > 0 ? ' · ' : null}
                  {tripDriveSummary.totalDriveMinutes > 0 ? (
                    <>~{tripDriveSummary.totalDriveMinutes} min on the road</>
                  ) : null}
                  . Straight-line distance between stops; not live traffic.
                </p>
              ) : null}
              {routeResult.ordered.length > 1 ? (
                <p style={{ fontSize: 12, color: 'var(--ysm-text-subtle)', margin: '10px 0 0', lineHeight: 1.45 }}>
                  Reorder stops with ↑ / ↓. Times update to match — open maps from the <strong>Map</strong> step.
                </p>
              ) : null}
              <ol
                style={{
                  paddingLeft: 0,
                  listStyle: 'none',
                  margin: '10px 0 0',
                  fontSize: 14,
                  color: 'var(--ysm-text-strong)',
                }}
              >
                {routeResult.ordered.map((s, i) => {
                  const n = routeResult.ordered.length
                  const atTop = i === 0
                  const atBottom = i === n - 1
                  return (
                    <li key={s.id} style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      {n > 1 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                          <button
                            type="button"
                            aria-label={`Move up: ${s.title || 'stop'}`}
                            disabled={atTop}
                            onClick={() => moveRouteStop(i, -1)}
                            style={{
                              ...btnGhost(),
                              padding: '4px 8px',
                              fontSize: 13,
                              lineHeight: 1.1,
                              opacity: atTop ? 0.35 : 1,
                              cursor: atTop ? 'not-allowed' : 'pointer',
                            }}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move down: ${s.title || 'stop'}`}
                            disabled={atBottom}
                            onClick={() => moveRouteStop(i, 1)}
                            style={{
                              ...btnGhost(),
                              padding: '4px 8px',
                              fontSize: 13,
                              lineHeight: 1.1,
                              opacity: atBottom ? 0.35 : 1,
                              cursor: atBottom ? 'not-allowed' : 'pointer',
                            }}
                          >
                            ↓
                          </button>
                        </div>
                      ) : null}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <strong>{i + 1}.</strong> {s.title}{' '}
                        <span style={{ color: 'var(--ysm-text-muted)' }}>
                          — about {minutesToLabel(s.plannedArrivalMinutes)} (~{Math.round(s.travelFromPreviousMinutes)}{' '}
                          min drive)
                        </span>
                        {s.arrivalAfterClose ? (
                          <span style={{ color: 'var(--ysm-text-warning)', fontSize: 12 }}> (arrives after closing)</span>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </>
          ) : null}

            </>
          )}

          {(!guided || guidedStep === 4) && (
            <>
              {guided && guidedStep === 4 && renderTripTools()}
          <h2 className="ysm-section-title" id="ysm-map">
            Map
          </h2>
          <div className="ysm-map-panel">
            <SaleMap
              home={home}
              autoCenter={autoCenter}
              sales={displayedSales}
              routeLegs={routeResult?.legs}
              radiusMiles={home ? settings.searchRadiusMiles : 0}
              height="min(58vh, 520px)"
            />
          </div>
          {routeResult?.ordered?.length > 0 && home ? (
            <div className="ysm-maps-nav-links" style={{ display: 'grid', gap: 8, marginTop: 14 }}>
              <a
                href={buildGoogleMapsDirectionsUrl(home, routeResult.ordered.slice(0, 1))}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...btn(),
                  display: 'block',
                  textAlign: 'center',
                  textDecoration: 'none',
                  background: '#1e40af',
                  borderColor: '#2563eb',
                }}
              >
                Open only stop #1 in Google Maps
              </a>
              <a
                href={buildGoogleMapsDirectionsUrl(home, routeResult.ordered)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...btn(),
                  display: 'block',
                  textAlign: 'center',
                  textDecoration: 'none',
                  background: '#166534',
                  borderColor: '#15803d',
                }}
              >
                Open route in Google Maps
              </a>
              <a
                href={buildAppleMapsDirectionsUrl(home, routeResult.ordered)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...btn(),
                  display: 'block',
                  textAlign: 'center',
                  textDecoration: 'none',
                  background: '#1e3a5f',
                  borderColor: '#334155',
                }}
              >
                Open route in Apple Maps
              </a>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--ysm-text-subtle)' }}>
                Tip: Google Maps usually follows this order best. Apple Maps sometimes changes multi-stop trips.
              </p>
            </div>
          ) : null}
            </>
          )}

          </div>

          {guided ? (
            <div className="ysm-guided-footer">
              <button
                type="button"
                className="ysm-guided-footer-btn ysm-guided-footer-btn--back"
                disabled={guidedStep <= 1}
                onClick={() => setGuidedStep(guidedStep - 1)}
              >
                Back
              </button>
              <p className="ysm-guided-footer-hint">
                {guidedStep === 1 && 'Set trip day, add flyer photos, and optional keywords.'}
                {guidedStep === 2 && 'Open each sale, fix the address if needed, tap Put on map.'}
                {guidedStep === 3 && 'Set where you’re leaving from, pick the trip day, then plan your order.'}
                {guidedStep === 4 &&
                  'See pins, open Google or Apple Maps with your route, share your list, or use on-the-ground mode.'}
              </p>
              {guidedStep < 4 ? (
                <button
                  type="button"
                  className="ysm-guided-footer-btn ysm-guided-footer-btn--next"
                  onClick={() => setGuidedStep(guidedStep + 1)}
                >
                  {guidedStep === 1 && 'Next: Review sales'}
                  {guidedStep === 2 && 'Next: Plan trip'}
                  {guidedStep === 3 && 'Next: Map'}
                </button>
              ) : (
                <button
                  type="button"
                  className="ysm-guided-footer-btn ysm-guided-footer-btn--next"
                  onClick={() => persist({ settings: { ...settings, uiLayout: 'full' } })}
                >
                  Open all tools
                </button>
              )}
            </div>
          ) : null}
        </section>
      </main>

      {groundMode ? (
        <div className="ysm-ground" role="dialog" aria-modal="true" aria-label="On-the-ground checklist">
          <div className="ysm-ground-backdrop" onClick={() => setGroundMode(false)} role="presentation" />
          <div className="ysm-ground-panel">
            <div className="ysm-ground-head">
              <h2 className="ysm-ground-title">On the ground</h2>
              <p className="ysm-ground-lede">
                Addresses and times from your saved list. Everything stays on this device — works when map tiles won’t load.
              </p>
              <div className="ysm-ground-actions">
                <button type="button" className="ysm-ground-close" onClick={() => setGroundMode(false)}>
                  Close
                </button>
                <button type="button" className="ysm-ground-share" onClick={() => shareTripList()}>
                  Share trip
                </button>
                <button type="button" className="ysm-ground-close" onClick={() => copyTripList()}>
                  Copy list
                </button>
              </div>
            </div>
            {!activeTripIso || groundStops.length === 0 ? (
              <p className="ysm-ground-empty">
                Set a trip day and add sales for that date, or tap Plan my driving order first.
              </p>
            ) : (
              <ol className="ysm-ground-list">
                {groundStops.map((s, i) => {
                  const addr = String(
                    s.addressQuery || bestGeocodeQueryForSale(s) || displaySaleTitle(s.title) || '',
                  ).trim()
                  const open = s.openMinutes != null ? minutesToLabel(s.openMinutes) : '—'
                  const close = s.closeMinutes != null ? minutesToLabel(s.closeMinutes) : ''
                  const timeLine = close ? `${open} – ${close}` : `Opens ${open}`
                  return (
                    <li key={s.id} className="ysm-ground-item">
                      <div className="ysm-ground-item-head">
                        <span className="ysm-ground-stop-num">{i + 1}</span>
                        <span className="ysm-ground-stop-title">{displaySaleTitle(s.title)}</span>
                      </div>
                      <div className="ysm-ground-item-addr">{addr}</div>
                      <div className="ysm-ground-item-time">{timeLine}</div>
                      {s.lat != null && s.lon != null ? (
                        <a
                          href={buildGoogleMapsPlaceUrl(s.lat, s.lon, s.title)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ysm-ground-maps-link"
                        >
                          Open in Google Maps
                        </a>
                      ) : (
                        <span className="ysm-ground-no-pin">
                          No pin yet — open the sale below when you’re online and tap Put on map.
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </div>
      ) : null}

      {shareToast ? (
        <div className="ysm-toast" role="status">
          {shareToast}
        </div>
      ) : null}

      {undoDeleteLabel ? (
        <div className="ysm-undo-snack" role="status">
          <span className="ysm-undo-snack-text">Removed “{undoDeleteLabel}”.</span>
          <button type="button" className="ysm-undo-snack-btn" onClick={() => undoDeleteSale()}>
            Undo
          </button>
        </div>
      ) : null}
    </div>
  )
}

function btn() {
  return {
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid var(--ysm-btn-border)',
    background: 'var(--ysm-btn-bg)',
    color: 'var(--ysm-btn-fg)',
    fontWeight: 600,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
  }
}

function btnGhost() {
  return {
    padding: '8px 10px',
    borderRadius: 10,
    border: '1px solid var(--ysm-ghost-border)',
    background: 'var(--ysm-ghost-bg)',
    color: 'var(--ysm-text)',
    fontSize: 13,
  }
}

function inp() {
  return {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 10,
    border: '1px solid var(--ysm-input-border)',
    background: 'var(--ysm-input-bg)',
    color: 'var(--ysm-text)',
    marginTop: 4,
  }
}

function labelSmall() {
  return { display: 'block', fontSize: 12, color: 'var(--ysm-text-muted)' }
}
