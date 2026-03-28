import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Yard Sale Route Planner',
        short_name: 'YSR Planner',
        description:
          'Plan your yard and garage sale day: photos to map pins, interests, and a sensible driving order.',
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
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
