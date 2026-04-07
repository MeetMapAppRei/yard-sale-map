/**
 * Android Chrome can revoke access to "picked" file handles quickly, especially in multi-select.
 * Copy bytes into a new File as fast as possible. Callers should read many files in parallel
 * (Promise.all), not one-by-one, so every pick is copied before handles expire.
 */
export async function stabilizeFile(file) {
  if (!file || typeof file !== 'object') return file
  const name = file.name || 'image'
  const type = file.type || 'application/octet-stream'
  let lastErr = null

  try {
    if (typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer()
      return new File([buf], name, { type, lastModified: Date.now() })
    }
  } catch (e) {
    lastErr = e
  }

  try {
    const buf = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onerror = () => reject(r.error || new Error('read-failed'))
      r.onload = () => resolve(r.result)
      r.readAsArrayBuffer(file)
    })
    if (buf instanceof ArrayBuffer) {
      return new File([buf], name, { type, lastModified: Date.now() })
    }
  } catch (e) {
    lastErr = e
  }

  const msg = String(lastErr?.message || lastErr || 'Could not read file')
  const err = new Error(
    msg.includes('could not be read') || msg.includes('permission')
      ? `${msg} If this keeps happening, pick fewer photos at once, or save images to Downloads/Files first (not cloud-only).`
      : msg,
  )
  err.cause = lastErr
  throw err
}
