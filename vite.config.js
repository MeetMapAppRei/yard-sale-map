// Production: set VITE_SITE_URL to your site origin (no trailing slash) so index.html gets canonical + og:url.
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const siteUrl = String(env.VITE_SITE_URL || '')
    .trim()
    .replace(/\/$/, '')

  return {
    plugins: [
      react(),
      {
        name: 'inject-site-url',
        transformIndexHtml(html) {
          if (!siteUrl) return html
          const safe = siteUrl.replace(/"/g, '&quot;')
          const inject = `    <link rel="canonical" href="${safe}/" />\n    <meta property="og:url" content="${safe}/" />\n    <meta property="og:image" content="${safe}/og.png" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta name="twitter:image" content="${safe}/og.png" />\n`
          return html.replace('<meta property="og:locale"', `${inject}<meta property="og:locale"`)
        },
      },
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'og.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Yard Sale Route Planner',
          short_name: 'YSR Planner',
          description:
            'We plan a route for what you want to find—flyers to pins, keywords, trip day, share your list. Free in the browser.',
          theme_color: '#111827',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'portrait-primary',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: 'icon.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,ico,woff2,png,webp}'],
          navigateFallbackDenylist: [/^\/api\/.*/],
          cleanupOutdatedCaches: true,
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
  }
})
