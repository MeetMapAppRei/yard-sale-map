import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useEffect } from 'react'
import 'leaflet/dist/leaflet.css'

import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'

const DefaultIcon = L.icon({
  iconRetinaUrl,
  iconUrl,
  shadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})
L.Marker.prototype.options.icon = DefaultIcon

function priorityIcon(color) {
  return L.divIcon({
    className: 'ysm-marker',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #111;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  })
}

function FitBounds({ points, padding = [24, 24] }) {
  const map = useMap()
  useEffect(() => {
    if (!points?.length) return
    const b = L.latLngBounds(points.map((p) => [p.lat, p.lon]))
    map.fitBounds(b, { padding })
  }, [map, points])
  return null
}

export default function SaleMap({
  home,
  sales,
  routeLegs,
  radiusMiles,
  height = 'min(52vh, 420px)',
}) {
  const withCoords = (sales || []).filter((s) => s.lat != null && s.lon != null)
  const center = home
    ? [home.lat, home.lon]
    : withCoords[0]
      ? [withCoords[0].lat, withCoords[0].lon]
      : [39.8283, -98.5795]

  const line =
    routeLegs?.length > 0
      ? routeLegs.map((leg) => [leg.from.lat, leg.from.lon]).concat([[routeLegs[routeLegs.length - 1].to.lat, routeLegs[routeLegs.length - 1].to.lon]])
      : null

  const fitPoints = []
  if (home) fitPoints.push({ lat: home.lat, lon: home.lon })
  withCoords.forEach((s) => fitPoints.push({ lat: s.lat, lon: s.lon }))

  const radiusM = radiusMiles * 1609.34

  return (
    <div style={{ height, width: '100%', borderRadius: 12, overflow: 'hidden', border: '1px solid #334155' }}>
      <MapContainer center={center} zoom={11} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {fitPoints.length > 1 ? <FitBounds points={fitPoints} /> : null}
        {home ? (
          <Marker position={[home.lat, home.lon]} icon={priorityIcon('#38bdf8')}>
            <Popup>Home</Popup>
          </Marker>
        ) : null}
        {home && radiusMiles > 0 ? <Circle center={[home.lat, home.lon]} radius={radiusM} pathOptions={{ color: '#64748b', fillOpacity: 0.05 }} /> : null}
        {withCoords.map((s) => {
          const pri = Number(s.priorityScore) || 0
          const color = pri >= 3 ? '#f472b6' : pri >= 1 ? '#fbbf24' : '#94a3b8'
          return (
            <Marker key={s.id} position={[s.lat, s.lon]} icon={priorityIcon(color)}>
              <Popup>
                <div style={{ maxWidth: 220 }}>
                  <strong>{s.title || 'Sale'}</strong>
                  <div style={{ marginTop: 6, fontSize: 12 }}>
                    Priority: {pri.toFixed(1)}
                    {s.interestMatches?.length ? (
                      <div style={{ marginTop: 4 }}>
                        Matches: {s.interestMatches.map((m) => m.keyword).join(', ')}
                      </div>
                    ) : null}
                  </div>
                </div>
              </Popup>
            </Marker>
          )
        })}
        {line && line.length > 1 ? <Polyline positions={line} pathOptions={{ color: '#a78bfa', weight: 4, opacity: 0.85 }} /> : null}
      </MapContainer>
    </div>
  )
}
