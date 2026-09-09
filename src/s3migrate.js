/**
 * One-time migration: streams every object from the source S3-compatible
 * bucket (S3_* env vars, see s3source.js) straight into R2, then deletes it
 * from the source once the copy in R2 is confirmed. Each object's bytes pass
 * through this process exactly once -- GetObject's body is piped directly
 * into R2's multipart Upload, so nothing is ever staged on disk or held
 * whole in memory, no matter how large the video is.
 *
 * Safe to re-run: an object already present in R2 with a matching size is
 * skipped (and still deleted from the source if deleteSource is set), so an
 * interrupted run just picks up where it left off.
 */
import * as r2 from "./r2.js";
import * as s3 from "./s3source.js";

let state = idleState();

function idleState() {
  return {
    running: false,
    dryRun: true,
    prefix: "",
    startedAt: null,
    finishedAt: null,
    total: 0,
    scanned: 0,
    migrated: 0,
    skipped: 0,
    deleted: 0,
    failed: 0,
    bytes: 0,
    errors: [],
  };
}

/** A snapshot of the current or most recent run, safe to poll from the UI. */
export function status() {
  return { ...state, errors: state.errors.slice(-20) };
}

/**
 * Runs the migration to completion. Throws if one is already running --
 * callers that want a background job should fire-and-forget this and poll
 * status() instead of awaiting it.
 */
export async function run({ prefix = "", dryRun = true, deleteSource = true, concurrency = 2 } = {}) {
  if (state.running) throw new Error("A migration is already running.");
  state = { ...idleState(), running: true, dryRun, prefix, startedAt: new Date().toISOString() };

  try {
    const objects = await s3.listObjects(prefix);
    state.total = objects.length;

    let next = 0;
    const worker = async () => {
      while (next < objects.length) {
        const obj = objects[next++];
        await migrateOne(obj, { dryRun, deleteSource });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

async function migrateOne(obj, { dryRun, deleteSource }) {
  state.scanned += 1;
  try {
    const existing = await r2.headObject(obj.key);
    if (existing.exists && existing.size === obj.size) {
      state.skipped += 1;
      if (!dryRun && deleteSource) {
        await s3.deleteObject(obj.key);
        state.deleted += 1;
      }
      return;
    }

    if (dryRun) return;

    const { body, contentType } = await s3.getObject(obj.key);
    await r2.uploadBody(body, obj.key, contentType);

    // Trust nothing but R2's own account of what it now holds.
    const uploaded = await r2.headObject(obj.key);
    if (!uploaded.exists || (obj.size > 0 && uploaded.size !== obj.size)) {
      throw new Error(`Size mismatch after upload (source ${obj.size}, R2 ${uploaded.size}).`);
    }

    state.migrated += 1;
    state.bytes += obj.size;

    if (deleteSource) {
      await s3.deleteObject(obj.key);
      state.deleted += 1;
    }
  } catch (err) {
    state.failed += 1;
    state.errors.push({ key: obj.key, error: String(err?.message ?? err).slice(0, 300) });
  }
}
