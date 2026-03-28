# Click-by-click: put Yard Sale Map on the internet (use on your phone anywhere)

Do these **once**. After that, your app has a real **`https://` link** you can open on cellular Wi‑Fi or LTE.

---

## Part 1 — Create an empty repository on GitHub

1. Open your browser and go to **https://github.com**
2. Sign in (or create a free account if needed).
3. Click the **+** icon in the **top-right** corner.
4. Click **New repository**.
5. Under **Repository name**, type: `yard-sale-map` (or any name you like).
6. Select **Public** (or **Private** if you prefer).
7. **Do not** check “Add a README”, “Add .gitignore”, or “Choose a license” — leave the repo **empty**.
8. Click the green **Create repository** button.
9. Leave this browser tab open — you will copy the repo URL in Part 2.

---

## Part 2 — Push this folder from your PC to GitHub

1. On your PC, open **PowerShell** or **Command Prompt**.
2. Run these lines **one at a time** (press Enter after each).  
   Replace `YOUR_USER` with your GitHub username and `yard-sale-map` with your repo name if you chose a different one.

```powershell
cd C:\Users\areil\Desktop\yard-sale-map
git remote add origin https://github.com/YOUR_USER/yard-sale-map.git
git push -u origin main
```

3. If Windows asks for **GitHub login**, use a **Personal Access Token** as the password (GitHub → Settings → Developer settings → Personal access tokens), or sign in with the GitHub browser flow if prompted.
4. When the push finishes, refresh your repo page on GitHub — you should see all the project files.

---

## Part 3 — Deploy on Vercel (connects to GitHub)

1. Open **https://vercel.com** and sign in (use **Continue with GitHub** if you can).
2. Click **Add New…** → **Project** (or **Import Project** on the dashboard).
3. Under **Import Git Repository**, find **`yard-sale-map`** and click **Import**.  
   If you don’t see it, click **Adjust GitHub App Permissions** and allow access to the repo, then try again.
4. **Framework Preset** should show **Vite** — leave it.
5. **Root Directory** — leave blank (or `.` if Vercel shows it).
6. **Build Command** — should be `npm run build` (default).
7. **Output Directory** — should be `dist` (default for Vite).
8. Click **Environment Variables** (expand if collapsed).
9. Add:
   - **Name:** `OPENAI_API_KEY`  
   - **Value:** your OpenAI API key (from platform.openai.com) — **optional**; skip if you only want OCR.
10. Select **Production**, **Preview**, and **Development** for that variable (or at least **Production**).
11. Click **Deploy**.
12. Wait until the build finishes (green check). Click **Visit** or copy the URL that looks like **`https://yard-sale-map-xxxxx.vercel.app`**.

That URL is your app — **save it** or bookmark it on your phone.

---

## Part 4 — (Optional) Turn on automatic deploys on every push

1. In Vercel, open your **project** → **Settings** → **Git**.
2. Confirm the **Production Branch** is **`main`**.
3. Any future `git push` to `main` will create a new deployment automatically.

---

## Part 5 — Use it on your phone (on the move)

1. On your phone, open **Safari** (iPhone) or **Chrome** (Android).
2. Paste or type your **`https://….vercel.app`** address and open it.
3. **Allow location** if the browser asks (for “use my location” as home).
4. **Add to Home Screen** (recommended):
   - **iPhone (Safari):** tap **Share** → **Add to Home Screen** → **Add**.
   - **Android (Chrome):** tap **⋮** → **Add to Home screen** or **Install app**.

You can now open the app like any other app. Maps and uploads need **internet**; the installed shortcut still opens the live site.

---

## If something fails

- **Push rejected:** run `git push -u origin main` again after fixing GitHub auth.
- **Vercel build failed:** open the failed deployment → **Building** logs; often a missing dependency — run `npm run build` locally in `yard-sale-map` and fix errors.
- **Geocode or AI errors on the live site:** in Vercel → **Project** → **Settings** → **Environment Variables**, confirm `OPENAI_API_KEY` is set for Production, then **Redeploy** the latest deployment.

---

## What was already done in this project (no clicks needed)

- Production **build** (`npm run build`), **PWA** (install on home screen), **API routes** for geocode and AI on Vercel, **Git** initialized with a **`main`** branch and an **initial commit**.

You only need Parts **1–3** and **5** to go live and use it on your phone away from home.
