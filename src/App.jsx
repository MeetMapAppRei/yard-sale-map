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
  const [error, setError] = useState(null)

  useEffect(() => {
    const s = loadState()
    setHome(s.home)
    setSales(s.sales)
    setInterests(s.interests)
    setSettings(s.settings)
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

  const onGeocodeHome = async () => {
    setError(null)
    setBusy('Geocoding home…')
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
      setError('Geolocation not available in this browser.')
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
        setError(err.message || 'Location error')
        setBusy(null)
      },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  const onUpload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !file.type.startsWith('image/')) return
    setError(null)
    const saleId = newId()

    setBusy('Compressing image…')
    let toStore
    try {
      toStore = await compressImageFile(file)
    } catch {
      toStore = file
    }
    setBusy('Saving image…')
    try {
      await putSaleImage(saleId, toStore)
    } catch (err) {
      setError(err.message || String(err))
      setBusy(null)
      return
    }

    setBusy('Reading screenshot (OCR)…')
    let rawText = ''
    try {
      rawText = await runOcrOnFile(file, () => {})
    } catch (err) {
      await deleteSaleImage(saleId)
      setError(err.message || String(err))
      setBusy(null)
      return
    }

    let ai = null
    setBusy('Optional: AI parse…')
    try {
      const b64 = await fileToBase64(file)
      ai = await parseScreenshotWithAi(b64, file.type)
    } catch {
      /* /api only on Vercel or vercel dev; OCR-only is fine */
    } finally {
      setBusy(null)
    }

    const merged = mergeOcrAndAi(ai, rawText)
    const st = loadState()
    const { score, matches } = scoreTextAgainstInterests(merged.rawText, st.interests)
    const sale = {
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
      createdAt: Date.now(),
      hasImage: true,
    }
    persist({ sales: upsertSale(st.sales, sale) })
    setRouteResult(null)
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
    setBusy('Geocoding sale…')
    try {
      const g = await geocodeAddress(s.addressQuery)
      updateSaleField(id, {
        lat: g.lat,
        lon: g.lon,
        displayName: g.displayName,
      })
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const reparseSale = async (id) => {
    setError(null)
    const blob = await getSaleImageBlob(id)
    if (!blob) {
      setError('No screenshot stored for this listing (upload again or restore from backup with images).')
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
        setError(`AI parse unavailable (${aiError}). OCR text was still refreshed.`)
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

  const displayedSales = useMemo(() => {
    if (!settings.showPriorityOnly) return sales
    return sales.filter((s) => (Number(s.priorityScore) || 0) > 0)
  }, [sales, settings.showPriorityOnly])

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
    setBusy(`Geocoding ${missing.length} listing(s)…`)
    const nextSales = [...state.sales]
    let failed = 0
    for (const sale of missing) {
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
      } catch {
        failed += 1
      }
    }
    persist({ sales: nextSales })
    setRouteResult(null)
    setBusy(null)
    if (failed) {
      setError(`${failed} listing(s) could not be geocoded. Check those addresses.`)
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

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid #334155',
          background: '#020617',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 700 }}>Yard Sale Map</h1>
        <p style={{ margin: '8px 0 0', color: '#94a3b8', fontSize: 14, maxWidth: 720 }}>
          Personal tool: upload screenshots, OCR extracts text, you confirm the address, then map pins and a suggested
          route use open times, distance, and your interest keywords.
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

          <h2 style={{ fontSize: '1rem', margin: '0 0 10px' }}>Home</h2>
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
              Set from address
            </button>
            <button type="button" onClick={onUseMyLocation} style={btn()}>
              Use my location
            </button>
          </div>
          {home ? (
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#94a3b8' }}>
              {home.label || `${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}`}
            </p>
          ) : (
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b' }}>Set home to filter by radius and plan routes.</p>
          )}

          <h2 style={{ fontSize: '1rem', margin: '20px 0 10px' }}>Screenshots</h2>
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
            Upload image
            <input type="file" accept="image/*" onChange={onUpload} style={{ display: 'none' }} />
          </label>
          <p style={{ fontSize: 12, color: '#64748b', margin: '8px 0 0' }}>
            OCR runs on your original file for accuracy; stored copies are resized JPEGs in IndexedDB to save space. Listing
            fields live in localStorage.
            After you deploy to Vercel and set <code style={{ color: '#cbd5e1' }}>OPENAI_API_KEY</code>, uploads also call
            the server <code style={{ color: '#cbd5e1' }}>/api/parse-screenshot</code> for richer address and times (optional;
            plain <code style={{ color: '#cbd5e1' }}>npm run dev</code> stays OCR-only).
          </p>

          <h2 style={{ fontSize: '1rem', margin: '24px 0 10px' }}>Interests (priority)</h2>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 8px' }}>
            Comma-separated keywords per category. Matching text raises priority on the map and in routing.
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
                  placeholder="Label"
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
                placeholder="keywords, like, this"
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
            Add interest group
          </button>

          <h2 style={{ fontSize: '1rem', margin: '24px 0 10px' }}>Backup</h2>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 8px' }}>
            Export JSON includes listings, home, interests, settings, and screenshot blobs. Import replaces the current data
            and reloads the page.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
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
              Export backup
            </button>
            <label style={{ ...btn(), display: 'inline-block' }}>
              Import backup
              <input
                type="file"
                accept="application/json,.json"
                onChange={async (ev) => {
                  const file = ev.target.files?.[0]
                  ev.target.value = ''
                  if (!file) return
                  setError(null)
                  setBusy('Restoring backup…')
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

          <h2 style={{ fontSize: '1rem', margin: '24px 0 10px' }}>Routing settings</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={labelSmall()}>
              Avg speed (km/h)
              <input
                type="number"
                min={5}
                value={settings.avgKmh}
                onChange={(e) => persist({ settings: { ...settings, avgKmh: Number(e.target.value) || 40 } })}
                style={inp()}
              />
            </label>
            <label style={labelSmall()}>
              Dwell (min per stop)
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
              Search radius (miles from home)
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
          <label style={{ ...labelSmall(), marginTop: 12 }}>
            Leave home at
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              style={inp()}
            />
          </label>
          <button type="button" onClick={runPlan} style={{ ...btn(), marginTop: 12, width: '100%' }}>
            Build suggested route
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
                      — arrive ~{minutesToLabel(s.plannedArrivalMinutes)} ({Math.round(s.travelFromPreviousMinutes)} min
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
                  <p style={{ margin: 0, fontSize: 11, color: '#64748b' }}>
                    Apple may reorder or simplify some stops on certain devices; Google usually matches the list order best.
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
              Priority matches only
            </label>
            <button
              type="button"
              onClick={bulkGeocodeMissing}
              style={btnGhost()}
              disabled={!!busy || !!busySaleId}
            >
              Geocode all missing
            </button>
          </div>

          <SaleMap
            home={home}
            sales={displayedSales}
            routeLegs={routeResult?.legs}
            radiusMiles={home ? settings.searchRadiusMiles : 0}
          />

          <h2 style={{ fontSize: '1rem', margin: '20px 0 10px' }}>
            Listings ({displayedSales.length}
            {settings.showPriorityOnly && sales.length !== displayedSales.length
              ? ` of ${sales.length}`
              : ''}
            )
          </h2>
          {sales.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 14 }}>No listings yet. Upload a screenshot to begin.</p>
          ) : displayedSales.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 14 }}>
              No listings match your interest keywords. Turn off “Priority matches only” or add keywords.
            </p>
          ) : (
            displayedSales.map((s, idx) => (
              <article
                key={s.id}
                style={{
                  marginBottom: 14,
                  padding: 12,
                  borderRadius: 10,
                  border: '1px solid #334155',
                  background: withinRadius[idx] ? '#0f172a' : '#1e293b',
                  opacity: withinRadius[idx] || !home ? 1 : 0.65,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <strong style={{ fontSize: 15 }}>{s.title}</strong>
                  <button
                    type="button"
                    onClick={async () => {
                      await deleteSaleImage(s.id)
                      persist({ sales: removeSale(loadState().sales, s.id) })
                      setRouteResult(null)
                    }}
                    style={btnGhost()}
                  >
                    Delete
                  </button>
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
                  Priority {s.priorityScore?.toFixed(2) ?? '0'}
                  {s.interestMatches?.length
                    ? ` · matches: ${s.interestMatches.map((m) => m.keyword).join(', ')}`
                    : ''}
                  {home && s.lat != null
                    ? ` · ${haversineKm(home.lat, home.lon, s.lat, s.lon).toFixed(1)} km from home`
                    : ''}
                </div>
                <SaleThumb saleId={s.id} />
                <label style={{ ...labelSmall(), marginTop: 8 }}>
                  Address search (edit, then geocode)
                  <input
                    value={s.addressQuery}
                    onChange={(e) => updateSaleField(s.id, { addressQuery: e.target.value })}
                    style={inp()}
                  />
                </label>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button type="button" onClick={() => geocodeSale(s.id)} disabled={busySaleId === s.id} style={btn()}>
                    Geocode
                  </button>
                  <button
                    type="button"
                    onClick={() => reparseSale(s.id)}
                    disabled={busySaleId === s.id}
                    style={btnGhost()}
                    title="Re-run Tesseract OCR and optional /api vision parse on the saved screenshot"
                  >
                    {busySaleId === s.id ? 'Re-parsing…' : 'Re-run AI & OCR'}
                  </button>
                  {s.displayName ? (
                    <span style={{ fontSize: 12, color: '#86efac', alignSelf: 'center' }}>Located</span>
                  ) : null}
                </div>
                {s.lat != null && s.lon != null ? (
                  <div
                    style={{
                      fontSize: 12,
                      marginTop: 8,
                      display: 'flex',
                      gap: 14,
                      flexWrap: 'wrap',
                    }}
                  >
                    <a
                      href={buildGoogleMapsPlaceUrl(s.lat, s.lon, s.title)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#93c5fd' }}
                    >
                      Open in Google Maps
                    </a>
                    <a
                      href={buildAppleMapsPlaceUrl(s.lat, s.lon, s.title)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#93c5fd' }}
                    >
                      Open in Apple Maps
                    </a>
                  </div>
                ) : null}
                <label style={{ ...labelSmall(), marginTop: 8 }}>
                  Raw text (OCR)
                  <textarea
                    value={s.rawText}
                    onChange={(e) => updateSaleField(s.id, { rawText: e.target.value, interestsRefresh: true })}
                    rows={4}
                    style={{ ...inp(), resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                  />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
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
              </article>
            ))
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
