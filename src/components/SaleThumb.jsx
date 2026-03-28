import { useEffect, useState } from 'react'
import { getSaleImageBlob } from '../lib/imageStore.js'

export default function SaleThumb({ saleId }) {
  const [url, setUrl] = useState(null)

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

  if (!url) return null

  return (
    <img
      src={url}
      alt=""
      style={{
        width: '100%',
        maxHeight: 200,
        objectFit: 'cover',
        borderRadius: 8,
        marginTop: 8,
        border: '1px solid #334155',
      }}
    />
  )
}
