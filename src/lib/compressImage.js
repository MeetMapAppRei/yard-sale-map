/**
 * Resize (max width) and JPEG-encode to keep IndexedDB small.
 * Falls back to the original file if decoding fails (e.g. some HEIC).
 *
 * On Android Chrome, `createImageBitmap(largeCameraPhoto)` can hang forever — we time out
 * and fall back to decoding via `<img>` + canvas, then raw file.
 */

function getDims(source) {
  if (source instanceof ImageBitmap) {
    return { w: source.width, h: source.height }
  }
  const w = source.naturalWidth || source.width
  const h = source.naturalHeight || source.height
  return { w, h }
}

function blobFromCanvas(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, quality)
  })
}

async function encodeResized(source, maxWidth, mime, quality) {
  const { w, h } = getDims(source)
  if (!w || !h) throw new Error('bad dimensions')

  let tw = w
  let th = h
  if (w > maxWidth) {
    tw = maxWidth
    th = Math.round((h * maxWidth) / w)
  }
  const canvas = document.createElement('canvas')
  canvas.width = tw
  canvas.height = th
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas context')
  ctx.drawImage(source, 0, 0, tw, th)
  return blobFromCanvas(canvas, mime, quality)
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('decode-timeout')), ms)
    }),
  ])
}

export async function compressImageFile(
  file,
  { maxWidth = 1600, quality = 0.82, mime = 'image/jpeg', decodeTimeoutMs = 15000 } = {},
) {
  async function fromBitmap() {
    const bitmap = await createImageBitmap(file)
    try {
      return await encodeResized(bitmap, maxWidth, mime, quality)
    } finally {
      bitmap.close?.()
    }
  }

  async function fromImageTag() {
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image()
        i.decoding = 'async'
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('img-onerror'))
        i.src = url
      })
      return await encodeResized(img, maxWidth, mime, quality)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  try {
    return await withTimeout(fromBitmap(), decodeTimeoutMs)
  } catch {
    try {
      return await withTimeout(fromImageTag(), decodeTimeoutMs)
    } catch {
      return file
    }
  }
}
