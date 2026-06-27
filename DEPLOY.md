# FutureShield Admin Dashboard — Deployment Guide

This project is a **single-file static web application**.  
No Node.js, no build step, no server required.

---

## Files in This Folder

| File | Purpose |
|---|---|
| `index.html` | **The application** — deploy this file |
| `vercel.json` | Vercel deployment config + security headers |
| `netlify.toml` | Netlify deployment config + security headers |
| `_headers` | Cloudflare Pages / Netlify `_headers` file |
| `robots.txt` | Blocks all search engine indexing (private admin) |
| `future_shield_admin_system (77).html` | Original working copy — keep as backup |

---

## Step 1 — Firebase Firestore Security Rules (CRITICAL)

Your Firebase project is currently likely using **open test rules**.  
Before going live, go to **Firebase Console → Firestore → Rules** and set:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── Admin-only collections ──────────────────────────────────
    match /admin_users/{doc} {
      allow read, write: if false;   // only writable via Admin SDK / seeding script
    }

    match /api_configurations/{doc} {
      allow read, write: if false;   // sensitive — never expose client-side
    }

    // ── Authenticated users only (simulated via session check) ──
    // Since this app uses sessionStorage (no Firebase Auth), keep rules
    // permissive here but tighten once you add Firebase Authentication.
    match /{collection}/{doc} {
      allow read, write: if true;    // TODO: Replace with Firebase Auth check
    }
  }
}
```

> **Recommended next step:** Integrate Firebase Authentication (email/password)
> so Firestore rules can use `request.auth != null` instead of `true`.

---

## Step 2 — Deploy to Vercel

1. Install the Vercel CLI (one-time):
   ```
   npm install -g vercel
   ```
2. From this folder, run:
   ```
   vercel
   ```
3. Follow the prompts. Select **"No framework"** when asked.
4. Vercel will deploy `index.html` and apply the rules from `vercel.json`.

**Or via Vercel Dashboard:**
- Go to [vercel.com](https://vercel.com) → New Project → Upload folder
- Drag this entire folder and click Deploy

---

## Step 3 — Deploy to Netlify

**Via Netlify CLI:**
```
npm install -g netlify-cli
netlify deploy --prod --dir .
```

**Via Netlify Dashboard (drag-and-drop):**
1. Go to [app.netlify.com](https://app.netlify.com)
2. Drag this entire folder onto the drop zone
3. Done — `netlify.toml` is picked up automatically

---

## Step 4 — Deploy to Cloudflare Pages

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Pages → Create a Project
2. Connect your GitHub repo **or** use "Direct Upload"
3. Set **Build output directory** to `.` (root)
4. `_headers` file is automatically respected by Cloudflare Pages

---

## Production Checklist

- [x] No `localhost` or `127.0.0.1` paths in the code  
- [x] All CDN scripts use pinned versions (Chart.js 4.4.3, jsPDF 2.5.1, xlsx 0.18.5)
- [x] Debug `console.log` statements removed
- [x] `robots.txt` blocks search engine indexing
- [x] Security headers set (X-Frame-Options, CSP, etc.)
- [x] `index.html` is the entry point (required by all static hosts)
- [ ] **Firebase Firestore rules tightened** (see Step 1 above)
- [ ] **Custom domain configured** in host dashboard (optional)
- [ ] **HTTPS enforced** (automatic on Vercel/Netlify/Cloudflare)

---

## About the CDN Libraries

| Library | Version | Purpose | Production-safe? |
|---|---|---|---|
| Tailwind CSS Play CDN | latest | Utility CSS — JIT at runtime | ✅ Works, slightly slower than build |
| Chart.js | 4.4.3 | Pie/doughnut charts | ✅ Pinned |
| jsPDF | 2.5.1 | PDF export | ✅ Pinned |
| jsPDF-AutoTable | 3.8.2 | PDF table plugin | ✅ Pinned |
| SheetJS (xlsx) | 0.18.5 | Excel export | ✅ Pinned |
| Google Fonts (Inter) | — | Typography | ✅ CDN |
| Firebase SDK | 10.x | Firestore + App | ✅ ESM CDN |

---

## Notes on Firebase API Keys

The Firebase `apiKey`, `projectId`, etc. in `index.html` are **safe to expose**
in client-side code. Firebase API keys are **not secret** — they identify your
project, but access is controlled entirely by **Firestore Security Rules**
(see Step 1). This is Firebase's documented and expected architecture.

Reference: https://firebase.google.com/docs/projects/api-keys

---

## Mobile APK Distribution

### File location
| Path | Purpose |
|---|---|
| `public/downloads/future-shield.apk` | Stored APK file |
| `/downloads/future-shield.apk` | Public download URL (used by profile menu) |

### Upload via Admin Dashboard
1. Run the APK server: `npm run start:apk` (port 3002)
2. Open **App Management** in the dashboard
3. Server URL: `http://localhost:3002`, Token: `futureshield-apk-secret`
4. Upload a `.apk` file — saved automatically as `future-shield.apk`

### Automated build (Capacitor)
```bash
npm run setup:mobile   # first time only (requires JDK 17 + Android SDK)
npm run build:apk      # builds and copies APK to public/downloads/
```

### Deploying the APK to Vercel/Netlify
After building or uploading locally, **commit** `public/downloads/future-shield.apk` and redeploy.
The host serves it at `/downloads/future-shield.apk` (configured in `vercel.json` / `netlify.toml`).

> **Note:** The upload API writes to disk and only works when running `npm run start:apk` locally or on a VPS — not on serverless hosts like Vercel.
