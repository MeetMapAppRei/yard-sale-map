import { useCallback, useEffect, useMemo, useState } from 'react'
import SaleMap from './components/SaleMap.jsx'
import SaleThumb from './components/SaleThumb.jsx'
import { loadState, saveState, writeFullState, upsertSale, removeSale, defaultInterests } from './lib/storage.js'
import { scoreTextAgainstInterests } from './lib/interests.js'
import { geocodeAddress } from './lib/geocode.js'
import { runOcrOnFile } from './lib/ocr.js'
import { minutesToLabel } from './lib/parseTimes.js'
import { planRoute } from './lib/routePlanner.js'
import { haversineKm, milesToKm } from './lib/haversine.js'
import { putSaleImage, deleteSaleImage, getSaleImageBlob } from './lib/imageStore.js'
import { downloadJsonBackup, importBackupJson } from './lib/backup.js'
import { parseScreenshotWithAi, fileToBase64, blobToBase64 } from './lib/parseScreenshotApi.js'
import { mergeOcrAndAi } from './lib/mergeAiParse.js'
import { compressImageFile } from './lib/compressImage.js'
import { buildGoogleMapsDirectionsUrl } from './lib/googleMapsRoute.js'
import {
  buildGoogleMapsPlaceUrl,
  buildAppleMapsPlaceUrl,
  buildAppleMapsDirectionsUrl,
} from './lib/mapsLinks.js'

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

/**
 * Full pipeline for one image: compress → store → OCR → optional AI → interest scoring.
 * @param {number} createdAtOffset  ms bump so batch items keep a stable order tie-break
 */
async function processScreenshotFile(file, interestRows, createdAtOffset = 0) {
  const saleId = newId()
  let toStore
  try {
    toStore = await compressImageFile(file)
  } catch {
    toStore = file
  }
  await putSaleImage(saleId, toStore)
  let rawText
  try {
    rawText = await runOcrOnFile(file, () => {})
  } catch (e) {
    await deleteSaleImage(saleId)
    throw e
  }
  let ai = null
  try {
    ai = await parseScreenshotWithAi(await fileToBase64(file), file.type)
  } catch {
    /* /api optional */
  }
  const merged = mergeOcrAndAi(ai, rawText)
  const { score, matches } = scoreTextAgainstInterests(merged.rawText, interestRows)
  return {
    id: saleId,
    title: merged.title,
    rawText: merged.rawText,
    addressQuery: merged.addressQuery,
    lat: null,
    lon: null,
    displayName: null,
    openMinutes: merged.openMinutes,
    closeMinutes: merged.closeMinutes,
    priorityScore: score,
    interestMatches: matches,
    createdAt: Date.now() + createdAtOffset,
    hasImage: true,
  }
}

