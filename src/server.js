import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { groupsRouter } from './routes/groups.js';
import { downloadsRouter } from './routes/downloads.js';
import { restoreSessionOnBoot } from './telegramClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Set by `npm run build` at the repo root, which builds the frontend into
// backend/public. If it's not there, this server just runs as an API
// (e.g. when the frontend is deployed separately, as before).
const publicDir = path.join(__dirname, '..', 'public');
const hasFrontend = fs.existsSync(path.join(publicDir, 'index.html'));

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
  })
);

// Simple shared-secret auth so random people can't call your bot.
// Only guards the API — the frontend's static files (below) are public,
// same as any website's HTML/JS/CSS.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const key = req.header('x-api-key');
  if (!process.env.BACKEND_API_KEY || key !== process.env.BACKEND_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, frontend: hasFrontend }));

app.use('/api/telegram', authRouter);
app.use('/api/telegram/groups', groupsRouter);
app.use('/api/telegram/download', downloadsRouter);

if (hasFrontend) {
  app.use(express.static(publicDir));
  // SPA fallback: any non-API route serves index.html so client-side
  // routing/refreshes work.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Telegram userbot backend listening on port ${port}${hasFrontend ? ' (serving frontend too)' : ''}`);
});

// Reconnect a previously-saved Telegram session (if any) on boot, so a
// Railway/Render restart doesn't silently drop the userbot connection.
restoreSessionOnBoot().catch((err) => {
  console.error('[startup] Failed to restore Telegram session:', err.message);
});

