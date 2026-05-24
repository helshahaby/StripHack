# Get a Free Database on Railway (5 min, Android Chrome)

## Step 1 — Add PostgreSQL to your Railway project

1. Open [railway.app](https://railway.app) in Chrome
2. Open your **propvoice** project
3. Tap the **"+ New"** button (top right)
4. Select **"Database"**
5. Select **"Add PostgreSQL"**
6. Railway creates the database instantly — you'll see it appear as a new card

---

## Step 2 — Get your DATABASE_URL

1. Tap the **PostgreSQL** card in your project
2. Tap the **"Variables"** tab
3. Find `DATABASE_URL` — it looks like:
   ```
   postgresql://postgres:AbCdEf123@monorail.proxy.rlwy.net:54321/railway
   ```
4. Tap it to copy

---

## Step 3 — Add DATABASE_URL to your app service

1. Go back to your project view
2. Tap your **propvoice app** service card (not the database)
3. Tap **"Variables"** tab
4. Tap **"+ New Variable"**
5. Name: `DATABASE_URL`
6. Value: paste what you copied in Step 2
7. Tap **Add**

> **Tip:** Railway can also do this automatically. In your app service Variables tab,
> tap **"+ New Variable"** → **"Add Reference"** → select the PostgreSQL service →
> select `DATABASE_URL`. This keeps it linked automatically.

---

## Step 4 — Add your other environment variables

Still in the Variables tab of your **app service**, add these one by one:

| Name | Value |
|------|-------|
| `STRIPE_SECRET_KEY` | Your `sk_live_...` key |
| `STRIPE_WEBHOOK_SECRET` | Your `whsec_...` (Webhook 1) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Your `whsec_...` (Webhook 2) |
| `ELEVENLABS_WEBHOOK_SECRET` | `PropVoiceSecret2026!` |
| `NODE_ENV` | `production` |
| `APP_URL` | Your Railway app URL (e.g. `https://propvoice-production.up.railway.app`) |

---

## Step 5 — Redeploy

1. Go to your app service → **"Deployments"** tab
2. Tap the **"..."** menu on the latest deployment
3. Tap **"Redeploy"**

This time the build will:
- ✅ `npm install` — installs packages
- ✅ `npx prisma generate` — generates the Prisma client
- ✅ `npm run build:server` — compiles TypeScript

Then on startup:
- ✅ `npx prisma migrate deploy` — creates all database tables
- ✅ `node dist/server/index.js` — starts the server

---

## Step 6 — Seed demo data (optional but recommended for hackathon demo)

After deployment succeeds:

1. Open your Railway project
2. Tap the **PostgreSQL** card → **"Query"** tab
   (Railway has a built-in SQL editor!)
3. Or use GitHub Codespaces:
   - Open your repo on GitHub
   - Tap the green **Code** button → **Codespaces** → New
   - In the terminal:
     ```bash
     export DATABASE_URL="postgresql://postgres:..."  # paste your URL
     npm install
     npm run db:seed
     ```

---

## Verify it worked

Visit: `https://your-app.up.railway.app/health`

You should see:
```json
{ "status": "ok", "service": "PropVoice", "ts": "2026-05-24T..." }
```

Then visit `https://your-app.up.railway.app/` for the dashboard.
