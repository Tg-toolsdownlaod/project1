import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { groupsRouter } from './routes/groups.js';
import { downloadsRouter } from './routes/downloads.js';
import { restoreSessionOnBoot } from './telegramClient.js';

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
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.header('x-api-key');
  if (!process.env.BACKEND_API_KEY || key !== process.env.BACKEND_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/telegram', authRouter);
app.use('/api/telegram/groups', groupsRouter);
app.use('/api/telegram/download', downloadsRouter);

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Telegram userbot backend listening on port ${port}`);
});

// Reconnect a previously-saved Telegram session (if any) on boot, so a
// Railway/Render restart doesn't silently drop the userbot connection.
restoreSessionOnBoot().catch((err) => {
  console.error('[startup] Failed to restore Telegram session:', err.message);
});
