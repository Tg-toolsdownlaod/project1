/**
 * ADD THIS ROUTE TO YOUR RAILWAY BACKEND (the Node service at
 * VITE_TELEGRAM_BACKEND_URL, separate repo from this frontend).
 *
 * The new "Add Group" screen now calls POST /api/telegram/groups/resolve
 * with { chat_id } as soon as the user types an ID, expecting back the
 * real group name (and forum topics, if any) so it can show a live
 * "Connected ✓ <Group Name>" preview before the group is saved.
 *
 * This example assumes your backend already holds an active GramJS
 * `TelegramClient` session (the same one used by your existing
 * /api/telegram/groups/:id/scan route) — reuse that client here.
 */

const { Api } = require('telegram');

// POST /api/telegram/groups/resolve
app.post('/api/telegram/groups/resolve', requireApiKey, async (req, res) => {
  const { chat_id } = req.body || {};
  if (!chat_id) {
    return res.status(400).json({ success: false, error: 'chat_id is required' });
  }

  try {
    const client = getUserbotClient(); // however you access your connected GramJS client
    if (!client || !client.connected) {
      return res.status(400).json({ success: false, error: 'Telegram userbot is not connected.' });
    }

    // GramJS accepts numeric chat ids (e.g. -100xxxxxxxxxx) or @usernames directly.
    const entity = await client.getEntity(chat_id.trim());

    const isChannelOrChat = entity.className === 'Channel' || entity.className === 'Chat';
    if (!isChannelOrChat) {
      return res.status(400).json({ success: false, error: 'That ID does not belong to a group or channel.' });
    }

    const fullChat = await client.invoke(
      new Api.channels.GetFullChannel({ channel: entity })
    ).catch(() => null);

    const isForum = !!entity.forum;
    let topics = [];

    if (isForum) {
      try {
        const forumTopics = await client.invoke(
          new Api.channels.GetForumTopics({
            channel: entity,
            offsetDate: 0,
            offsetId: 0,
            offsetTopic: 0,
            limit: 100,
          })
        );
        topics = (forumTopics.topics || [])
          .filter((t) => t.className === 'ForumTopic')
          .map((t) => ({ topic_id: String(t.id), title: t.title }));
      } catch (topicErr) {
        console.warn('Could not fetch forum topics during resolve:', topicErr.message);
      }
    }

    return res.json({
      success: true,
      title: entity.title || entity.firstName || 'Untitled',
      username: entity.username || null,
      is_forum: isForum,
      participants_count: fullChat?.fullChat?.participantsCount ?? undefined,
      topics,
    });
  } catch (err) {
    console.error('resolve error:', err);
    return res.status(404).json({
      success: false,
      error: 'Could not find or access this group with the connected account. Check the Chat ID and make sure the userbot account is a member.',
    });
  }
});
