/** Works the download queue: Telegram -> local disk -> R2. */
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import { db, downloadSettings, nowIso, rows } from "./db.js";
import * as r2 from "./r2.js";
import { withFloodRetry } from "./floodRetry.js";
import { getClient, normalizeChatId } from "./telegram.js";

const running = new Set();

// Windows rejects these in a filename; Telegram captions are full of them.
const ILLEGAL_IN_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Makes a Telegram filename safe to write on any OS. */
export function safeFilename(name) {
  const cleaned = (name || "")
    .replace(ILLEGAL_IN_FILENAME, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return (cleaned || "video.mp4").slice(0, 120);
}

/** Starts as many queued downloads as the concurrency limit allows. */
export async function processQueue() {
  const conf = await downloadSettings();
  const limit = config.maxConcurrentDownloads || conf.concurrentDownloads || 3;
  const freeSlots = Math.max(limit - running.size, 0);
  if (freeSlots === 0) return 0;

  const queued = rows(
    await db()
      .from("downloads")
      .select("*")
      .eq("status", "queued")
      .order("queued_at", { ascending: true })
      .limit(freeSlots)
  );

  let started = 0;
  for (const row of queued) {
    if (running.has(row.id)) continue;
    void runDownload(row.id);
    started += 1;
  }
  return started;
}

/** Downloads one episode and uploads it to R2, reporting progress as it goes. */
export async function runDownload(downloadId) {
  if (running.has(downloadId)) return;
  running.add(downloadId);
  let localPath = null;

  try {
    const downloads = rows(await db().from("downloads").select("*").eq("id", downloadId).limit(1));
    if (downloads.length === 0) return;
    const download = downloads[0];

    const episodes = rows(
      await db().from("episodes").select("*").eq("id", download.episode_id).limit(1)
    );
    if (episodes.length === 0) {
      await fail(downloadId, "The episode row is gone.");
      return;
    }
    const episode = episodes[0];

    const groups = rows(await db().from("groups").select("*").eq("id", episode.group_id).limit(1));
    if (groups.length === 0) {
      await fail(downloadId, "The group row is gone.");
      return;
    }
    const group = groups[0];

    let topicTitle = "";
    if (episode.topic_id) {
      const topics = rows(
        await db().from("topics").select("title").eq("id", episode.topic_id).limit(1)
      );
      topicTitle = topics[0]?.title ?? "";
    }

    await db()
      .from("downloads")
      .update({ status: "downloading", started_at: nowIso(), error: null })
      .eq("id", downloadId);
    await db().from("episodes").update({ status: "downloading" }).eq("id", episode.id);

    const client = await getClient();
    const entity = await client.getEntity(normalizeChatId(group.chat_id));
    const message = await withFloodRetry(
      () => client.getMessages(entity, { ids: Number(episode.message_id) }),
      { label: `getMessages for episode ${episode.id}` }
    );
    const found = Array.isArray(message) ? message[0] : message;
    if (!found?.media) {
      await fail(downloadId, "The source message no longer has media.", episode.id);
      return;
    }

    await fs.mkdir(config.downloadDir, { recursive: true });
    localPath = path.join(
      config.downloadDir,
      `${downloadId}-${safeFilename(episode.file_name || "video.mp4")}`
    );

    let lastReport = 0;
    await withFloodRetry(
      () =>
        client.downloadMedia(found, {
          outputFile: localPath,
          progressCallback: (received, total) => {
            const now = Date.now();
            if (now - lastReport < 2000) return; // keep the write rate sane
            lastReport = now;
            const done = Number(received);
            const size = Number(total);
            void db()
              .from("downloads")
              .update({
                progress: size ? Math.floor((done / size) * 90) : 0,
                downloaded_bytes: done,
                total_bytes: size,
              })
              .eq("id", downloadId);
          },
        }),
      { label: `download for episode ${episode.id}` }
    );

    const conf = await downloadSettings();
    let r2Key = null;
    let r2Url = null;
    if (conf.autoR2Upload) {
      r2Key = r2.buildKey(
        conf.r2FolderPattern,
        group.title,
        topicTitle,
        episode.ep_number,
        episode.file_name || "video.mp4"
      );
      await db().from("downloads").update({ progress: 92 }).eq("id", downloadId);
      r2Url = await r2.upload(localPath, r2Key);
    }

    const { size } = await fs.stat(localPath);
    await db()
      .from("downloads")
      .update({
        status: "completed",
        progress: 100,
        completed_at: nowIso(),
        r2_key: r2Key,
        r2_url: r2Url,
        downloaded_bytes: size,
      })
      .eq("id", downloadId);
    await db().from("episodes").update({ status: "completed", r2_key: r2Key }).eq("id", episode.id);
    await refreshCounters(group.id, episode.topic_id);
  } catch (err) {
    await fail(downloadId, String(err?.message ?? err).slice(0, 500));
  } finally {
    running.delete(downloadId);
    if (localPath) await fs.rm(localPath, { force: true }).catch(() => {});
  }
}

async function fail(downloadId, error, episodeId = null) {
  await db().from("downloads").update({ status: "failed", error }).eq("id", downloadId);
  if (episodeId) await db().from("episodes").update({ status: "failed" }).eq("id", episodeId);
}

async function refreshCounters(groupId, topicId) {
  const episodes = rows(
    await db().from("episodes").select("id, topic_id, status").eq("group_id", groupId)
  );
  await db()
    .from("groups")
    .update({
      total_episodes: episodes.length,
      downloaded_episodes: episodes.filter((e) => e.status === "completed").length,
    })
    .eq("id", groupId);

  if (topicId) {
    const inTopic = episodes.filter((e) => e.topic_id === topicId);
    await db()
      .from("topics")
      .update({
        total_episodes: inTopic.length,
        downloaded_episodes: inTopic.filter((e) => e.status === "completed").length,
      })
      .eq("id", topicId);
  }
}

/** Re-queues failed downloads while the retry budget allows it. */
export async function retryFailed() {
  const conf = await downloadSettings();
  if (!conf.retryOnFail) return 0;
  const failed = rows(await db().from("downloads").select("id").eq("status", "failed").limit(20));
  for (const row of failed) {
    await db().from("downloads").update({ status: "queued", error: null }).eq("id", row.id);
  }
  return failed.length;
}

/** Queues episodes that match an active auto-download rule, and relays them. */
export async function applyAutoRules() {
  const rules = rows(await db().from("auto_download_rules").select("*").eq("active", true));
  let queued = 0;
  let forwardJobs = 0;

  for (const rule of rules) {
    let query = db()
      .from("episodes")
      .select("*")
      .eq("group_id", rule.group_id)
      .eq("status", "pending");
    if (rule.topic_id) query = query.eq("topic_id", rule.topic_id);
    const candidates = rows(await query);

    const minBytes = Number(rule.min_file_size_mb ?? 0) * 1024 * 1024;
    const matched = candidates.filter((episode) => {
      const ep = episode.ep_number;
      if (rule.auto_ep_start !== null && (ep === null || ep < rule.auto_ep_start)) return false;
      if (rule.auto_ep_end !== null && (ep === null || ep > rule.auto_ep_end)) return false;
      if (minBytes && Number(episode.file_size ?? 0) < minBytes) return false;
      return true;
    });

    if (matched.length > 0) {
      await db()
        .from("downloads")
        .insert(
          matched.map((e) => ({
            episode_id: e.id,
            status: "queued",
            total_bytes: e.file_size ?? 0,
          }))
        );
      await db()
        .from("episodes")
        .update({ status: "queued" })
        .in(
          "id",
          matched.map((e) => e.id)
        );
      queued += matched.length;

      if (rule.forward_enabled && rule.forward_to_chat_id) {
        const job = rows(
          await db()
            .from("forward_jobs")
            .insert({
              source_group_id: rule.group_id,
              source_topic_id: rule.topic_id,
              target_chat_id: rule.forward_to_chat_id,
              target_topic_id: rule.forward_to_topic_id,
              mode: "selected",
              status: "queued",
              total_count: matched.length,
              auto_follow: false,
            })
            .select()
        );
        if (job[0]) {
          await db()
            .from("forward_job_items")
            .insert(
              matched.map((e) => ({ job_id: job[0].id, episode_id: e.id, status: "pending" }))
            );
          forwardJobs += 1;
        }
      }
    }

    await db().from("auto_download_rules").update({ last_check_at: nowIso() }).eq("id", rule.id);
  }

  return { queued, forward_jobs: forwardJobs };
}
