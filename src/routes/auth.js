import { Router } from 'express';
import { sendCode, verifyCode, logout } from '../telegramClient.js';
import { getTelegramSettings } from '../supabase.js';

export const authRouter = Router();

authRouter.post('/send-code', async (req, res) => {
  try {
    const settings = await getTelegramSettings();
    if (!settings?.api_id || !settings?.api_hash || !settings?.phone) {
      throw new Error('Save your API ID, API Hash and phone number first.');
    }
    const result = await sendCode({
      api_id: settings.api_id,
      api_hash: settings.api_hash,
      phone: settings.phone,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.errorMessage || err.message });
  }
});

authRouter.post('/verify-code', async (req, res) => {
  try {
    const { code, password } = req.body || {};
    if (!code) return res.status(400).json({ success: false, error: 'Missing code' });
    const result = await verifyCode({ code, password });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.errorMessage || err.message });
  }
});

authRouter.get('/status', async (req, res) => {
  try {
    const settings = await getTelegramSettings();
    res.json({
      connected: Boolean(settings?.connected && settings?.session_string),
      phone: settings?.phone || null,
      last_connected_at: settings?.last_connected_at || null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.post('/logout', async (req, res) => {
  try {
    await logout();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});
