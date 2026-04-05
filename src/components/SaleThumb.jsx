import { useEffect, useState } from 'react'
import { getSaleImageBlob } from '../lib/imageStore.js'

export default function SaleThumb({ saleId }) {
  const [url, setUrl] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let created
    let cancelled = false
    ;(async () => {
      const blob = await getSaleImageBlob(saleId)
      if (cancelled || !blob) return
      created = URL.createObjectURL(blob)
      setUrl(created)
    })()
    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [saleId])

  const dialogId = `ysm-img-${String(saleId || '').slice(0, 16)}`

  if (!url) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: 'block',
          width: '100%',
          padding: 0,
          marginTop: 8,
          background: 'transparent',
          border: 0,
          textAlign: 'left',
          cursor: 'zoom-in',
        }}
        aria-label="Open photo full screen"
      >
        <img
          src={url}
          alt="Sale photo"
          style={{
            width: '100%',
            maxHeight: 420,
            objectFit: 'contain',
            background: '#0b1220',
            borderRadius: 10,
            border: '1px solid #334155',
          }}
        />
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
          Tap to zoom
        </div>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Full-screen sale photo"
          id={dialogId}
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 20000,
            background: 'rgba(2,6,23,0.92)',
            display: 'flex',
            flexDirection: 'column',
            padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
              }}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid #334155',
                background: 'rgba(15,23,42,0.9)',
                fontWeight: 700,
              }}
            >
              Close
            </button>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src={url}
              alt="Sale photo"
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                borderRadius: 12,
                border: '1px solid #334155',
                background: '#0b1220',
              }}
            />
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>
            Tap outside the image to close
          </div>
        </div>
      ) : null}
    </>
  )
}
