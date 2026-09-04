/**
 * Mirrors a whole group into another one.
 *
 * Copying a big forum group into a fresh "branch" group is not a single
 * forward: every source topic needs its own topic in the destination and its
 * own run. Preparing a mirror creates those topics (once — the mapping is
 * remembered) and then queues one forward job per topic, so progress and
 * failures stay readable per topic in the existing Forward jobs view.
 */
import { Api } from "teleproto";

import { db, nowIso, rows } from "./db.js";
import { getClient, normalizeChatId } from "./telegram.js";

// Creating topics back to back trips Telegram's flood limits quickly.
const PAUSE_BETWEEN_TOPICS = 800;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const preparing = new Set();

/**
 * Builds (or refreshes) every forward job this mirror needs.
 *
 * Safe to re-run: topics already created are reused through
 * `mirror_topic_map`, and episodes already queued are not queued twice.
 */
export async function prepare(mirrorId) {
  if (preparing.has(mirrorId)) return { success: true, status: "already preparing" };
  preparing.add(mirrorId);
  try {
    return await run(mirrorId);
  } finally {
    preparing.delete(mirrorId);
  }
}

async function run(mirrorId) {
  const mirrors = rows(await db().from("group_mirrors").select("*").eq("id", mirrorId).limit(1));
  if (mirrors.length === 0) throw new Error(`No mirror with id ${mirrorId}.`);
  const mirror = mirrors[0];

  await db()
    .from("group_mirrors")
    .update({ status: "preparing", error: null })
    .eq("id", mirrorId);

  try {
    const client = await getClient();
    const target = await client.getEntity(normalizeChatId(mirror.target_chat_id));
    const targetIsForum = Boolean(target.forum);

    const episodes = rows(
      await db().from("episodes").select("*").eq("group_id", mirror.source_group_id)
    );
    const topics = rows(
      await db().from("topics").select("*").eq("group_id", mirror.source_group_id)
    );

    // Group the source videos by topic, keeping the "no topic" bucket.
    const buckets = new Map();
    for (const topic of topics) buckets.set(topic.id, []);
    buckets.set(null, []);
    for (const episode of episodes) {
      const key = buckets.has(episode.topic_id) ? episode.topic_id : null;
      buckets.get(key).push(episode);
    }

    const existingMap = rows(
      await db().from("mirror_topic_map").select("*").eq("mirror_id", mirrorId)
    );
    const mapped = new Map(existingMap.map((row) => [row.source_topic_id, row]));

    let topicCount = 0;
    let videoCount = 0;

    for (const [sourceTopicId, bucket] of buckets) {
      if (bucket.length === 0) continue;
      topicCount += 1;
      videoCount += bucket.length;

      const sourceTitle =
        topics.find((t) => t.id === sourceTopicId)?.title ?? "General";

      // Reuse the destination topic from a previous run, or make one now.
      let mapping = mapped.get(sourceTopicId);
      if (!mapping) {
        let targetTopicId = null;
        if (mirror.create_topics && targetIsForum && sourceTopicId !== null) {
          targetTopicId = await createTopic(client, target, sourceTitle);
          await sleep(PAUSE_BETWEEN_TOPICS);
        }
        const inserted = rows(
          await db()
            .from("mirror_topic_map")
            .insert({
              mirror_id: mirrorId,
              source_topic_id: sourceTopicId,
              target_topic_id: targetTopicId,
              title: sourceTitle,
            })
            .select()
        );
        mapping = inserted[0];
        mapped.set(sourceTopicId, mapping);
      }

      await queueJob(mirror, mapping, sourceTopicId, bucket);
    }

    await db()
      .from("group_mirrors")
      .update({
        status: "running",
        total_topics: topicCount,
        total_videos: videoCount,
        prepared_at: nowIso(),
      })
      .eq("id", mirrorId);

    return { success: true, topics: topicCount, videos: videoCount };
  } catch (err) {
    await db()
      .from("group_mirrors")
      .update({ status: "failed", error: String(err?.message ?? err).slice(0, 500) })
      .eq("id", mirrorId);
    throw err;
  }
}

/**
 * Creates a forum topic and returns its id.
 *
 * Telegram answers with an Updates envelope rather than the topic itself; the
 * topic's id is the id of the service message that opens it.
 */
async function createTopic(client, target, title) {
  const result = await client.invoke(
    new Api.messages.CreateForumTopic({
      peer: target,
      title: title.slice(0, 128),
      randomId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    })
  );

  for (const update of result?.updates ?? []) {
    const id = update?.message?.id ?? update?.id;
    if (id) return String(id);
  }
  throw new Error(`Telegram did not report an id for the new topic "${title}".`);
}

/**
 * One forward job per topic. An existing job for the same topic is topped up
 * with whatever is not in it yet, so re-running a mirror after a fresh scan
 * picks up only the new videos.
 */
async function queueJob(mirror, mapping, sourceTopicId, episodes) {
  const existingJobs = rows(
    await db()
      .from("forward_jobs")
      .select("*")
      .eq("mirror_id", mirror.id)
      .eq("source_topic_id", sourceTopicId ?? null)
  );

  let job = existingJobs[0];
  if (!job) {
    const inserted = rows(
      await db()
        .from("forward_jobs")
        .insert({
          mirror_id: mirror.id,
          source_group_id: mirror.source_group_id,
          source_topic_id: sourceTopicId,
          target_chat_id: mirror.target_chat_id,
          target_title: mirror.target_title,
          target_topic_id: mapping.target_topic_id,
          mode: "topic",
          status: "queued",
          copy_mode: mirror.copy_mode || "auto",
          auto_follow: mirror.auto_follow,
          total_count: 0,
        })
        .select()
    );
    job = inserted[0];
  }
  if (!job) throw new Error("Could not create the forward job for this topic.");

  const existingItems = rows(
    await db().from("forward_job_items").select("episode_id").eq("job_id", job.id)
  );
  const already = new Set(existingItems.map((row) => row.episode_id));
  const toAdd = episodes.filter((e) => !already.has(e.id));

  if (toAdd.length > 0) {
    await db()
      .from("forward_job_items")
      .insert(toAdd.map((e) => ({ job_id: job.id, episode_id: e.id, status: "pending" })));
  }

  await db()
    .from("forward_jobs")
    .update({
      total_count: already.size + toAdd.length,
      status: "queued",
      copy_mode: mirror.copy_mode || "auto",
      auto_follow: mirror.auto_follow,
      target_topic_id: mapping.target_topic_id,
    })
    .eq("id", job.id);
}

/** Rolls the mirror's status up from the jobs it spawned. */
export async function refreshStatus(mirrorId) {
  const jobs = rows(await db().from("forward_jobs").select("status").eq("mirror_id", mirrorId));
  if (jobs.length === 0) return;

  const anyActive = jobs.some((j) => j.status === "queued" || j.status === "running");
  const anyFailed = jobs.some((j) => j.status === "failed");

  await db()
    .from("group_mirrors")
    .update({ status: anyActive ? "running" : anyFailed ? "failed" : "completed" })
    .eq("id", mirrorId);
}