function sortSalesByNewestFirst(sales) {
  return [...sales].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
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

export default function App() {
  const [home, setHome] = useState(null)
  const [homeInput, setHomeInput] = useState('')
  const [sales, setSales] = useState([])
  const [interests, setInterests] = useState(defaultInterests())
  const [settings, setSettings] = useState({
    avgKmh: 40,
    dwellMinutes: 20,
    searchRadiusMiles: 50,
    showPriorityOnly: false,
  })
  const [startTime, setStartTime] = useState('08:00')
  const [routeResult, setRouteResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const [busySaleId, setBusySaleId] = useState(null)
  const [photoImportProgress, setPhotoImportProgress] = useState(null)
  const [error, setError] = useState(null)
  /** Which sale cards have open `<details>` (key present and true). */
  const [saleCardOpen, setSaleCardOpen] = useState({})
  const [geocodingSaleId, setGeocodingSaleId] = useState(null)

  useEffect(() => {
    const s = loadState()
    setHome(s.home)
    setSales(s.sales)
    setInterests(s.interests)
    setSettings(s.settings)
  }, [])

  const globalPhotoBusy = photoImportProgress != null || busySaleId != null

  useEffect(() => {
    if (!globalPhotoBusy) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [globalPhotoBusy])

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

  const onGeocodeHome = async () => {
    setError(null)
    setBusy('Finding your address on the map…')
    try {
      const g = await geocodeAddress(homeInput)
      const h = { lat: g.lat, lon: g.lon, label: g.displayName }
      persist({ home: h })
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const onUseMyLocation = () => {
    setError(null)
    if (!navigator.geolocation) {
      setError("This browser can't use your location. Use \"Use this address\" instead.")
      return
    }
    setBusy('Getting location…')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const h = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: 'Current location',
        }
        persist({ home: h })
        setBusy(null)
      },
      (err) => {
        setError(
          err.code === 1
            ? 'Location is turned off or blocked. Allow location for this site, or type your address above.'
            : 'Could not get your location. Try again or use your address above.',
        )
        setBusy(null)
      },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  const onUpload = async (e) => {
    const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'))
    e.target.value = ''
    if (!picked.length) return
    setError(null)

    const st0 = loadState()
    const interestRows = st0.interests
    const newSales = []
    const failures = []

    try {
      for (let i = 0; i < picked.length; i++) {
        const file = picked[i]
        setPhotoImportProgress({ current: i + 1, total: picked.length })
        try {
          const sale = await processScreenshotFile(file, interestRows, i)
          newSales.push(sale)
        } catch (err) {
          failures.push(`${file.name || 'image'}: ${err.message || String(err)}`)
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

      const orderedNew = sortSalesByNewestFirst(newSales)
      const combined = [...orderedNew, ...loadState().sales]
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
    const s = state.sales.find((x) => x.id === id)
    if (!s) return
    let next = { ...s, ...patch }
    if (patch.rawText !== undefined || patch.interestsRefresh) {
      const { score, matches } = scoreTextAgainstInterests(next.rawText, state.interests)
      next.priorityScore = score
      next.interestMatches = matches
      delete next.interestsRefresh
    }
    persist({ sales: upsertSale(state.sales, next) })
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
      setSaleCardOpen((prev) => ({ ...prev, [id]: false }))
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
      setGeocodingSaleId(null)
    }
  }

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
      const ocrText = await runOcrOnFile(file, () => {})
      let ai = null
      try {
        ai = await parseScreenshotWithAi(await blobToBase64(blob), blob.type || 'image/jpeg')
      } catch (e) {
        aiError = e.message || String(e)
      }
      let merged = mergeOcrAndAi(ai, ocrText)
      const state = loadState()
      const s = state.sales.find((x) => x.id === id)
      if (!s) return
      if (merged.openMinutes == null && s.openMinutes != null) merged = { ...merged, openMinutes: s.openMinutes }
      if (merged.closeMinutes == null && s.closeMinutes != null) merged = { ...merged, closeMinutes: s.closeMinutes }
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
      if (addrChanged) {
        next.lat = null
        next.lon = null
        next.displayName = null
      }
      persist({ sales: upsertSale(state.sales, next) })
      setRouteResult(null)
      if (aiError) {
        setError(
          "Extra smart read didn't run online, but the text from your photo was refreshed. Check your connection or try again later.",
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
    const nextSales = state.sales.map((s) => {
      const { score, matches } = scoreTextAgainstInterests(s.rawText, rows)
      return { ...s, priorityScore: score, interestMatches: matches }
    })
    persist({ interests: rows, sales: nextSales })
    setRouteResult(null)
  }

  const salesOrderedByNewest = useMemo(() => sortSalesByNewestFirst(sales), [sales])

  const displayedSales = useMemo(() => {
    if (!settings.showPriorityOnly) return salesOrderedByNewest
    return salesOrderedByNewest.filter((s) => (Number(s.priorityScore) || 0) > 0)
  }, [salesOrderedByNewest, settings.showPriorityOnly])

  const runPlan = () => {
    setError(null)
    const startMinutes = parseTimeInputValue(startTime) ?? 8 * 60
    const result = planRoute({
      home,
      startMinutes,
      sales: displayedSales,
      settings,
    })
    setRouteResult(result)
  }

  const bulkGeocodeMissing = async () => {
    const state = loadState()
    const missing = state.sales.filter(
      (s) => s.addressQuery?.trim() && (s.lat == null || s.lon == null),
    )
    if (!missing.length) {
      setError(null)
      return
    }
    setError(null)
    setBusy(`Finding ${missing.length} addresses on the map…`)
    const nextSales = [...state.sales]
    let failed = 0
    try {
      for (const sale of missing) {
        setGeocodingSaleId(sale.id)
        try {
          const g = await geocodeAddress(sale.addressQuery)
          const i = nextSales.findIndex((x) => x.id === sale.id)
          if (i >= 0) {
            nextSales[i] = {
              ...nextSales[i],
              lat: g.lat,
              lon: g.lon,
              displayName: g.displayName,
            }
          }
          setSaleCardOpen((prev) => ({ ...prev, [sale.id]: false }))
        } catch {
          failed += 1
        }
      }
    } finally {
      setGeocodingSaleId(null)
    }
    persist({ sales: nextSales })
    setRouteResult(null)
    setBusy(null)
    if (failed) {
      setError(`Couldn't place ${failed} sale(s) on the map. Check those addresses and try again.`)
    }
  }

  const withinRadius = useMemo(() => {
    if (!home) return displayedSales.map(() => true)
    const rKm = milesToKm(settings.searchRadiusMiles)
    return displayedSales.map((s) => {
      if (s.lat == null || s.lon == null) return false
      return haversineKm(home.lat, home.lon, s.lat, s.lon) <= rKm
    })
  }, [home, displayedSales, settings.searchRadiusMiles])

  const importPct =
    photoImportProgress && photoImportProgress.total > 0
      ? Math.round((photoImportProgress.current / photoImportProgress.total) * 100)
      : 0

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
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
                <div className="ysm-global-busy-track">
                  <div className="ysm-global-busy-fill" style={{ width: `${importPct}%` }} />
                </div>
                <p className="ysm-global-busy-hint">
                  Pulling out addresses, times, and text. Each one can take a few seconds—especially online.
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
      <header
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid #334155',
          background: '#020617',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 700 }}>Yard Sale Route Planner</h1>
        <p style={{ margin: '8px 0 0', color: '#94a3b8', fontSize: 15, maxWidth: 640, lineHeight: 1.5 }}>
          Snap photos of flyers and posts. We pull out addresses and times, drop pins on the map, and help you plan a
          route. Tell us what you’re hunting for (games, tools, jewelry…) and the best matches rise to the top.
        </p>
      </header>

      <main className="ysm-layout">
        <section style={{ padding: 20, borderRight: '1px solid #334155', overflow: 'auto' }}>
          {error ? (
            <div
              style={{
                marginBottom: 12,
                padding: '10px 12px',
                background: '#450a0a',
                border: '1px solid #991b1b',
                borderRadius: 8,
                color: '#fecaca',
                fontSize: 14,
              }}
            >
              {error}
            </div>
          ) : null}
          {busy ? (
            <div style={{ marginBottom: 12, color: '#93c5fd', fontSize: 14 }}>
              {busy}
            </div>
          ) : null}

          <h2 style={{ fontSize: '1rem', margin: '0 0 10px' }}>Starting point</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input
              value={homeInput}
              onChange={(e) => setHomeInput(e.target.value)}
              placeholder="Street, city, state"
              style={{
                flex: '1 1 180px',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #475569',
                background: '#1e293b',
              }}
            />
            <button
              type="button"
              onClick={onGeocodeHome}
              style={btn()}
            >
              Use this address
            </button>
            <button type="button" onClick={onUseMyLocation} style={btn()}>
              Use where I am now
            </button>
          </div>
          {home ? (
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#94a3b8' }}>
              {home.label || `${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}`}
            </p>
          ) : (
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b' }}>
              Add a starting point to see what’s nearby and build a driving order.
            </p>
          )}

          <h2 style={{ fontSize: '1rem', margin: '20px 0 10px' }}>Photos</h2>
          <label
            style={{
              display: 'inline-block',
              padding: '12px 16px',
              background: '#1d4ed8',
              borderRadius: 8,
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            Choose photos
            <input type="file" accept="image/*" multiple onChange={onUpload} style={{ display: 'none' }} />
          </label>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: '8px 0 0', lineHeight: 1.45 }}>
            You can select several photos at once. The newest sales always appear at the top of your list.
          </p>

          <h2 style={{ fontSize: '1rem', margin: '24px 0 10px' }}>What you’re looking for</h2>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 8px', lineHeight: 1.45 }}>
            Type words to hunt for, separated by commas (e.g. <em>Lego, Nintendo, tools</em>). Sales that mention them rank
            higher on the map and in your trip order.
          </p>
          {interests.map((row, idx) => (
            <div key={row.id} style={{ marginBottom: 8, display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={row.label}
                  onChange={(e) => {
                    const next = [...interests]
                    next[idx] = { ...row, label: e.target.value }
                    onInterestsChange(next)
                  }}
                  placeholder="Group name (e.g. Video games)"
                  style={inp()}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = interests.filter((_, i) => i !== idx)
                    onInterestsChange(next.length ? next : defaultInterests())
                  }}
                  style={btnGhost()}
                >
                  Remove
                </button>
              </div>
              <textarea
                value={row.keywords}
                onChange={(e) => {
                  const next = [...interests]
                  next[idx] = { ...row, keywords: e.target.value }
                  onInterestsChange(next)
                }}
                placeholder="words to find, separated by commas"
                rows={2}
                style={{ ...inp(), resize: 'vertical' }}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onInterestsChange([
                ...interests,
                { id: newId(), label: 'New', keywords: '' },
              ])
            }
            style={btnGhost()}
          >
            Add another group
          </button>

          <details className="ysm-details">
            <summary>Save or restore everything</summary>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.45 }}>
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

          <h2 style={{ fontSize: '1rem', margin: '24px 0 10px' }}>Trip planner</h2>
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
          <button type="button" onClick={runPlan} style={{ ...btn(), marginTop: 12, width: '100%' }}>
            Plan my driving order
          </button>
          {routeResult?.message ? (
            <p style={{ fontSize: 13, color: '#fcd34d', marginTop: 8 }}>{routeResult.message}</p>
          ) : null}
          {routeResult?.ordered?.length ? (
            <>
              <ol style={{ paddingLeft: 20, fontSize: 14, color: '#e2e8f0' }}>
                {routeResult.ordered.map((s, i) => (
                  <li key={s.id} style={{ marginBottom: 8 }}>
                    <strong>{i + 1}.</strong> {s.title}{' '}
                    <span style={{ color: '#94a3b8' }}>
                      — about {minutesToLabel(s.plannedArrivalMinutes)} (~{Math.round(s.travelFromPreviousMinutes)} min
                      drive)
                    </span>
                  </li>
                ))}
              </ol>
              {home ? (
                <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
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
                  <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                    Tip: Google Maps usually follows this order best. Apple Maps sometimes changes multi-stop trips.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        <section style={{ padding: 20, overflow: 'auto', background: '#0b1220' }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 14,
                color: '#e2e8f0',
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
              Only sales that match my keywords
            </label>
            <button
              type="button"
              onClick={bulkGeocodeMissing}
              style={btnGhost()}
              disabled={!!busy || !!busySaleId}
            >
              Put all on map
            </button>
          </div>

          <SaleMap
            home={home}
            sales={displayedSales}
            routeLegs={routeResult?.legs}
            radiusMiles={home ? settings.searchRadiusMiles : 0}
          />

          <h2 style={{ fontSize: '1rem', margin: '20px 0 10px' }}>
            Your sales ({displayedSales.length}
            {settings.showPriorityOnly && sales.length !== displayedSales.length
              ? ` of ${sales.length}`
              : ''}
            )
          </h2>
          <p style={{ fontSize: 13, color: '#64748b', margin: '-4px 0 12px', lineHeight: 1.45 }}>
            Tap a row to open details, map links, and hours.
          </p>
          {sales.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 14 }}>No sales yet. Add some photos to get started.</p>
          ) : displayedSales.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 14 }}>
              Nothing matches your keywords. Turn off “Only sales that match my keywords” or add different words.
            </p>
          ) : (
            displayedSales.map((s, idx) => {
              const metaBits = []
              if (s.displayName) metaBits.push('On map')
              if (home && s.lat != null) {
                metaBits.push(`~${kmToMiles(haversineKm(home.lat, home.lon, s.lat, s.lon)).toFixed(1)} mi`)
              }
              const metaLine = [
                matchSummaryLine(s.priorityScore, s.interestMatches),
                s.interestMatches?.length ? s.interestMatches.map((m) => m.keyword).join(', ') : null,
                metaBits.length ? metaBits.join(' · ') : null,
              ]
                .filter(Boolean)
                .join(' · ')

              return (
                <details
                  key={s.id}
                  className={`ysm-sale-card${withinRadius[idx] || !home ? '' : ' ysm-sale-out'}`}
                  style={{
                    opacity: withinRadius[idx] || !home ? 1 : 0.72,
                  }}
                  open={saleCardOpen[s.id] === true}
                  onToggle={(e) => {
                    setSaleCardOpen((prev) => ({ ...prev, [s.id]: e.currentTarget.open }))
                  }}
                >
                  <summary>
                    <div style={{ flex: 1, minWidth: 0, paddingRight: 4 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 15,
                          lineHeight: 1.3,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                      >
                        {s.title}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: '#94a3b8',
                          marginTop: 4,
                          lineHeight: 1.35,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {metaLine}
                      </div>
                      {s.lat != null && s.lon != null ? (
                        <div
                          style={{
                            fontSize: 13,
                            color: '#86efac',
                            fontWeight: 600,
                            marginTop: 8,
                            letterSpacing: 0.02,
                          }}
                        >
                          Added to map
                        </div>
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
                        className={`ysm-summary-map-btn${geocodingSaleId === s.id ? ' ysm-summary-map-btn--working' : ''}`}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          geocodeSale(s.id)
                        }}
                        disabled={
                          !s.addressQuery?.trim() ||
                          !!busySaleId ||
                          geocodingSaleId === s.id ||
                          (!!busy && geocodingSaleId !== s.id)
                        }
                      >
                        {geocodingSaleId === s.id ? 'Working…' : 'Put on map'}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          ;(async () => {
                            await deleteSaleImage(s.id)
                            persist({ sales: removeSale(loadState().sales, s.id) })
                            setRouteResult(null)
                            setSaleCardOpen((prev) => {
                              const next = { ...prev }
                              delete next[s.id]
                              return next
                            })
                          })()
                        }}
                        style={{ ...btnGhost(), flexShrink: 0 }}
                      >
                        Delete
                      </button>
                    </div>
                  </summary>
                  <div className="ysm-sale-body">
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
                        Put on map
                      </button>
                      <button
                        type="button"
                        onClick={() => reparseSale(s.id)}
                        disabled={busySaleId === s.id}
                        style={btnGhost()}
                        title="Read this photo again for better text"
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
                          style={{ color: '#93c5fd', fontWeight: 500 }}
                        >
                          Google Maps
                        </a>
                        <a
                          href={buildAppleMapsPlaceUrl(s.lat, s.lon, s.title)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#93c5fd', fontWeight: 500 }}
                        >
                          Apple Maps
                        </a>
                      </div>
                    ) : null}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
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
                      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 8px', lineHeight: 1.45 }}>
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
                </details>
              )
            })
          )}
        </section>
      </main>
    </div>
  )
}

function btn() {
  return {
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #334155',
    background: '#334155',
    fontWeight: 600,
  }
}

function btnGhost() {
  return {
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid #475569',
    background: 'transparent',
    fontSize: 13,
  }
}

function inp() {
  return {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid #475569',
    background: '#1e293b',
    marginTop: 4,
  }
}

function labelSmall() {
  return { display: 'block', fontSize: 12, color: '#94a3b8' }
}
