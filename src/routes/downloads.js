import { Router } from 'express';
import { getActiveClient, resolveEntityByChatId } from '../telegramClient.js';
import { uploadToR2 } from '../r2.js';
import { supabase } from '../supabase.js';

export const downloadsRouter = Router();

/** Starts a background download for an episode. Used by the manual API
 * route below and by the auto-download poller (autoDownload.js). */
export async function queueDownload(episodeId) {
  const { data: episode, error: epErr } = await supabase.from('episodes').select('*, groups(*)').eq('id', episodeId).maybeSingle();
  if (epErr || !episode) throw new Error('Episode not found.');

  const { data: job } = await supabase
    .from('downloads')
    .insert({ episode_id: episodeId, status: 'downloading', started_at: new Date().toISOString() })
    .select()
    .maybeSingle();

  await supabase.from('episodes').update({ status: 'downloading' }).eq('id', episodeId);

  // Runs in the background; caller does not need to await the transfer.
  runDownload(episode, job?.id).catch(async (err) => {
    console.error('[download] failed:', err.message);
    await supabase.from('episodes').update({ status: 'failed' }).eq('id', episodeId);
    if (job?.id) {
      await supabase.from('downloads').update({ status: 'failed', error: err.message }).eq('id', job.id);
    }
  });

  return { download_id: job?.id };
}

/** POST /api/downloads/:episodeId/start — downloads from Telegram, uploads to R2. */
downloadsRouter.post('/:episodeId/start', async (req, res) => {
  try {
    const result = await queueDownload(req.params.episodeId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

async function runDownload(episode, jobId) {
  const client = await getActiveClient();
  const group = episode.groups;
  const entity = await resolveEntityByChatId(client, group.chat_id);
  const [message] = await client.getMessages(entity, { ids: [Number(episode.message_id)] });
  if (!message) throw new Error('Original Telegram message could not be found (it may have been deleted).');

  const totalBytes = Number(episode.file_size) || 0;
  let downloadedBytes = 0;

  const buffer = await client.downloadMedia(message, {
    progressCallback: (downloaded) => {
      downloadedBytes = Number(downloaded);
      if (jobId) {
        supabase
          .from('downloads')
          .update({
            progress: totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0,
            downloaded_bytes: downloadedBytes,
            total_bytes: totalBytes,
          })
          .eq('id', jobId)
          .then(() => {});
      }
    },
  });

  const safeTitle = (episode.title || episode.file_name || `episode-${episode.ep_number || episode.id}`)
    .replace(/[^a-z0-9._-]+/gi, '_')
    .slice(0, 120);
  const key = `${group.title.replace(/[^a-z0-9._-]+/gi, '_')}/${safeTitle}.mp4`;

  const { url } = await uploadToR2(key, buffer, 'video/mp4');

  await supabase.from('episodes').update({ status: 'completed', r2_key: key }).eq('id', episode.id);
  if (jobId) {
    await supabase
      .from('downloads')
      .update({
        status: 'completed',
        progress: 100,
        r2_key: key,
        r2_url: url,
        completed_at: new Date().toISOString(),
        downloaded_bytes: totalBytes,
        total_bytes: totalBytes,
      })
      .eq('id', jobId);
  }
}
