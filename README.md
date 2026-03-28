# Yard Sale Route Planner

Screenshot uploads → OCR (+ optional AI) → geocode → map, interest priority, and driving routes. **Install on your phone** (PWA) and use **HTTPS** everywhere so location and APIs work on the move.

**Step-by-step (every click):** see **[DEPLOY-CLICK-BY-CLICK.md](./DEPLOY-CLICK-BY-CLICK.md)**.

## Deploy once — use anywhere (phone, LTE, coffee shop Wi‑Fi)

You need a **public HTTPS URL**. Recommended: **Vercel** (free tier is enough for personal use).

### Option A — GitHub + Vercel (simplest ongoing deploys)

1. Create a **new empty** repository on GitHub.
2. In this folder on your PC:
   ```bash
   git init
   git add .
   git commit -m "Yard Sale Route Planner"
   git branch -M main
   git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
   git push -u origin main
   ```
3. Go to [vercel.com/new](https://vercel.com/new) → **Import** that repository.
4. Leave defaults: **Framework Preset: Vite**, **Build Command** `npm run build`, **Output** `dist`.
5. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY` — your Anthropic key (optional; without it, OCR-only still works).
6. Click **Deploy**. Your app is live at `https://something.vercel.app`.

Every future `git push` to `main` can auto-deploy (enable in Vercel → Project → Settings → Git).

### Option B — Vercel CLI (no GitHub)

```bash
npm i -g vercel
cd /path/to/yard-sale-map
vercel login
vercel link
vercel env pull   # optional; set ANTHROPIC_API_KEY in Vercel dashboard
vercel --prod
```

Use the printed **Production** URL on your phone.

## Install on your phone (home screen)

1. Open your **https://…** deployment in **Safari** (iOS) or **Chrome** (Android).
2. **iOS:** Share → **Add to Home Screen**.  
3. **Android:** menu → **Install app** / **Add to Home screen**.

The app registers a **service worker** so repeat visits load faster. Maps and geocoding still need network.

## Local development

```bash
npm install
npm run dev
```

**Same Wi‑Fi as your phone (no deploy yet):**

```bash
npm run dev:phone
```

Open the **Network** URL (e.g. `http://192.168.x.x:5173`) on your phone. Geolocation may be limited without HTTPS; production is better.

**AI + `/api` routes locally:**

```bash
npx vercel dev
```

## Environment variables (Vercel)

| Name | Required | Purpose |
|------|----------|---------|
| `ANTHROPIC_API_KEY` | No | `/api/parse-screenshot` (Claude vision) |
| `ANTHROPIC_MODEL` | No | Default `claude-3-5-haiku-20241022` (e.g. `claude-3-5-sonnet-20241022`) |

Geocoding uses `/api/geocode` (Nominatim) on the server — no extra key.

## Backup

Use **Export backup** in the app; keep the JSON somewhere safe (it includes listing data and images).
