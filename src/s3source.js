/**
 * Source S3-compatible bucket (e.g. Contabo, Backblaze, MinIO) helpers.
 * Two uses: browsing it from the panel via /api/s3source/*, and the one-time
 * migration into R2 -- see s3migrate.js. Unrelated to R2, which r2.js
 * already covers; configured separately (own credentials, own settings row)
 * since it's a different bucket entirely.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import { s3SourceSettings } from "./db.js";

async function clientAndBucket() {
  const conf = await s3SourceSettings();
  const accessKeyId = (conf.accessKeyId || "").trim();
  const secretAccessKey = (conf.secretAccessKey || "").trim();
  const bucket = (conf.bucketName || "").trim();
  const endpoint = (conf.endpointUrl || "").trim();

  const missing = [
    ["endpoint URL", endpoint],
    ["access key ID", accessKeyId],
    ["secret access key", secretAccessKey],
    ["bucket name", bucket],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Source S3 is not configured: missing ${missing.join(", ")}.`);
  }

  const client = new S3Client({
    region: (conf.region || "us-east-1").trim(),
    endpoint: /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`,
    forcePathStyle: conf.forcePathStyle ?? true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, bucket };
}

/** Cheap reachability check -- one HEAD, no listing. */
export async function ping() {
  try {
    const { client, bucket } = await clientAndBucket();
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

/** Lists the bucket to prove the credentials work, and sizes what is in it. */
export async function testConnection() {
  const { client, bucket } = await clientAndBucket();
  let objectCount = 0;
  let totalBytes = 0;
  let token;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue;
      objectCount += 1;
      totalBytes += obj.Size ?? 0;
    }
    token = page.NextContinuationToken;
  } while (token);

  return { bucket, object_count: objectCount, total_bytes: totalBytes };
}

/**
 * Lists every object under a prefix, fully paginated, newest first. Returns
 * the whole bucket's worth in `objects` capped at `limit` plus the true
 * `total` count, so a browsing UI can show "X of Y" while a migration --
 * which wants every object regardless of `limit` -- can go through
 * listAllObjects() instead.
 */
export async function listObjects(prefix = "", limit = 100) {
  const { bucket, objects } = await scanBucket(prefix);
  return { bucket, objects: objects.slice(0, limit), total: objects.length };
}

/** Every object under a prefix, unbounded -- what s3migrate.js needs to plan a full run. */
export async function listAllObjects(prefix = "") {
  return (await scanBucket(prefix)).objects;
}

async function scanBucket(prefix) {
  const { client, bucket } = await clientAndBucket();
  const objects = [];
  let token;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token })
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue; // skip folder markers
      objects.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        last_modified: obj.LastModified ? new Date(obj.LastModified).toISOString() : null,
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  objects.sort((a, b) => String(b.last_modified).localeCompare(String(a.last_modified)));
  return { bucket, objects };
}

/**
 * Opens a streaming read of one object. The caller pipes .body straight into
 * the R2 upload -- it is never buffered whole here or written to disk.
 */
export async function getObject(key) {
  const { client, bucket } = await clientAndBucket();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return {
    body: result.Body,
    contentType: result.ContentType || "application/octet-stream",
    size: result.ContentLength ?? 0,
  };
}

/** Existence + size check, so a re-run can tell what is already gone. */
export async function headObject(key) {
  const { client, bucket } = await clientAndBucket();
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: result.ContentLength ?? 0 };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return { exists: false, size: 0 };
    throw err;
  }
}

/** Permanently removes the object from the source bucket. */
export async function deleteObject(key) {
  const { client, bucket } = await clientAndBucket();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function bucketName() {
  return (await clientAndBucket()).bucket;
}
