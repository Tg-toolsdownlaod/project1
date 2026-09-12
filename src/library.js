/**
 * Files a video uploaded by hand through the control panel as an episode --
 * the same table Telegram downloads land in -- so both sources show up
 * together in Groups/Downloads, grouped by show and sorted by episode
 * number automatically instead of only existing as a bucket key.
 */
import { db, nowIso, rows } from "./db.js";

/** Marks a group as manual so it is never mistaken for a real Telegram chat. */
const manualChatId = (title) => `manual:${title.toLowerCase()}`;

export async function recordManualUpload({
  show,
  season,
  episodeNumber,
  label,
  key,
  url,
  size,
  fileName,
}) {
  const groupTitle = (show || "").trim() || "Manual uploads";
  const group = await findOrCreateGroup(groupTitle);
  const topic = season && season.trim() ? await findOrCreateTopic(group.id, season.trim()) : null;

  const title =
    label && label.trim() ? label.trim() : episodeNumber != null ? `Episode ${episodeNumber}` : fileName;

  const existingId = await findExistingEpisodeId(group.id, topic?.id ?? null, episodeNumber, key);

  const row = {
    group_id: group.id,
    topic_id: topic?.id ?? null,
    ep_number: episodeNumber,
    title,
    file_name: fileName,
    file_size: size ?? 0,
    status: "completed",
    r2_key: key,
    r2_url: url,
    updated_at: nowIso(),
  };

  if (existingId) {
    rows(await db().from("episodes").update(row).eq("id", existingId).select("id"));
  } else {
    rows(await db().from("episodes").insert(row).select("id"));
  }
}

async function findExistingEpisodeId(groupId, topicId, episodeNumber, key) {
  let query = db().from("episodes").select("id").eq("group_id", groupId);
  query = topicId ? query.eq("topic_id", topicId) : query.is("topic_id", null);
  query = episodeNumber != null ? query.eq("ep_number", episodeNumber) : query.eq("r2_key", key);
  const found = rows(await query.limit(1));
  return found[0]?.id ?? null;
}

async function findOrCreateGroup(title) {
  const found = rows(await db().from("groups").select("*").ilike("title", title).limit(1));
  if (found.length) return found[0];
  const created = rows(
    await db()
      .from("groups")
      .insert({ chat_id: manualChatId(title), title, is_forum: false, active: true })
      .select()
  );
  return created[0];
}

async function findOrCreateTopic(groupId, title) {
  const found = rows(
    await db().from("topics").select("*").eq("group_id", groupId).ilike("title", title).limit(1)
  );
  if (found.length) return found[0];
  const created = rows(
    await db().from("topics").insert({ group_id: groupId, title, active: true }).select()
  );
  return created[0];
}
