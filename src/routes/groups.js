import { Router } from 'express';
import { Api } from 'telegram';
import { getActiveClient, resolveEntityByChatId } from '../telegramClient.js';
import { supabase } from '../supabase.js';

export const groupsRouter = Router();

function guessEpisodeNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:ep(?:isode)?\.?\s*)(\d{1,4})/i) || text.match(/\b(\d{1,4})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/** POST /api/groups/add  { username_or_link } — resolves a chat and stores it. */
groupsRouter.post('/add', async (req, res) => {
  try {
    const { username_or_link } = req.body;
    if (!username_or_link) throw new Error('username_or_link is required.');
    const client = await getActiveClient();
    const entity = await client.getEntity(username_or_link);
    const isForum = !!entity.forum;

    const { data, error } = await supabase
      .from('groups')
      .upsert(
        {
          chat_id: String(entity.id),
          title: entity.title || entity.username || String(entity.id),
          username: entity.username || null,
          is_forum: isForum,
          active: true,
        },
        { onConflict: 'chat_id' }
      )
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ success: true, group: data });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * Core scan logic, reused by the manual "Scan" button (below) and by the
 * auto-download poller (see autoDownload.js). Returns newly-inserted /
 * updated episode rows so callers can act on just the new ones.
 */
export async function scanGroupById(groupId) {
  const client = await getActiveClient();
  const { data: group, error: gErr } = await supabase.from('groups').select('*').eq('id', groupId).maybeSingle();
  if (gErr || !group) throw new Error('Group not found.');

  const entity = await resolveEntityByChatId(client, group.chat_id);

  let topics = [];
  if (group.is_forum) {
    const forumTopics = await client.invoke(
      new Api.channels.GetForumTopics({ channel: entity, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100 })
    );
    topics = forumTopics.topics.filter((t) => t.id !== 1);
    for (const t of topics) {
      await supabase.from('topics').upsert(
        { group_id: group.id, topic_id: String(t.id), title: t.title, active: true },
        { onConflict: 'group_id,topic_id' }
      );
    }
  }

  const messages = await client.getMessages(entity, { limit: 200 });
  const touchedEpisodes = [];
  for (const msg of messages) {
    const video = msg.video || (msg.document && msg.document.mimeType?.startsWith('video/') ? msg.document : null);
    if (!video) continue;
    const fileNameAttr = msg.document?.attributes?.find((a) => a.fileName)?.fileName;
    const caption = msg.message || fileNameAttr || '';
    const topicId = msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId || null;

    // Skip episodes we've already recorded so repeated scans don't reset
    // a completed/downloading episode back to "pending".
    const { data: existing } = await supabase
      .from('episodes')
      .select('id, status')
      .eq('group_id', group.id)
      .eq('message_id', String(msg.id))
      .maybeSingle();
    if (existing) continue;

    const { data: inserted } = await supabase
      .from('episodes')
      .upsert(
        {
          group_id: group.id,
          topic_id: topicId ? String(topicId) : null,
          message_id: String(msg.id),
          ep_number: guessEpisodeNumber(caption),
          title: caption?.slice(0, 200) || null,
          file_name: fileNameAttr || null,
          file_size: Number(msg.document?.size || 0),
          duration: video.attributes?.find((a) => a.duration)?.duration || 0,
          status: 'pending',
        },
        { onConflict: 'group_id,message_id' }
      )
      .select()
      .maybeSingle();
    if (inserted) touchedEpisodes.push(inserted);
  }

  const { count } = await supabase
    .from('episodes')
    .select('*', { count: 'exact', head: true })
    .eq('group_id', group.id);

  await supabase
    .from('groups')
    .update({ last_scanned_at: new Date().toISOString(), total_episodes: count || 0 })
    .eq('id', group.id);

  return { group, topics, newEpisodes: touchedEpisodes };
}

/** POST /api/groups/:id/scan — pulls topics + video messages into Supabase. */
groupsRouter.post('/:id/scan', async (req, res) => {
  try {
    const { topics, newEpisodes } = await scanGroupById(req.params.id);
    res.json({ success: true, topics: topics.length, episodes: newEpisodes.length });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});
