/**
 * Telegram's Takeout API: an official mode meant for bulk export that relaxes
 * the flood limits on reading message history and downloading files.
 *
 * This is not a drop-in speed boost. Starting a session for the first time
 * makes Telegram notify the account's other signed-in devices and wait for a
 * confirmation there; if nothing confirms it within Telegram's own window, it
 * refuses with TAKEOUT_INIT_DELAY_<seconds> and the account has to wait that
 * long before trying again. Once a session is confirmed and active, every
 * subsequent request from this process is wrapped in it automatically (see
 * below) until it's stopped.
 */
import { Api } from "teleproto";

import { getClient } from "./telegram.js";

let activeTakeoutId = null;
let originalInvoke = null;

export function isTakeoutActive() {
  return activeTakeoutId !== null;
}

/**
 * Starts a session and, on success, transparently wraps every future
 * `client.invoke(...)` call in `InvokeWithTakeout` -- so downloads, scans and
 * forwards all pick up the relaxed limits without each of them needing to
 * know a takeout session exists.
 */
export async function startTakeoutSession() {
  if (activeTakeoutId) return { success: true, already_active: true };

  const client = await getClient();
  let takeout;
  try {
    takeout = await client.invoke(
      new Api.account.InitTakeoutSession({
        files: true,
        messageMegagroups: true,
        messageChannels: true,
      })
    );
  } catch (err) {
    const waitMatch = /TAKEOUT_INIT_DELAY_(\d+)/.exec(String(err?.errorMessage ?? err?.message ?? ""));
    if (waitMatch) {
      const hours = Math.ceil(Number(waitMatch[1]) / 3600);
      throw new Error(
        `Telegram needs this confirmed from another signed-in device (check your phone for a prompt), ` +
          `or the account has to wait about ${hours}h before a takeout session can start.`
      );
    }
    throw err;
  }

  activeTakeoutId = takeout.id;
  originalInvoke = client.invoke.bind(client);
  client.invoke = (request, dcId) => {
    if (!activeTakeoutId) return originalInvoke(request, dcId);
    return originalInvoke(new Api.InvokeWithTakeout({ takeoutId: activeTakeoutId, query: request }), dcId);
  };

  return { success: true, takeout_id: String(activeTakeoutId) };
}

/** Restores plain invokes and tells Telegram the session is done. */
export async function stopTakeoutSession(success = true) {
  if (!activeTakeoutId) return { success: true, was_active: false };

  const client = await getClient();
  if (originalInvoke) client.invoke = originalInvoke; // unwrap before the finish call itself
  try {
    await client.invoke(new Api.account.FinishTakeoutSession({ success }));
  } finally {
    activeTakeoutId = null;
    originalInvoke = null;
  }
  return { success: true, was_active: true };
}
