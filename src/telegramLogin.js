/**
 * "Log in with Telegram" on the sign-in screen. Telegram is not one of
 * Supabase's built-in OAuth providers, so this bridges the two by hand:
 * verify the signed payload the Telegram Login Widget hands back, then
 * mint a one-time Supabase token the frontend exchanges for a real session.
 *
 * Unrelated to telegram.js's userbot session -- that needs a phone number and
 * a full MTProto login; this needs only a lightweight Bot API bot created
 * with @BotFather purely to prove "this browser really is that Telegram
 * account," via TELEGRAM_LOGIN_BOT_TOKEN.
 */
import crypto from "node:crypto";

import { config } from "./config.js";
import { db, nowIso, rows } from "./db.js";

/** https://core.telegram.org/widgets/login#checking-authorization */
function verifyPayload(payload) {
  const { hash, ...fields } = payload ?? {};
  if (!payload?.id || !hash) {
    throw new Error("That does not look like a Telegram login payload.");
  }
  if (!config.telegramLoginBotToken) {
    throw new Error("TELEGRAM_LOGIN_BOT_TOKEN is not configured on the server.");
  }

  const dataCheckString = Object.keys(fields)
    .filter((key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== "")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(config.telegramLoginBotToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Constant-time compare -- this is a security boundary, not just a check.
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(String(hash), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Telegram signature did not match.");
  }

  const ageSeconds = Date.now() / 1000 - Number(fields.auth_date || 0);
  if (!Number.isFinite(ageSeconds) || ageSeconds > 86400 || ageSeconds < -60) {
    throw new Error("This Telegram login has expired -- please try again.");
  }
}

/** A stable, private-namespace email so each Telegram account maps to exactly one Supabase user. */
const emailFor = (telegramId) => `telegram-${telegramId}@users.kh-telegram-download.local`;

/**
 * Verifies a Telegram Login Widget payload and returns a one-time token the
 * frontend exchanges for a session via supabase.auth.verifyOtp({token_hash,
 * type: 'magiclink'}) -- creating the Supabase account on first login.
 */
export async function signInWithTelegram(payload) {
  verifyPayload(payload);
  const telegramId = String(payload.id);

  const identity = rows(
    await db().from("telegram_identities").select("user_id").eq("telegram_id", telegramId).limit(1)
  )[0];

  let email;
  if (identity) {
    const { data, error } = await db().auth.admin.getUserById(identity.user_id);
    if (error || !data?.user) throw new Error("Could not find the account linked to this Telegram login.");
    email = data.user.email;
  } else {
    email = emailFor(telegramId);
    const { data: created, error } = await db().auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        telegram_id: telegramId,
        telegram_username: payload.username || null,
        telegram_first_name: payload.first_name || null,
        telegram_last_name: payload.last_name || null,
        telegram_photo_url: payload.photo_url || null,
      },
    });
    if (error) throw new Error(error.message);
    rows(
      await db()
        .from("telegram_identities")
        .insert({
          telegram_id: telegramId,
          user_id: created.user.id,
          username: payload.username || null,
          first_name: payload.first_name || null,
          last_name: payload.last_name || null,
          photo_url: payload.photo_url || null,
          created_at: nowIso(),
        })
        .select("telegram_id")
    );
  }

  const { data: link, error: linkError } = await db().auth.admin.generateLink({ type: "magiclink", email });
  if (linkError) throw new Error(linkError.message);

  const tokenHash = link?.properties?.hashed_token;
  if (!tokenHash) throw new Error("Could not issue a sign-in token.");

  return { email, token_hash: tokenHash };
}
