/**
 * One-off terminal login for the userbot.
 *
 * Signing in from a terminal avoids passing the code and 2FA password through
 * the web UI, and prints a session string you can paste into
 * TELEGRAM_SESSION_STRING so restarts do not need another login.
 *
 *   npm run login
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

import { telegramSettings, upsertSingle } from "./db.js";

const conf = await telegramSettings();
if (!conf.apiId || !conf.apiHash || !conf.phone) {
  console.error("Set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_PHONE first.");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const client = new TelegramClient(
  new StringSession(conf.sessionString || ""),
  Number(conf.apiId),
  conf.apiHash,
  { connectionRetries: 5 }
);

await client.start({
  phoneNumber: async () => conf.phone,
  phoneCode: async () => rl.question("Code Telegram sent you: "),
  password: async () => rl.question("2FA password (blank if none): "),
  onError: (err) => console.error(err),
});

const me = await client.getMe();
const sessionString = client.session.save();

console.log(`\nSigned in as ${me.firstName ?? ""} ${me.username ? `(@${me.username})` : ""}`);
console.log("\nPaste this into your .env as TELEGRAM_SESSION_STRING:\n");
console.log(sessionString);

const store = await rl.question("\nAlso store it in Supabase? [y/N] ");
if (store.trim().toLowerCase() === "y") {
  await upsertSingle("telegram_settings", { session_string: sessionString, connected: true });
  console.log("Stored. Note that anyone holding the anon key can then read it.");
}

rl.close();
await client.disconnect();
process.exit(0);
