import os from "node:os";
import path from "node:path";

import "dotenv/config";

const str = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const int = (name, fallback) => {
  const parsed = Number.parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  apiKey: str("BACKEND_API_KEY"),
  corsOrigins: str("CORS_ORIGINS", "*").split(",").map((o) => o.trim()).filter(Boolean),
  port: int("PORT", 8000),

  supabaseUrl: str("SUPABASE_URL"),
  supabaseServiceKey: str("SUPABASE_SERVICE_ROLE_KEY"),

  telegramApiId: str("TELEGRAM_API_ID"),
  telegramApiHash: str("TELEGRAM_API_HASH"),
  telegramPhone: str("TELEGRAM_PHONE"),
  telegramSession: str("TELEGRAM_SESSION_STRING"),

  r2AccountId: str("R2_ACCOUNT_ID"),
  r2AccessKeyId: str("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: str("R2_SECRET_ACCESS_KEY"),
  r2BucketName: str("R2_BUCKET_NAME"),
  r2EndpointUrl: str("R2_ENDPOINT_URL"),
  r2PublicUrl: str("R2_PUBLIC_URL"),
  r2Region: str("R2_REGION", "auto"),

  workerInterval: int("WORKER_INTERVAL", 30),
  maxConcurrentDownloads: int("MAX_CONCURRENT_DOWNLOADS", 0),
  // Telegram's own per-account throttle, not a cap we invent: teleproto already
  // opens up to 8 parallel connections per download and grows the window
  // automatically. Raising this trades a small chance of an extra FLOOD_WAIT
  // for more throughput on fast links; 0 leaves the library's own default.
  maxDownloadSessions: int("TELEGRAM_MAX_DOWNLOAD_SESSIONS", 0),
  // How long the forwarder waits between messages by choice, to stay well
  // under Telegram's flood limits. Any FLOOD_WAIT Telegram actually returns is
  // honored in full regardless of this value -- see floodRetry.js.
  forwardPauseMs: int("FORWARD_PAUSE_MS", 1500),
  // teleproto itself already sleeps out any FLOOD_WAIT at or under this many
  // seconds, transparently, for every single API call the client makes --
  // not just the ones floodRetry.js wraps. Its own default is a conservative
  // 60s; raising it here gives that blanket coverage to scanning, entity
  // lookups and everything else, while floodRetry.js still catches the rarer
  // waits that land above it (for the download/forward calls it wraps).
  floodSleepThresholdSeconds: int("TELEGRAM_FLOOD_SLEEP_THRESHOLD", 300),
  // Default per platform, so Windows does not end up with a stray C:\tmp.
  downloadDir: str("DOWNLOAD_DIR") || path.join(os.tmpdir(), "tg-downloads"),
};
