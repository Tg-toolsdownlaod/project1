# TG Downloader — userbot service (Node.js)

The reference backend the frontend talks to, in Node. It signs in as your
Telegram account (a "userbot"), scans groups for videos, downloads them,
uploads them to Cloudflare R2, and forwards videos from one group into another.

Requires only Node — one runtime, one `npm install`. Run **one** instance: the
Telegram session is stateful, and two userbots sharing it will fight over it.

```
src/
  server.js      Express routes (the API the frontend calls)
  worker.js      background loop: auto rules, download queue, auto-forward
  telegram.js    userbot session, login, group/topic lookup
  scanner.js     group -> topics -> video episodes, into Supabase
  downloader.js  download queue -> local disk -> R2
  forwarder.js   forward jobs: copy videos into another group
  r2.js          Cloudflare R2 (S3-compatible) client
  db.js          Supabase access with the service-role key
  config.js      environment configuration
  login.js       one-off terminal login, prints a session string
```

Requires **Node 20 or newer**.

## Setup

```bash
cd backend-node
cp .env.example .env       # then fill it in
npm install
npm run login              # sign in once, paste the session string into .env
npm start
```

Point the frontend at it:

```
VITE_TELEGRAM_BACKEND_URL=http://localhost:8000
VITE_TELEGRAM_BACKEND_KEY=<the same value as BACKEND_API_KEY>
```

### Windows

Same steps; in PowerShell or CMD:

```
cd backend-node
copy .env.example .env
npm install
npm run login
start.bat
```

Set `DOWNLOAD_DIR` to a path with room for the videos, e.g.
`DOWNLOAD_DIR=D:\tg-downloads`. Files are deleted right after they reach R2,
but a big download needs the space while it runs.

**The deployed frontend cannot call `http://localhost`.** A page served over
HTTPS (Vercel) is not allowed by the browser to call a plain-HTTP address, so
pointing `VITE_TELEGRAM_BACKEND_URL` at your PC only works if the frontend is
also local. Pick one:

| Setup | What to do |
| --- | --- |
| Everything local | `npm run dev` in the project root, and put `VITE_TELEGRAM_BACKEND_URL=http://localhost:8000` in the frontend's `.env` |
| Vercel frontend, backend on your PC | Put an HTTPS tunnel in front of it — `cloudflared tunnel --url http://localhost:8000` prints a public HTTPS URL; use that in the Vercel env vars |
| Always-on | Run it on a small VPS with Docker (below) instead of your PC |

Auto-download and auto-forward only run while this service is running, so on a
home PC they stop when it sleeps or shuts down.

### Docker

```bash
docker build -t tg-downloader-backend-node .
docker run --env-file .env -p 8000:8000 tg-downloader-backend-node
```

Run **one** instance. The Telegram session is stateful, and several userbots
sharing it will fight over it — Telegram may invalidate the session.

### Railway

The repo already has what Railway needs: `Dockerfile` and `railway.toml` in
this directory build the service and poll `/health` before routing traffic to
it.

1. **New service → Deploy from GitHub repo**, pick this repository.
2. **Settings → Root Directory** → set it to `backend-node` (Railway builds
   the whole repo otherwise, and the Dockerfile's `COPY` paths are relative to
   this folder).
3. **Get a session string before you deploy, not after.** Railway has no
   interactive terminal for `npm run login`'s code prompt. Run it once on your
   own machine instead:
   ```bash
   cd backend-node
   npm install
   npm run login
   ```
   Paste the printed string into Railway as `TELEGRAM_SESSION_STRING` in the
   next step — the service reads it from the environment on boot and never
   needs to log in again.
4. **Variables** — add everything from `.env.example`: `BACKEND_API_KEY`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_API_ID`,
   `TELEGRAM_API_HASH`, `TELEGRAM_PHONE`, `TELEGRAM_SESSION_STRING` (from step
   3), and the R2 variables if you're not keeping those in Supabase. Leave
   `PORT` unset — Railway injects its own and the service already reads it.
   Set `CORS_ORIGINS` to your actual frontend origin, e.g.
   `https://tg-tools-downlaod.vercel.app`.
5. **Deploy.** Railway gives the service a public HTTPS URL
   (`https://<name>.up.railway.app`) — put that in the frontend's
   `VITE_TELEGRAM_BACKEND_URL`, and `BACKEND_API_KEY`'s value in
   `VITE_TELEGRAM_BACKEND_KEY`, then redeploy the frontend on Vercel.
6. **Confirm it's alive**: `curl https://<name>.up.railway.app/health` should
   answer `{"success":true,"telegram":true,...}`. `telegram: false` means the
   session string was not picked up — check the variable is set and redeploy.

