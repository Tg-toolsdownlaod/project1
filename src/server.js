/**
 * HTTP API the TG Downloader frontend talks to.
 *
 * Every route is a POST guarded by the x-api-key header, matching how the
 * frontend's callBackend() helper sends requests.
 */
import cors from "cors";
import express from "express";

import { config } from "./config.js";
import { db, nowIso, upsertSingle } from "./db.js";
import { applyAutoRules, retryFailed, runDownload } from "./downloader.js";
import * as forwarder from "./forwarder.js";
import * as mirror from "./mirror.js";
import * as takeout from "./takeout.js";
import * as r2 from "./r2.js";
import { scanGroup } from "./scanner.js";
import * as telegram from "./telegram.js";
import { loop } from "./worker.js";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

/** Express 4 does not forward async rejections, so every handler is wrapped. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

/** Rejects anything that does not carry the shared secret. */
function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    return res
      .status(500)
      .json({ success: false, error: "BACKEND_API_KEY is not configured on the server." });
  }
  if (req.get("x-api-key") !== config.apiKey) {
    return res.status(401).json({ success: false, error: "Invalid API key." });
  }
  return next();
}

/** Fire-and-forget a background job, logging instead of swallowing crashes. */
function spawn(promise, label) {
  promise.catch((err) => console.error(`${label} failed:`, err?.message ?? err));
}

// ---------------------------------------------------------------- health

app.get(
  "/health",
  route(async (_req, res) => {
    // The one route without an API key, safe to poll from the UI.
    res.json({
      success: true,
      telegram: await telegram.isAuthorized(),
      r2: await r2.ping(),
      takeout: takeout.isTakeoutActive(),
    });
  })
);

// ---------------------------------------------------------------- telegram login

app.post(
  "/api/telegram/send-code",
  requireApiKey,
  route(async (_req, res) => res.json(await telegram.sendCode()))
);

app.post(
  "/api/telegram/verify-code",
  requireApiKey,
  route(async (req, res) => {
    const { code = "", password = null } = req.body ?? {};
    if (!code && !password) {
      return res.status(400).json({ success: false, error: "A code or password is required." });
    }
    return res.json(await telegram.verifyCode(String(code), password || null));
  })
);

app.post(
  "/api/telegram/logout",
  requireApiKey,
  route(async (_req, res) => res.json(await telegram.logout()))
);

// ---------------------------------------------------------------- groups

app.post(
  "/api/telegram/groups/resolve",
  requireApiKey,
  route(async (req, res) => {
    const chatId = String(req.body?.chat_id ?? "").trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: "chat_id is required." });
    }
    return res.json(await telegram.describeGroup(chatId));
  })
);

app.post(
  "/api/telegram/dialogs",
  requireApiKey,
  route(async (req, res) => {
    const limit = Number(req.body?.limit) || 200;
    res.json({ success: true, dialogs: await telegram.listDialogs(limit) });
  })
);

app.post(
  "/api/telegram/join",
  requireApiKey,
  route(async (req, res) => {
    const invite = String(req.body?.invite ?? "").trim();
    if (!invite) {
      return res.status(400).json({ success: false, error: "invite is required." });
    }
    return res.json(await telegram.joinChat(invite));
  })
);

app.post(
  "/api/telegram/notify",
  requireApiKey,
  route(async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) {
      return res.status(400).json({ success: false, error: "text is required." });
    }
    return res.json(await telegram.notifySelf(text));
  })
);

app.post(
  "/api/telegram/groups/:groupId/scan",
  requireApiKey,
  route(async (req, res) => {
    const limit = Number(req.body?.limit) || 3000;
    res.json(await scanGroup(req.params.groupId, limit));
  })
);

// ---------------------------------------------------------------- downloads

app.post(
  "/api/downloads/:downloadId/start",
  requireApiKey,
  route(async (req, res) => {
    spawn(runDownload(req.params.downloadId), `download ${req.params.downloadId}`);
    res.json({ success: true, status: "started" });
  })
);

app.post(
  "/api/downloads/:downloadId/cancel",
  requireApiKey,
  route(async (req, res) => {
    await db().from("downloads").update({ status: "cancelled" }).eq("id", req.params.downloadId);
    res.json({ success: true });
  })
);

app.post(
  "/api/downloads/retry-failed",
  requireApiKey,
  route(async (_req, res) => res.json({ success: true, requeued: await retryFailed() }))
);

app.post(
  "/api/rules/run",
  requireApiKey,
  route(async (_req, res) => res.json({ success: true, ...(await applyAutoRules()) }))
);

// ---------------------------------------------------------------- forwarding

app.post(
  "/api/telegram/forward/:jobId/start",
  requireApiKey,
  route(async (req, res) => {
    // Answer immediately: a long job would otherwise time the browser out.
    spawn(forwarder.runJob(req.params.jobId), `forward job ${req.params.jobId}`);
    res.json({ success: true, status: "started" });
  })
);

app.post(
  "/api/telegram/forward/:jobId/cancel",
  requireApiKey,
  route(async (req, res) => {
    await db()
      .from("forward_jobs")
      .update({ status: "cancelled", auto_follow: false })
      .eq("id", req.params.jobId);
    res.json({ success: true });
  })
);

app.post(
  "/api/telegram/mirror/:mirrorId/prepare",
  requireApiKey,
  route(async (req, res) => {
    // Creating topics and queueing thousands of videos takes a while, so this
    // answers immediately and reports through group_mirrors.status.
    spawn(mirror.prepare(req.params.mirrorId), `mirror ${req.params.mirrorId}`);
    res.json({ success: true, status: "preparing" });
  })
);

app.post(
  "/api/telegram/mirror/:mirrorId/cancel",
  requireApiKey,
  route(async (req, res) => {
    await db()
      .from("forward_jobs")
      .update({ status: "cancelled", auto_follow: false })
      .eq("mirror_id", req.params.mirrorId)
      .in("status", ["queued", "running"]);
    await db()
      .from("group_mirrors")
      .update({ status: "cancelled", auto_follow: false })
      .eq("id", req.params.mirrorId);
    res.json({ success: true });
  })
);

app.post(
  "/api/telegram/takeout/start",
  requireApiKey,
  route(async (_req, res) => res.json(await takeout.startTakeoutSession()))
);

app.post(
  "/api/telegram/takeout/stop",
  requireApiKey,
  route(async (req, res) => res.json(await takeout.stopTakeoutSession(req.body?.success ?? true)))
);

// ---------------------------------------------------------------- r2

app.post(
  "/api/r2/test",
  requireApiKey,
  route(async (_req, res) => {
    const result = await r2.testConnection();
    await upsertSingle("r2_settings", { connected: true, last_connected_at: nowIso() });
    res.json({ success: true, ...result });
  })
);

// The frontend reads {success, error} off every response, so a crash has to
// keep that shape -- Express's default HTML error page would leave the user
// with a generic "Request to backend failed." instead of the real reason.
app.use((err, req, res, _next) => {
  console.error(`Request failed: ${req.method} ${req.path}`, err?.message ?? err);
  res.status(500).json({ success: false, error: String(err?.message ?? err).slice(0, 500) });
});

app.listen(config.port, () => {
  console.log(`Userbot service listening on http://localhost:${config.port}`);
  void loop();
});

export { app };
