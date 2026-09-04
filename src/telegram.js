/** Telegram userbot (teleproto, the maintained GramJS fork): one shared
 * client, plus the interactive login flow. */
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

import { config } from "./config.js";
import { nowIso, telegramSettings, upsertSingle } from "./db.js";

let client = null;
// Held between /send-code and /verify-code.
const pending = {};

export async function getClient({ requireAuth = true } = {}) {
  if (!client) {
    const conf = await telegramSettings();
    if (!conf.apiId || !conf.apiHash) {
      throw new Error("Telegram api_id/api_hash are not set.");
    }
    client = new TelegramClient(
      new StringSession(conf.sessionString || ""),
      Number(conf.apiId),
      conf.apiHash,
      {
        connectionRetries: 5,
        // teleproto sleeps out any FLOOD_WAIT at or under this threshold
        // automatically, for every API call -- not just the ones
        // floodRetry.js wraps. Its own default is 60s; config.js raises it.
        floodSleepThreshold: config.floodSleepThresholdSeconds,
        // 0 (the default) leaves teleproto's own auto-scaling in place, which
        // already opens up to 8 parallel connections per download and grows
        // the transfer window on its own -- see config.js for why this is
        // opt-in rather than always maxed out.
        ...(config.maxDownloadSessions > 0
          ? { downloadPool: { maxSessions: config.maxDownloadSessions } }
          : {}),
      }
    );
  }
  if (!client.connected) await client.connect();

  if (requireAuth && !(await client.isUserAuthorized())) {
    throw new Error("The userbot is not signed in yet.");
  }
  return client;
}

export async function isAuthorized() {
  try {
    const c = await getClient({ requireAuth: false });
    return await c.isUserAuthorized();
  } catch {
    return false;
  }
}

/** Starts the login by asking Telegram to send the confirmation code. */
export async function sendCode() {
  const conf = await telegramSettings();
  if (!conf.phone) throw new Error("No phone number is configured.");

  const c = await getClient({ requireAuth: false });
  const { phoneCodeHash } = await c.sendCode(
    { apiId: Number(conf.apiId), apiHash: conf.apiHash },
    conf.phone
  );
  pending.phone = conf.phone;
  pending.phoneCodeHash = phoneCodeHash;
  return { success: true, phone: conf.phone };
}

/** Completes the login, asking for the 2FA password when Telegram wants one. */
export async function verifyCode(code, password) {
  const conf = await telegramSettings();
  const c = await getClient({ requireAuth: false });
  const phone = pending.phone || conf.phone;

  try {
    if (password) {
      await c.signInWithPassword(
        { apiId: Number(conf.apiId), apiHash: conf.apiHash },
        {
          password: async () => password,
          onError: (err) => {
            throw err;
          },
        }
      );
    } else {
      await c.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: code,
        })
      );
    }
  } catch (err) {
    if (String(err?.errorMessage || err?.message).includes("SESSION_PASSWORD_NEEDED")) {
      return { success: true, needsPassword: true };
    }
    throw err;
  }

  const me = await c.getMe();
  const sessionString = c.session.save();
  await upsertSingle("telegram_settings", {
    session_string: sessionString,
    connected: true,
    last_connected_at: nowIso(),
    account_first_name: me.firstName ?? null,
    account_last_name: me.lastName ?? null,
    account_username: me.username ?? null,
    account_user_id: String(me.id),
  });
  delete pending.phone;
  delete pending.phoneCodeHash;

  return {
    success: true,
    needsPassword: false,
    session_string: sessionString,
    account: { id: String(me.id), username: me.username, first_name: me.firstName },
  };
}

/** Signs the userbot out and clears the stored session. */
export async function logout() {
  const c = await getClient({ requireAuth: false });
  try {
    await c.invoke(new Api.auth.LogOut());
  } finally {
    await c.disconnect().catch(() => {});
    client = null;
    await upsertSingle("telegram_settings", {
      session_string: null,
      connected: false,
      account_first_name: null,
      account_last_name: null,
      account_username: null,
      account_user_id: null,
    });
  }
  return { success: true };
}

// Matches t.me and telegram.me links with or without a scheme/www.
const TME_HOST = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i;

/**
 * Extracts a chat identifier -- and a message id, when the link points at one
 * specific message -- from any form Telegram hands out: a bare "-100...", a
 * "@name", "t.me/name", "t.me/name/42", "t.me/c/<internal id>[/42]" (a
 * private chat with no username), or a "tg://resolve" / "tg://privatepost"
 * deep link. The message id is not used everywhere yet, but callers that only
 * need the chat can keep calling {@link normalizeChatId}.
 */
