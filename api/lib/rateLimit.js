/**
 * Sliding-window rate limit per client IP (X-Forwarded-For first hop).
 * In-memory: resets on cold start; good enough to blunt casual abuse on serverless.
 * Set RATE_LIMIT_ENABLED=false to disable (e.g. local debugging).
 */

/** @type {Map<string, number[]>} */
const store = new Map()

function prune(list, windowMs, now) {
  const cutoff = now - windowMs
  let i = 0
  while (i < list.length && list[i] < cutoff) i++
  return i === 0 ? list : list.slice(i)
}

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string') {
    const first = xff.split(',')[0].trim()
    if (first) return first
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).split(',')[0].trim() || 'unknown'
  }
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()
  return 'unknown'
}

let cleanupCounter = 0
const MAX_KEYS = 8000

function maybeShrinkStore() {
  if (store.size < MAX_KEYS) return
  let n = 0
  for (const k of store.keys()) {
    store.delete(k)
    if (++n >= MAX_KEYS / 2) break
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ prefix: string, max: number, windowMs: number }} opts
 * @returns {{ ok: true } | { ok: false, retryAfterSec: number }}
 */
export function checkRateLimit(req, opts) {
  const disabled = process.env.RATE_LIMIT_ENABLED === '0' || process.env.RATE_LIMIT_ENABLED === 'false'
  if (disabled) return { ok: true }

  const { prefix, max, windowMs } = opts
  const ip = getClientIp(req)
  const key = `${prefix}:${ip}`
  const now = Date.now()
  let list = store.get(key)
  if (!list) list = []
  list = prune(list, windowMs, now)
  if (list.length >= max) {
    const oldest = list[0]
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    store.set(key, list)
    return { ok: false, retryAfterSec }
  }
  list.push(now)
  store.set(key, list)
  cleanupCounter += 1
  if (cleanupCounter % 120 === 0) maybeShrinkStore()
  return { ok: true }
}

export function parseLimitEnv(name, fallback) {
  const v = process.env[name]
  if (v == null || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
