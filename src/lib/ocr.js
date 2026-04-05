import { createWorker, PSM } from 'tesseract.js'

function mergeOcrTexts(parts) {
  const seen = new Set()
  const lines = []
  for (const p of parts) {
    for (const line of String(p || '').split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(t)
    }
  }
  return lines.join('\n')
}

async function recognizeWithPsm(image, psm, onLogger) {
  const worker = await createWorker('eng', 1, onLogger ? { logger: (m) => onLogger(m) } : {})
  try {
    await worker.setParameters({ tessedit_pageseg_mode: psm })
    const { data } = await worker.recognize(image)
    return String(data.text || '').trim()
  } finally {
    await worker.terminate()
  }
}

/**
 * @param {Blob|File} image
 * @param {(m: { status?: string; progress?: number }) => void} [onLogger]  Tesseract loading + recognition progress
 */
export async function runOcrOnFile(image, onLogger) {
  const [a, b] = await Promise.all([
    recognizeWithPsm(image, PSM.SINGLE_BLOCK, onLogger),
    recognizeWithPsm(image, PSM.SPARSE_TEXT),
  ])
  return mergeOcrTexts([a, b])
}

/** Pick a line that looks like a street address (very rough). */
export function guessAddressLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const streetish = /\b(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|blvd|way|court|ct\.?|circle|hwy|route|#\d+)\b/i
  const hasNumber = /\d{3,}/
  const scored = lines.map((line) => {
    let s = 0
    if (hasNumber.test(line)) s += 2
    if (streetish.test(line)) s += 3
    if (/\b[A-Za-z]+\s*,\s*[A-Z]{2}\b/.test(line)) s += 2
    return { line, s }
  })
  scored.sort((a, b) => b.s - a.s)
  return scored[0]?.line || lines[0] || ''
}
