/** @param {{ keywords: string }[]} interests */
export function scoreTextAgainstInterests(text, interests) {
  const t = (text || '').toLowerCase()
  const matches = []
  let score = 0
  for (const row of interests) {
    const parts = String(row.keywords || '')
      .split(/[,;\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    for (const kw of parts) {
      if (kw.length >= 2 && t.includes(kw)) {
        matches.push({ label: row.label, keyword: kw })
        score += 1 + Math.min(2, kw.length / 20)
      }
    }
  }
  return { score, matches }
}
