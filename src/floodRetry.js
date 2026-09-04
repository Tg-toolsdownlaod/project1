/**
 * Honors Telegram's own rate limit instead of giving up on it.
 *
 * FLOOD_WAIT is not a bug and not something any client library can bypass --
 * it is Telegram's server telling this account "wait exactly N seconds before
 * calling this method again." Every Telegram client, official app included,
 * is bound by the same rule. Treating it as a normal failure (mark the item
 * failed, move on) is what makes downloads or forwards look incomplete when
 * really they just needed to wait.
 *
 * This waits out the reported time and retries, up to a generous cap, so a
 * download or forward that hits a flood wait finishes on its own instead of
 * requiring a manual retry.
 */
const MAX_ATTEMPTS = 6;
// A safety net only: if Telegram ever asked for something absurd (an
// account-level restriction, not a per-call throttle), stop compounding waits.
const MAX_SINGLE_WAIT_SECONDS = 15 * 60;

function floodWaitSeconds(err) {
  if (typeof err?.seconds === "number") return err.seconds;
  const match = /FLOOD_WAIT_(\d+)/.exec(String(err?.errorMessage ?? err?.message ?? ""));
  return match ? Number(match[1]) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying only on FLOOD_WAIT and only for the exact time
 * requested (+1s buffer). Any other error is thrown straight through --
 * this is not a general retry loop, just the one Telegram explicitly asks for.
 */
export async function withFloodRetry(fn, { label, onWait } = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const seconds = floodWaitSeconds(err);
      if (seconds === null || attempt === MAX_ATTEMPTS || seconds > MAX_SINGLE_WAIT_SECONDS) {
        throw err;
      }
      onWait?.(seconds, attempt);
      console.warn(
        `${label ?? "Telegram call"}: flood wait ${seconds}s (attempt ${attempt}/${MAX_ATTEMPTS}), waiting it out`
      );
      await sleep((seconds + 1) * 1000);
    }
  }
  // Unreachable — the loop always returns or throws.
  throw new Error("withFloodRetry: exhausted attempts without a result.");
}
