// If an old service worker is controlling this page, this script will remove it.
// This is a one-time escape hatch for stale PWA caches after deploys.
;(async () => {
  if (!('serviceWorker' in navigator)) return
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map((r) => r.unregister()))
  } catch (e) {
    // ignore
  }
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch (e) {
    // ignore
  }
})()

