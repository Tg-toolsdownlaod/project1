/**
 * Payment review + subscription granting. Every write here goes through
 * db() (the service-role client), which is what actually keeps a viewer
 * from granting themselves a subscription -- not the RLS policies on
 * subscriptions/payment_submissions, which deliberately give a plain
 * authenticated user no write access to either table at all (see the
 * migration's comments).
 */
import { db, nowIso, rows } from "./db.js";
import { notifyAdminOfAutoApproval, notifyAdminOfSubmission } from "./notifyBot.js";

async function tierRow(key) {
  const found = rows(await db().from("pricing_tiers").select("*").eq("key", key).limit(1));
  if (!found[0]) throw new Error(`Unknown pricing tier "${key}".`);
  return found[0];
}

/** Creates a pending payment claim for the caller and DMs the operator. */
export async function createSubmission({ userId, email, tierKey }) {
  const tier = await tierRow(tierKey);
  const inserted = rows(
    await db()
      .from("payment_submissions")
      .insert({ user_id: userId, email, tier: tierKey, amount: tier.price, status: "pending" })
      .select()
  )[0];
  await notifyAdminOfSubmission(inserted, tier.label_en);
  return inserted;
}

/** Attaches a screenshot to the caller's own pending claim and re-notifies the operator. */
export async function attachScreenshot({ userId, submissionId, screenshotUrl }) {
  const submission = await ownedPendingSubmission(userId, submissionId);
  const tier = await tierRow(submission.tier);
  const updated = rows(
    await db()
      .from("payment_submissions")
      .update({ screenshot_url: screenshotUrl })
      .eq("id", submissionId)
      .select()
  )[0];
  await notifyAdminOfSubmission(updated, tier.label_en);
  return updated;
}

/** Lets the caller abandon their own still-pending claim (e.g. switching plans). */
export async function cancelSubmission({ userId, submissionId }) {
  await ownedPendingSubmission(userId, submissionId);
  await db()
    .from("payment_submissions")
    .update({ status: "rejected", admin_note: "cancelled by subscriber", reviewed_at: nowIso() })
    .eq("id", submissionId);
}

async function ownedPendingSubmission(userId, submissionId) {
  const found = rows(
    await db().from("payment_submissions").select("*").eq("id", submissionId).limit(1)
  )[0];
  if (!found || found.user_id !== userId) throw new Error("No such payment claim.");
  if (found.status !== "pending") throw new Error(`This claim is already ${found.status}.`);
  return found;
}

/**
 * Grants (or extends) a subscription from an approved payment. A still-live
 * subscription extends from its own expiry, not from now, so paying early
 * never costs the days already owned -- same reasoning the reference
 * project used for its own day-based renewal math.
 */
async function grantFromSubmission(submission, { note } = {}) {
  const tier = await tierRow(submission.tier);
  const existing = rows(
    await db().from("subscriptions").select("expires_at").eq("user_id", submission.user_id).limit(1)
  )[0];
  const base = existing?.expires_at && new Date(existing.expires_at) > new Date()
    ? new Date(existing.expires_at)
    : new Date();
  base.setDate(base.getDate() + tier.months * 30);

  await db()
    .from("subscriptions")
    .upsert({
      user_id: submission.user_id,
      email: submission.email,
      tier: tier.key,
      capability: tier.capability,
      expires_at: base.toISOString(),
      updated_at: nowIso(),
    });
  await db()
    .from("payment_submissions")
    .update({ status: "approved", reviewed_at: nowIso(), admin_note: note ?? null })
    .eq("id", submission.id);

  return { expiresAt: base.toISOString(), tier };
}

/** The operator (Telegram button or Admin Panel) approves a pending claim. */
export async function approveSubmission(submissionId) {
  const submission = await pendingSubmissionById(submissionId);
  return grantFromSubmission(submission);
}

/** The operator (Telegram button or Admin Panel) rejects a pending claim. */
export async function rejectSubmission(submissionId, note) {
  const submission = await pendingSubmissionById(submissionId);
  await db()
    .from("payment_submissions")
    .update({ status: "rejected", reviewed_at: nowIso(), admin_note: note ?? null })
    .eq("id", submissionId);
  return submission;
}

async function pendingSubmissionById(submissionId) {
  const found = rows(
    await db().from("payment_submissions").select("*").eq("id", submissionId).limit(1)
  )[0];
  if (!found) throw new Error("Submission not found.");
  if (found.status !== "pending") throw new Error(`Already ${found.status}.`);
  return found;
}

// Amounts ABA's own notification text writes as e.g. "$5.00" or "5.00 USD".
const AMOUNT_PATTERN = /\$?\s*([\d,]+\.\d{2})\s*(?:USD|usd)?/;

/**
 * Matches a raw ABA payment-notification string (forwarded by a phone
 * automation app -- see /api/subscription/aba-ingest) to a pending claim
 * and grants it immediately, with no operator action needed. Deliberately
 * strict: the merchant name must appear verbatim (so a notification for a
 * different account can't be replayed here) and the amount must match a
 * pending claim exactly -- ambiguous matches (more than one pending claim
 * at the same price) are left for the operator rather than guessed at.
 */
export async function matchAbaNotification(text, merchantName) {
  const body = String(text ?? "");
  if (!merchantName || !body.includes(merchantName)) {
    return { matched: false, reason: "merchant_name_absent" };
  }
  const amountMatch = AMOUNT_PATTERN.exec(body);
  if (!amountMatch) return { matched: false, reason: "no_amount" };
  const amount = Number.parseFloat(amountMatch[1].replace(/,/g, ""));

  const pending = rows(
    await db()
      .from("payment_submissions")
      .select("*")
      .eq("status", "pending")
      .eq("amount", amount)
      .order("submitted_at", { ascending: true })
  );
  if (pending.length === 0) return { matched: false, reason: "no_pending_row" };
  if (pending.length > 1) return { matched: false, reason: "ambiguous" };

  const submission = pending[0];
  const trxMatch = /Trx\.?\s*ID[:\s]*([A-Za-z0-9]+)/i.exec(body);
  if (trxMatch) {
    await db().from("payment_submissions").update({ aba_trx_id: trxMatch[1] }).eq("id", submission.id);
  }
  const { expiresAt, tier } = await grantFromSubmission(submission, { note: "ABA auto-confirmed" });
  await notifyAdminOfAutoApproval(submission, tier.label_en);
  return { matched: true, submissionId: submission.id, expiresAt };
}

/** What the app needs to answer "am I subscribed, to what, until when". */
export async function subscriptionStatus(userId) {
  const found = rows(
    await db().from("subscriptions").select("*").eq("user_id", userId).limit(1)
  )[0];
  if (!found?.expires_at) return { subscribed: false, tier: null, capability: null, expiresAt: null };
  return {
    subscribed: new Date(found.expires_at) > new Date(),
    tier: found.tier,
    capability: found.capability,
    expiresAt: found.expires_at,
  };
}

