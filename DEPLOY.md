# PropVoice — Deployment Guide (Android-Friendly)

Everything works from **Chrome on Android**. No terminal on your phone needed.

---

## Step 1 — Push your code to GitHub

1. Go to [github.com](https://github.com) → **New repository**
2. Name it `propvoice` → Create (keep it private)
3. On the next screen, tap **"uploading an existing file"**
4. Upload all project files (or use GitHub Codespaces for git CLI)

> **Tip:** In GitHub Codespaces you get a full terminal. Open your repo → green **Code** button → **Codespaces** → New → then run:
> ```bash
> git add . && git commit -m "Initial PropVoice commit" && git push
> ```

---

## Step 2 — Create your Railway database

1. Go to [railway.app](https://railway.app) → Sign in with GitHub
2. **New Project** → **Provision PostgreSQL**
3. Click the PostgreSQL service → **Variables** tab
4. Copy the `DATABASE_URL` — looks like:
   ```
   postgresql://postgres:xxxx@monorail.proxy.rlwy.net:12345/railway
   ```

---

## Step 3 — Deploy your app on Railway

1. In Railway → **New Service** → **GitHub Repo** → select `propvoice`
2. Railway auto-detects Node.js and uses your `railway.toml`
3. Go to the service → **Variables** tab → add these one by one:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | (paste from Step 2) |
| `STRIPE_SECRET_KEY` | `sk_live_...` (from Stripe dashboard) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (Webhook 1 — platform) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `whsec_...` (Webhook 2 — connected accounts) |
| `ELEVENLABS_WEBHOOK_SECRET` | `PropVoiceSecret2026!` |
| `NODE_ENV` | `production` |
| `APP_URL` | (Railway gives you a URL after first deploy) |

4. Railway will automatically build and deploy. Watch the **Deploy Logs** tab.

---

## Step 4 — Run database migrations

After first deploy succeeds, Railway runs migrations automatically via `postinstall`.

To run manually or seed demo data, open **Codespaces** on your repo and run:

```bash
# Install deps
npm install

# Run migrations (creates all tables)
npx prisma migrate deploy

# Optional: seed demo data for testing
npm run db:seed
```

You'll see this output when seeding works:
```
✅ Landlord: Samuel Cohen
✅ Tenants: Sarah Chen, Marco Rivera
✅ Vendors: Hans Gruber (Plumbing), Maria Santos (Cleaning)
✅ Tickets: Plumbing (WIP), Heating (Dispatched), Cleaning (Paid)
✅ Transactions: Rent collected, Escrow hold, Vendor payout, Platform fee
🎉 Seed complete!
```

---

## Step 5 — Set up Stripe Webhooks

1. Go to [dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks)
2. **Add endpoint** → URL: `https://your-app.up.railway.app/api/webhooks/stripe`
3. Select events:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `account.updated`
4. Copy the signing secret → paste as `STRIPE_WEBHOOK_SECRET` in Railway

For **connected accounts** webhook (Webhook 2):
- Same URL, but tick **"Listen to events on Connected accounts"**
- Copy that signing secret → paste as `STRIPE_CONNECT_WEBHOOK_SECRET`

---

## Step 6 — Set up ElevenLabs

1. Go to [elevenlabs.io](https://elevenlabs.io) → Create Agent → name it **Theo**
2. Paste the system prompt from `prompts/theo-system-prompt.md`
3. Add two **Custom Tools**:

**Tool 1: `getAvailableVendor`**
```json
{
  "name": "getAvailableVendor",
  "url": "https://your-app.up.railway.app/api/voice/tools",
  "method": "POST",
  "parameters": {
    "serviceType": "string"
  }
}
```

**Tool 2: `bookVendorAndHoldFunds`**
```json
{
  "name": "bookVendorAndHoldFunds",
  "url": "https://your-app.up.railway.app/api/voice/tools",
  "method": "POST",
  "parameters": {
    "ticketId": "string",
    "vendorId": "string",
    "agreedPrice": "number"
  }
}
```

4. Under **Webhooks** → set URL to `https://your-app.up.railway.app/api/voice/webhook`
5. Set signing secret to `PropVoiceSecret2026!`

---

## Step 7 — Verify everything works

Visit these URLs in your browser:

| URL | Expected |
|-----|----------|
| `https://your-app.up.railway.app/health` | `{"status":"ok"}` |
| `https://your-app.up.railway.app/` | PropVoice Dashboard UI |

---

## GitHub Actions (Auto-deploy on push)

Every time you push to `main`, GitHub Actions will:
1. Run TypeScript type check
2. Build frontend + server
3. Deploy to Railway automatically

You need to add one GitHub Secret:
1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. **New secret** → Name: `RAILWAY_TOKEN`
3. Value: get from Railway → **Account Settings** → **Tokens** → Create token

---

## Troubleshooting

**Build fails on Railway:**
- Check Deploy Logs in Railway dashboard
- Most common issue: missing environment variable

**Stripe webhook signature fails:**
- Make sure `STRIPE_WEBHOOK_SECRET` matches exactly what Stripe shows
- The `/api/webhooks/stripe` route must be mounted BEFORE `express.json()` — already done in `src/server/index.ts`

**Prisma migration errors:**
- Run in Codespaces: `npx prisma migrate status` to see what's pending
- If schema changed: `npx prisma migrate dev --name describe_change`

**ElevenLabs tool not triggering:**
- Check the tool URL is exactly `https://your-app.up.railway.app/api/voice/tools`
- Check Railway logs for incoming POST requests to `/api/voice/tools`
