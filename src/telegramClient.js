import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { getTelegramSettings, upsertTelegramSettings } from './supabase.js';

// Single-tenant app: one userbot connection lives in memory for the life
// of this process. `pending` holds state between /send-code and /verify-code.
let client = null;
let pending = null; // { phoneCodeHash, phoneNumber, apiId, apiHash }

function buildClient(apiId, apiHash, sessionString = '') {
  return new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, {
    connectionRetries: 5,
  });
}

/** Reconnects using a saved session, if one exists. Call this on server boot. */
export async function restoreSessionOnBoot() {
  try {
    const settings = await getTelegramSettings();
    if (settings?.session_string && settings?.api_id && settings?.api_hash) {
      client = buildClient(settings.api_id, settings.api_hash, settings.session_string);
      await client.connect();
      const authorized = await client.isUserAuthorized().catch(() => false);
      if (!authorized) {
        console.warn('[telegram] Saved session is no longer authorized.');
        client = null;
      } else {
        console.log('[telegram] Restored existing userbot session.');
      }
    }
  } catch (err) {
    console.error('[telegram] Failed to restore session:', err.message);
  }
}

/** Returns a connected, authorized client or throws. */
export async function getActiveClient() {
  if (client && client.connected) return client;
  const settings = await getTelegramSettings();
  if (!settings?.session_string || !settings?.api_id || !settings?.api_hash) {
    throw new Error('Telegram userbot is not connected yet.');
  }
  client = buildClient(settings.api_id, settings.api_hash, settings.session_string);
  await client.connect();
  return client;
}

/**
 * Resolves a chat entity from its numeric chat_id (the format stored in
 * Supabase, e.g. "-1004468850700"). GramJS can only build an entity like
 * this if it already knows the chat's access hash, which it normally only
 * learns by seeing the chat in your dialog list. So: try the fast path
 * first, and if that fails, walk the dialog list once to find + cache it.
 */
export async function resolveEntityByChatId(client, chatIdStr) {
  try {
    return await client.getEntity(BigInt(chatIdStr));
  } catch {
    const dialogs = await client.getDialogs({ limit: 300 });
    const match = dialogs.find((d) => String(d.id) === String(chatIdStr));
    if (!match) {
      throw new Error(
        'Could not find this group in your Telegram account. Make sure your userbot account is actually a member of it.'
      );
    }
    return match.entity;
  }
}

export async function sendCode({ api_id, api_hash, phone }) {
  if (!api_id || !api_hash || !phone) {
    throw new Error('api_id, api_hash and phone are required.');
  }
  const c = buildClient(api_id, api_hash, '');
  await c.connect();
  const result = await c.sendCode({ apiId: Number(api_id), apiHash: api_hash }, phone);
  pending = { phoneCodeHash: result.phoneCodeHash, phoneNumber: phone, apiId: Number(api_id), apiHash: api_hash };
  client = c;
  return { success: true };
}

export async function verifyCode({ code, password }) {
  if (!pending || !client) {
    throw new Error('No pending login. Call send-code first.');
  }
  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phoneNumber,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    const needsPassword = err.errorMessage === 'SESSION_PASSWORD_NEEDED' || err.message?.includes('SESSION_PASSWORD_NEEDED');
    if (needsPassword) {
      if (!password) {
        return { success: true, needsPassword: true };
      }
      const passwordInfo = await client.invoke(new Api.account.GetPassword());
      const passwordSrpCheck = await computeCheck(passwordInfo, password);
      await client.invoke(new Api.auth.CheckPassword({ password: passwordSrpCheck }));
    } else {
      throw err;
    }
  }

  const sessionString = client.session.save();
  await upsertTelegramSettings({
    api_id: String(pending.apiId),
    api_hash: pending.apiHash,
    phone: pending.phoneNumber,
    session_string: sessionString,
    connected: true,
    last_connected_at: new Date().toISOString(),
  });
  pending = null;
  return { success: true, needsPassword: false };
}

export async function logout() {
  try {
    const c = await getActiveClient().catch(() => null);
    if (c) {
      await c.invoke(new Api.auth.LogOut()).catch(() => {});
      await c.destroy().catch(() => {});
    }
  } finally {
    client = null;
    pending = null;
    await upsertTelegramSettings({ connected: false, session_string: null });
  }
  return { success: true };
}
