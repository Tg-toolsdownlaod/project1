# Telegram Userbot Backend

A small always-on Node.js server that does the part Bolt/Supabase can't:
logging into Telegram as your real account (userbot) via GramJS, scanning
groups/topics for videos, and downloading them straight to Cloudflare R2.

Your Bolt app keeps doing everything else (UI, settings storage). This
server only handles: send code → verify code → list groups → scan → download.

## 1. One-time Supabase setup

Run this in the Supabase SQL editor (needed so `groups` can be upserted by
chat id, and so `episodes` links load their group/topic):

```sql
alter table groups add constraint groups_chat_id_key unique (chat_id);
```

Get your **service role key**: Supabase dashboard → Project Settings → API →
`service_role` (NOT the `anon` key — this key bypasses RLS so the backend can
write scan/download results).

## 2. Configure

```bash
cp .env.example .env
```

Fill in:
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — from your Supabase project
- `ALLOWED_ORIGINS` — your Bolt app's URL, e.g. `https://telegram-group-video-txgk.bolt.host`
- `BACKEND_API_KEY` — make up any long random string; you'll also paste this into the frontend

## 3. Run locally to test

```bash
npm install
npm run start
```

Server runs on `http://localhost:8787`. Test it:

```bash
curl http://localhost:8787/health
```

## 4. Deploy (Railway example)

1. Push this folder to a new GitHub repo (or use Railway's "Deploy from local folder" CLI).
2. On [railway.app](https://railway.app) → New Project → Deploy from GitHub repo.
3. Add the same environment variables from `.env` in Railway's Variables tab.
4. Railway gives you a public URL like `https://your-app.up.railway.app`. That's your backend URL.

Render works the same way: New → Web Service → connect repo → set env vars →
Build command `npm install`, Start command `npm run start`.

**Important:** these are long-lived Node processes, so use Railway/Render's
"Web Service" (not serverless/edge functions) — the Telegram connection needs
to stay open, unlike a typical stateless API.

## 5. Point the frontend at it

In your Bolt app's `.env` (or Bolt's environment variables panel), add:

```
VITE_TELEGRAM_BACKEND_URL=https://your-app.up.railway.app
VITE_TELEGRAM_BACKEND_KEY=same-value-as-BACKEND_API_KEY
```

Then redeploy/republish the Bolt app. The Telegram page will now actually
send a real login code to your phone and let you type it in to connect.

## API endpoints

All require header `x-api-key: <BACKEND_API_KEY>`.

- `POST /api/telegram/send-code` — sends the login code to your phone
- `POST /api/telegram/verify-code` `{ code, password? }` — verifies it (password only if Telegram asks for 2FA)
- `GET /api/telegram/status` — is a session currently connected
- `POST /api/telegram/logout`
- `POST /api/telegram/groups/sync` — pulls your groups/channels into the `groups` table
- `POST /api/telegram/scan` `{ groupId, topicId?, limit? }` — finds videos, saves as `episodes`
- `POST /api/telegram/download` `{ episodeId }` — downloads the video and uploads it to R2

## Security notes

- The session string this server saves in `telegram_settings.session_string`
  gives full control of your Telegram account. Keep `SUPABASE_SERVICE_KEY`
  and `BACKEND_API_KEY` secret, and don't expose this server without the
  API-key middleware.
- Respect Telegram's Terms of Service — userbots that scrape/download at
  high volume can get the account rate-limited or banned.
