import { getSaleImageBlob, putSaleImage, deleteSaleImage, listImageIds } from './imageStore.js'

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

function base64ToBlob(base64, mime = 'image/jpeg') {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function buildExportPayload(state) {
  const images = {}
  for (const sale of state.sales || []) {
    const blob = await getSaleImageBlob(sale.id)
    if (blob) {
      images[sale.id] = {
        mime: blob.type || 'image/jpeg',
        base64: await blobToBase64(blob),
      }
    }
  }
  return {
    version: 1,
    exportedAt: Date.now(),
    state: {
      home: state.home,
      sales: state.sales,
      interests: state.interests,
      settings: state.settings,
    },
    images,
  }
}

export async function downloadJsonBackup(state) {
  const payload = await buildExportPayload(state)
  const blob = new Blob([JSON.stringify(payload, null, 0)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
    a.download = `yard-sale-route-planner-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

export async function importBackupJson(text) {
  const data = JSON.parse(text)
  if (!data || data.version !== 1 || !data.state) {
    throw new Error('Invalid backup file')
  }
  const { state, images = {} } = data
  for (const sale of state.sales || []) {
    const img = images[sale.id]
    if (img?.base64) {
      await putSaleImage(sale.id, base64ToBlob(img.base64, img.mime || 'image/jpeg'))
    }
  }
  const keep = new Set((state.sales || []).map((s) => s.id))
  const existing = await listImageIds()
  for (const id of existing) {
    if (!keep.has(id)) await deleteSaleImage(id)
  }
  return state
}
