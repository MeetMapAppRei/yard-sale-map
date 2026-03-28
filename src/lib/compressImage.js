/**
 * Resize (max width) and JPEG-encode to keep IndexedDB small. Falls back to the original file if decoding fails (e.g. some HEIC).
 */
export async function compressImageFile(
  file,
  { maxWidth = 1600, quality = 0.82, mime = 'image/jpeg' } = {},
) {
  try {
    const bitmap = await createImageBitmap(file)
    try {
      const w = bitmap.width
      const h = bitmap.height
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
      if (!ctx) return file
      ctx.drawImage(bitmap, 0, 0, tw, th)
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, quality)
      })
      return blob
    } finally {
      bitmap.close?.()
    }
  } catch {
    return file
  }
}
