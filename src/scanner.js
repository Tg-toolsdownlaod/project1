/** Scans a Telegram group for its topics and video messages. */
import { Api } from "teleproto";

import { db, nowIso, rows } from "./db.js";
import { getClient, listTopics, normalizeChatId } from "./telegram.js";

// "EP 12", "EP12", "ep-012", "[EP 12]" and friends.
const EP_PATTERNS = [
  /\bEP[\s._-]*0*(\d{1,4})\b/i,
  /\bE[\s._-]*0*(\d{1,4})\b/i,
  /ភាគ[\s._-]*0*(\d{1,4})/,
  /\b0*(\d{1,4})\b/,
];

/** Pulls an episode number out of a caption or filename, best effort. */
export function parseEpNumber(...sources) {
  for (const text of sources) {
    if (!text) continue;
    for (const pattern of EP_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

/** Returns file details when the message carries a video, else null. */
function videoInfo(message) {
  const document = message.media?.document;
  if (!document) return null;

  const mime = document.mimeType ?? "";
  const attributes = document.attributes ?? [];
  const videoAttr = attributes.find((a) => a instanceof Api.DocumentAttributeVideo);
  if (!mime.startsWith("video/") && !videoAttr) return null;

  const nameAttr = attributes.find((a) => a instanceof Api.DocumentAttributeFilename);
  return {
    fileName: nameAttr?.fileName || `${message.id}.mp4`,
    fileSize: Number(document.size ?? 0),
    duration: Math.round(Number(videoAttr?.duration ?? 0)),
    mimeType: mime || "video/mp4",
  };
}

/** The forum topic a message belongs to, or null outside a forum. */
function topicIdOf(message) {
  const replyTo = message.replyTo;
  if (!replyTo || !replyTo.forumTopic) return null;
  return replyTo.replyToTopId ?? replyTo.replyToMsgId ?? null;
}

/** Syncs one group's topics and videos into Supabase. Safe to re-run. */
export async function scanGroup(groupId, messageLimit = 3000) {
  const groups = rows(await db().from("groups").select("*").eq("id", groupId).limit(1));
  if (groups.length === 0) throw new Error(`No group with id ${groupId}.`);
  const group = groups[0];

  const client = await getClient();
  const entity = await client.getEntity(normalizeChatId(group.chat_id));
  const isForum = Boolean(entity.forum);

  // 1. Topics — keyed by their Telegram id so re-scans update instead of duplicate.
  const existingTopics = rows(await db().from("topics").select("*").eq("group_id", groupId));
  const topicRows = new Map(
    existingTopics.filter((t) => t.topic_id).map((t) => [String(t.topic_id), t])
  );

  if (isForum) {
    for (const topic of await listTopics(entity)) {
      const known = topicRows.get(topic.topic_id);
      if (known) {
        if (known.title !== topic.title) {
          await db().from("topics").update({ title: topic.title }).eq("id", known.id);
          known.title = topic.title;
        }
      } else {
        const inserted = rows(
          await db()
            .from("topics")
            .insert({ group_id: groupId, topic_id: topic.topic_id, title: topic.title })
            .select()
        );
        if (inserted[0]) topicRows.set(topic.topic_id, inserted[0]);
      }
    }
  }

  // 2. Videos — one pass over the history, bucketed into topics as we go.
  const existingEpisodes = rows(
    await db().from("episodes").select("id, message_id").eq("group_id", groupId)
  );
  const knownMessageIds = new Set(
    existingEpisodes.filter((e) => e.message_id).map((e) => String(e.message_id))
  );

  const newEpisodes = [];
  let seen = 0;

  for await (const message of client.iterMessages(entity, { limit: messageLimit })) {
    seen += 1;
    const info = videoInfo(message);
    if (!info) continue;
    if (knownMessageIds.has(String(message.id))) continue;

    const topicKey = topicIdOf(message);
    const topicRow = topicKey ? topicRows.get(String(topicKey)) : null;
    const caption = message.message || "";

    newEpisodes.push({
      group_id: groupId,
      topic_id: topicRow ? topicRow.id : null,
      message_id: String(message.id),
      ep_number: parseEpNumber(caption, info.fileName),
      title: caption.split("\n")[0].slice(0, 200) || null,
      file_name: info.fileName,
      file_size: info.fileSize,
      duration: info.duration,
      status: "pending",
    });
    knownMessageIds.add(String(message.id));
  }

  for (let i = 0; i < newEpisodes.length; i += 200) {
    const chunk = newEpisodes.slice(i, i + 200);
    const result = await db().from("episodes").insert(chunk);
    if (result.error) throw new Error(result.error.message);
  }

  // 3. Counters the UI reads off the group and topic rows.
  const allEpisodes = rows(
    await db().from("episodes").select("id, topic_id, status").eq("group_id", groupId)
  );
  await db()
    .from("groups")
    .update({
      is_forum: isForum,
      title: entity.title || group.title,
      username: entity.username ?? null,
      total_episodes: allEpisodes.length,
      downloaded_episodes: allEpisodes.filter((e) => e.status === "completed").length,
      last_scanned_at: nowIso(),
    })
    .eq("id", groupId);

  for (const topic of topicRows.values()) {
    const inTopic = allEpisodes.filter((e) => e.topic_id === topic.id);
    await db()
      .from("topics")
      .update({
        total_episodes: inTopic.length,
        downloaded_episodes: inTopic.filter((e) => e.status === "completed").length,
      })
      .eq("id", topic.id);
  }

  return {
    success: true,
    messages_scanned: seen,
    topics: topicRows.size,
    new_episodes: newEpisodes.length,
    total_episodes: allEpisodes.length,
  };
}
