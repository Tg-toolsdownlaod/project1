/** Background loop: auto rules, the download queue, and auto-following forwards. */
import { db, rows } from "./db.js";
import { config } from "./config.js";
import { applyAutoRules, processQueue } from "./downloader.js";
import * as forwarder from "./forwarder.js";
import * as mirror from "./mirror.js";
import { isAuthorized } from "./telegram.js";
import * as urlfetch from "./urlfetch.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one pass every WORKER_INTERVAL seconds until the process stops. */
export async function loop() {
  for (;;) {
    try {
      // Saving list URLs into R2 is plain HTTP: it must keep working while the
      // userbot is signed out, so it runs outside the Telegram-only pass.
      const savingUrls = await urlfetch.processQueue();
      if (savingUrls) console.log(`Started saving ${savingUrls} URL(s) to R2`);

      if (await isAuthorized()) await onePass();
    } catch (err) {
      // A bad pass must never kill the loop.
      console.error("Worker pass failed:", err?.message ?? err);
    }
    await sleep(config.workerInterval * 1000);
  }
}

async function onePass() {
  const { queued } = await applyAutoRules();
  if (queued) console.log(`Auto rules queued ${queued} episode(s)`);

  const started = await processQueue();
  if (started) console.log(`Started ${started} download(s)`);

  const added = await forwarder.syncAutoFollowJobs();
  if (added) console.log(`Auto-follow added ${added} video(s) to forward jobs`);

  const pending = rows(
    await db().from("forward_jobs").select("id, mirror_id").eq("status", "queued").limit(3)
  );
  for (const job of pending) {
    try {
      await forwarder.runJob(job.id);
    } catch (err) {
      console.error(`Forward job ${job.id} failed:`, err?.message ?? err);
    }
    if (job.mirror_id) await mirror.refreshStatus(job.mirror_id).catch(() => {});
  }
}