Railway's filesystem is ephemeral (wiped on every redeploy), which is fine
here: downloaded files are removed right after the R2 upload, so nothing
needs to survive a restart except the environment variables themselves.

## Credentials

`api_id`, `api_hash`, the session string and the R2 secret key are read from
the environment first, and only fall back to the Supabase tables when the
environment does not set them.

**Prefer the environment.** The frontend's anon key ships inside the JavaScript
bundle, and the current RLS policies let `anon` read every table — so anything
stored in `telegram_settings` or `r2_settings` is readable by anyone who opens
the deployed site. A leaked `session_string` is full control of your Telegram
account. Keeping the secrets here, and letting the database hold only status
(`connected`, `account_username`), closes that hole without changing the UI.

The Supabase key this service uses must be the **service role** key, never the
anon key: it writes scan results and download progress with RLS bypassed.

## What the worker does

Every `WORKER_INTERVAL` seconds (default 30), while the userbot is signed in:

1. **Auto rules** — finds `pending` episodes matching an active
   `auto_download_rules` row (episode range, minimum file size), queues them,
   and creates a forward job when the rule has a forward target.
2. **Download queue** — starts up to `concurrent_downloads` queued downloads,
   writing progress into the `downloads` row as it goes, then uploads to R2
   using the `r2_folder_pattern` from `download_settings`.
3. **Auto-follow forwards** — adds newly scanned videos to forward jobs with
   `auto_follow = true`, then works any queued job.

## Notes on the Telegram library

This uses [teleproto](https://www.npmjs.com/package/teleproto), the maintained
fork of GramJS (the `telegram` package is archived). One API difference matters
here: forum topics are fetched with `messages.GetForumTopics`, not
`channels.GetForumTopics` as in older GramJS.

## Speed and limits — what is actually true

There is no setting, here or anywhere, that makes Telegram stop rate-limiting
an account. `FLOOD_WAIT` is enforced on Telegram's servers, per account, and
every client is bound by it equally — the official app included. Anything
promising unlimited speed or a guaranteed 100% forward rate is either lying or
about to get the account temporarily locked out. What this service actually
does, and why that is close to the practical ceiling:

- **Downloads already run in parallel per file.** teleproto opens up to 8
  connections per download and grows the transfer window on its own — this
  is not a single-threaded fetch. `TELEGRAM_MAX_DOWNLOAD_SESSIONS` raises that
  ceiling further if your link can use it; leaving it unset keeps the
  library's tuned default.
- **`MAX_CONCURRENT_DOWNLOADS` has no ceiling in the code.** Set it as high as
  your CPU, disk and bandwidth allow. The queue will run that many downloads
  at once.
- **A real `FLOOD_WAIT` is always honored, not treated as a failure.** Every
  network call the downloader and forwarder make is wrapped so that if
  Telegram asks for N seconds, this waits exactly that long and retries —
  automatically, up to six attempts per call. Marking the item failed after
  one flood wait would be the actual bug; this is what gets a large batch to finish
  on its own instead of needing a manual retry.
- **`FORWARD_PAUSE_MS` (default 1500ms) is a courtesy gap between forwards**,
  not a hard limit — it exists to trigger fewer flood waits in the first
  place. Lowering it trades some safety margin for speed; it does not change
  what Telegram allows.
- **`TELEGRAM_FLOOD_SLEEP_THRESHOLD` (default 300s) covers everything else.**
  teleproto sleeps out any `FLOOD_WAIT` at or under this threshold
  automatically, silently, for every single call the client makes — scanning,
  entity lookups, joins, not just downloads and forwards. The library's own
  default is a conservative 60s; raising it gives that blanket coverage to
  the calls `floodRetry.js` never touches. The library caps it at 24h either
  way, so this can't be set to something that hangs forever.
- **Scanning reads at most 3000 messages per call** — pass `{"limit": N}` to
  the scan endpoint for deeper history; this is a request-size choice, not a
  rate limit.
- **Some things fail for reasons no retry fixes.** A source group with content
  protection blocks forwarding outright (see below — re-upload mode is the
  actual workaround, not a faster retry). A destination the account isn't a
  member of, or a deleted source message, will fail every time regardless of
  how long you wait.

## Forwarding, and why it does not re-upload

A plain forward (`forwardMessages`) is used when the destination has no topic.
When you forward *into a forum topic*, Telegram's forward call cannot target a
topic, so the service re-sends the same media object with `replyTo=<topic id>`.
The existing file reference is reused, so nothing is downloaded or uploaded
again — but the message loses its "forwarded from" header.

Groups with content protection enabled cannot be forwarded from at all; those
items are marked failed with the error Telegram returned.

See [`../docs/BACKEND_API.md`](../docs/BACKEND_API.md) for the endpoint contract.
