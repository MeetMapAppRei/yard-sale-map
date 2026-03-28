/**
 * Calls server-side vision parse when deployed (Vercel /api). No API key in the client.
 */
export async function parseScreenshotWithAi(imageBase64, mimeType) {
  const res = await fetch('/api/parse-screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mimeType: mimeType || 'image/jpeg' }),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(text.slice(0, 200) || `Parse failed (${res.status})`)
  }
  if (!res.ok) {
    throw new Error(data.error || `Parse failed (${res.status})`)
  }
  return data
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function blobToBase64(blob) {
  return fileToBase64(blob)
}
