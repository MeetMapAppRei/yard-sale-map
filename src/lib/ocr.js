import Tesseract from 'tesseract.js'

export async function runOcrOnFile(file, onProgress) {
  const { data } = await Tesseract.recognize(file, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(Math.round(m.progress * 100))
      }
    },
  })
  return String(data.text || '').trim()
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
