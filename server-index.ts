import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import stripeWebhookRouter from './routes/stripeWebhook.js';
import voiceAgentRouter from './routes/voiceAgent.js';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── IMPORTANT: Stripe webhook MUST be mounted BEFORE express.json() ──────────
// Stripe needs the raw body buffer to verify the webhook signature.
app.use('/api/webhooks', stripeWebhookRouter);

// ─── Standard middleware ───────────────────────────────────────────────────────
app.use(express.json());

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/voice', voiceAgentRouter);

// ─── Health check (Railway uses this to confirm deploy is live) ───────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'PropVoice API',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV ?? 'development',
  });
});

// ─── Serve React frontend (built by Vite into /dist) ──────────────────────────
const frontendDist = path.join(__dirname, '../../dist');
app.use(express.static(frontendDist));

// All non-API routes return the React app (client-side routing)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 PropVoice API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Env:    ${process.env.NODE_ENV ?? 'development'}\n`);
});

export default app;
