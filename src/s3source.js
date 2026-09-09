/**
 * Source S3-compatible bucket (e.g. Contabo) helpers, used only to pull
 * existing videos into R2 once and then delete them from here -- see
 * s3migrate.js. Unrelated to R2, which r2.js already covers.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import { config } from "./config.js";

let cached = null;

function clientAndBucket() {
  if (cached) return cached;

  const accessKeyId = config.s3AccessKeyId;
  const secretAccessKey = config.s3SecretAccessKey;
  const bucket = config.s3BucketName;
  const endpoint = config.s3Endpoint;

  const missing = [
    ["S3_ENDPOINT", endpoint],
    ["S3_ACCESS_KEY_ID", accessKeyId],
    ["S3_SECRET_ACCESS_KEY", secretAccessKey],
    ["S3_BUCKET_NAME", bucket],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Source S3 is not configured: missing ${missing.join(", ")}.`);
  }

  cached = {
    client: new S3Client({
      region: config.s3Region || "us-east-1",
      endpoint,
      forcePathStyle: config.s3ForcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    }),
    bucket,
  };
  return cached;
}

/** Lists every object under a prefix, handling pagination for you. */
export async function listObjects(prefix = "") {
  const { client, bucket } = clientAndBucket();
  const objects = [];
  let token;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token })
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue; // skip folder markers
      objects.push({ key: obj.Key, size: obj.Size ?? 0 });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return objects;
}

/**
 * Opens a streaming read of one object. The caller pipes .body straight into
 * the R2 upload -- it is never buffered whole here or written to disk.
 */
export async function getObject(key) {
  const { client, bucket } = clientAndBucket();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return {
    body: result.Body,
    contentType: result.ContentType || "application/octet-stream",
    size: result.ContentLength ?? 0,
  };
}

/** Existence + size check, so a re-run can tell what is already gone. */
export async function headObject(key) {
  const { client, bucket } = clientAndBucket();
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
  const { client, bucket } = clientAndBucket();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export function bucketName() {
  return clientAndBucket().bucket;
}
