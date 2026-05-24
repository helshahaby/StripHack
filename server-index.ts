/**
 * PropVoice Express Server
 * Mounts all routes and starts cron schedulers.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import stripeWebhookRouter from '../routes/stripeWebhook.js';
import voiceAgentRouter from '../routes/voiceAgent.js';
import apiRouter from '../routes/api.js';
import { startAllSchedulers } from '../jobs/RentScheduler.js';

const app = express();
const PORT = process.env.PORT ?? 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CRITICAL: Stripe webhooks BEFORE express.json() ──────────────────────────
app.use('/api/webhooks', stripeWebhookRouter);

// ── Standard middleware ───────────────────────────────────────────────────────
app.use(express.json());

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/voice', voiceAgentRouter);
app.use('/api', apiRouter);

// ── Health check (Railway liveness probe) ────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'PropVoice', ts: new Date().toISOString() });
});

// ── Serve React frontend ──────────────────────────────────────────────────────
const frontendDist = path.join(__dirname, '../../dist');
app.use(express.static(frontendDist));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏠 PropVoice running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
  startAllSchedulers();
});

export default app;
