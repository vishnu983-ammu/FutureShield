# WhatsApp Server — HTTPS & Mixed Content Guide

Your dashboard on **HTTPS** (Vercel/Netlify) cannot call an **HTTP** WhatsApp server. Browsers block this as **mixed content**.

---

## Quick fix (local development)

Run these in your project folder:

```powershell
npm run generate:certs
npm start
```

1. Open **https://localhost:3001/wa/health** in Chrome  
2. Click **Advanced → Proceed to localhost** (trust the self-signed cert once)  
3. In the dashboard → **WhatsApp** → set Server URL to:  
   **`https://localhost:3001`**  
4. Token: **`futureshield-wa-secret`**  
5. Click **Save & Test Connection**

The server **automatically uses HTTPS** when `certs/localhost-key.pem` and `certs/localhost-cert.pem` exist.

---

## How it works

| Dashboard URL | WA server URL | Result |
|---------------|---------------|--------|
| `http://localhost:5500` | `http://localhost:3001` | Works |
| `https://yoursite.vercel.app` | `http://localhost:3001` | **Blocked (mixed content)** |
| `https://yoursite.vercel.app` | `https://localhost:3001` | Works **on your PC only** (after trusting cert) |

> **Important:** A deployed HTTPS site can only reach **your own** `localhost` if the WhatsApp server runs on the **same machine** as your browser. Other users cannot use your localhost.

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm run generate:certs` | Create self-signed TLS certs in `certs/` |
| `npm start` | Start server (HTTPS if certs exist, else HTTP) |
| `npm run start:https` | Require HTTPS (exits if certs missing) |
| `npm run test:wa` | Test HTTP connection |
| `$env:WA_URL="https://localhost:3001"; $env:NODE_TLS_REJECT_UNAUTHORIZED="0"; npm run test:wa` | Test HTTPS (PowerShell) |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `WA_SECRET` | `futureshield-wa-secret` | Bearer token |
| `USE_HTTPS` | — | Set to `1` to require TLS certs |
| `SSL_KEY` | `certs/localhost-key.pem` | Private key path |
| `SSL_CERT` | `certs/localhost-cert.pem` | Certificate path |

---

## Production (recommended)

Deploy `whatsapp-server.js` on a **VPS** (Railway, Render, DigitalOcean, etc.) with a real domain and **Let's Encrypt** HTTPS:

```
https://wa.yourdomain.com
```

In the dashboard WhatsApp settings, use that URL (not localhost).

### Optional: same-origin proxy (advanced)

If you deploy the WA server at `https://wa.yourdomain.com`, you can add a Vercel rewrite so the dashboard calls `/api/wa/*` on the same origin:

```json
{
  "source": "/api/wa/:path*",
  "destination": "https://wa.yourdomain.com/wa/:path*"
}
```

Then set Server URL to `/api/wa` (requires a small frontend change to support relative URLs).

**Vercel/Netlify cannot proxy to your laptop's localhost** — that only works when both services are on the internet.

---

## Alternative: tunnel (quick demo)

Use [ngrok](https://ngrok.com/) or Cloudflare Tunnel to expose local port 3001 over HTTPS:

```powershell
ngrok http 3001
```

Use the `https://xxxx.ngrok.io` URL in the dashboard (still run `npm start` locally).

---

## Troubleshooting

### "Blocked by browser (mixed content)"
→ Change Server URL from `http://` to `https://localhost:3001` and generate certs.

### "Cannot reach https://localhost:3001"
→ Trust the certificate by visiting `/wa/health` in the browser first.

### OpenSSL not found (Windows)
→ Install [Git for Windows](https://git-scm.com/) (includes OpenSSL) or OpenSSL for Windows.

### Works locally but not for team members
→ Deploy the WhatsApp server to a cloud VPS with HTTPS; localhost is only for you.