export function parseTelegramLink(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("A chat ID is required.");

  if (/^tg:\/\/resolve/i.test(value)) {
    const params = new URL(value.replace(/^tg:\/\//i, "https://tg/")).searchParams;
    const domain = params.get("domain");
    if (!domain) throw new Error("This tg:// link has no domain.");
    const post = params.get("post");
    return { chatId: `@${domain}`, messageId: post ? Number(post) : null };
  }

  if (/^tg:\/\/privatepost/i.test(value)) {
    const params = new URL(value.replace(/^tg:\/\//i, "https://tg/")).searchParams;
    const channel = params.get("channel");
    if (!channel) throw new Error("This tg:// link has no channel id.");
    const post = params.get("post");
    return { chatId: Number(`-100${channel}`), messageId: post ? Number(post) : null };
  }

  if (TME_HOST.test(value)) {
    const path = value.replace(TME_HOST, "").replace(/^\/+/, "");

    if (/^\+|^joinchat\//.test(path)) {
      throw new Error('This is an invite link — use "Invite link" to join it first, not a chat ID.');
    }

    // t.me/c/<internal id>[/<message id>] -- a private chat with no username.
    const privateMatch = path.match(/^c\/(\d+)(?:\/(\d+))?/);
    if (privateMatch) {
      return {
        chatId: Number(`-100${privateMatch[1]}`),
        messageId: privateMatch[2] ? Number(privateMatch[2]) : null,
      };
    }

    // t.me/<username>[/<message id>]
    const publicMatch = path.match(/^([A-Za-z0-9_]+)(?:\/(\d+))?/);
    if (publicMatch) {
      return {
        chatId: `@${publicMatch[1]}`,
        messageId: publicMatch[2] ? Number(publicMatch[2]) : null,
      };
    }

    throw new Error("Could not read a chat from this t.me link.");
  }

  if (value.startsWith("@")) return { chatId: value, messageId: null };
  if (/^-?\d+$/.test(value)) return { chatId: Number(value), messageId: null };

  // A bare username with neither an "@" nor a link wrapper.
  return { chatId: `@${value}`, messageId: null };
}

/** Accepts -100..., a bare id, @name, a t.me link or a tg:// deep link. */
export function normalizeChatId(chatId) {
  return parseTelegramLink(chatId).chatId;
}

/** Reads the forum topics of a group, paging until Telegram stops sending more. */
export async function listTopics(entity) {
  const c = await getClient();
  const found = [];
  let offsetTopic = 0;
  let offsetId = 0;
  let offsetDate = 0;

  for (;;) {
    const result = await c.invoke(
      // Note: forum topics live under messages.*, not channels.*, in the
      // current TL schema -- channels.GetForumTopics no longer exists.
      new Api.messages.GetForumTopics({
        peer: entity,
        offsetDate,
        offsetId,
        offsetTopic,
        limit: 100,
      })
    );
    const batch = (result.topics ?? []).filter((t) => t.title);
    if (batch.length === 0) break;

    for (const topic of batch) {
      found.push({ topic_id: String(topic.id), title: topic.title });
    }
    if (batch.length < 100) break;

    offsetTopic = batch[batch.length - 1].id;
    const lastMessage = result.messages?.[result.messages.length - 1];
    offsetId = lastMessage?.id ?? 0;
    offsetDate = lastMessage?.date ?? 0;
  }

  return found;
}

/**
 * The groups and channels this account is already in, so a chat ID never has
 * to be copied by hand. Private chats and bots are left out — only places
 * videos can be scanned from.
 */
export async function listDialogs(limit = 200) {
  const c = await getClient();
  const dialogs = await c.getDialogs({ limit });

  return dialogs
    .filter((d) => d.isGroup || d.isChannel)
    .map((d) => ({
      chat_id: String(d.id),
      title: d.title || d.name || String(d.id),
      username: d.entity?.username ?? null,
      is_forum: Boolean(d.entity?.forum),
      participants_count: d.entity?.participantsCount ?? null,
    }));
}

/**
 * Joins a public @name or a t.me/+hash invite link, then describes what was
 * joined so the UI can add it straight away.
 */
export async function joinChat(invite) {
  const c = await getClient();
  const value = String(invite ?? "").trim();
  if (!value) throw new Error("An invite link or @username is required.");

  const hashMatch = value.match(/(?:joinchat\/|\+)([\w-]+)/);
  if (hashMatch) {
    try {
      await c.invoke(new Api.messages.ImportChatInvite({ hash: hashMatch[1] }));
    } catch (err) {
      // Already a member is a success for our purposes.
      if (!String(err?.errorMessage ?? "").includes("USER_ALREADY_PARTICIPANT")) throw err;
    }
    const check = await c.invoke(new Api.messages.CheckChatInvite({ hash: hashMatch[1] }));
    const chat = check.chat ?? check;
    const chatId = chat?.id ? String(chat.id) : "";
    return { ...(await describeGroup(chatId || value)), chat_id: chatId };
  }

  const username = value.startsWith("@") ? value : `@${value.split("/").pop()}`;
  const entity = await c.getEntity(username);
  await c.invoke(new Api.channels.JoinChannel({ channel: entity })).catch((err) => {
    if (!String(err?.errorMessage ?? "").includes("USER_ALREADY_PARTICIPANT")) throw err;
  });
  return { ...(await describeGroup(username)), chat_id: String(entity.id) };
}

/**
 * Sends a note to the account's own Saved Messages — used to report that a
 * batch finished without needing push notifications or email.
 */
export async function notifySelf(text) {
  const c = await getClient();
  await c.sendMessage("me", { message: String(text ?? "").slice(0, 4000) });
  return { success: true };
}

/** Everything the Add/Forward dialogs show before anything is written. */
export async function describeGroup(chatId) {
  const c = await getClient();
  const entity = await c.getEntity(normalizeChatId(chatId));
  const isForum = Boolean(entity.forum);

  let participants = null;
  try {
    const full = await c.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    participants = full.fullChat?.participantsCount ?? null;
  } catch {
    participants = null;
  }

  return {
    success: true,
    title: entity.title || entity.username || String(chatId),
    username: entity.username ?? null,
    is_forum: isForum,
    participants_count: participants,
    topics: isForum ? await listTopics(entity) : [],
  };
}
