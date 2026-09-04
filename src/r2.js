/** Cloudflare R2 (S3-compatible) helpers. */
import { createReadStream } from "node:fs";

import {
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { r2Settings } from "./db.js";

async function clientAndBucket() {
  const conf = await r2Settings();
  const missing = ["accessKeyId", "secretAccessKey", "bucketName"].filter((k) => !conf[k]);
  if (missing.length) {
    throw new Error(`R2 is not configured: missing ${missing.join(", ")}.`);
  }

  const endpoint =
    conf.endpointUrl ||
    (conf.accountId ? `https://${conf.accountId}.r2.cloudflarestorage.com` : "");
  if (!endpoint) {
    throw new Error("R2 is not configured: no endpoint URL or account ID.");
  }

  const client = new S3Client({
    region: conf.region || "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: conf.accessKeyId,
      secretAccessKey: conf.secretAccessKey,
    },
  });
  return { client, bucket: conf.bucketName, conf };
}

/** Cheap reachability check for /health — one HEAD, no listing. */
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
      objectCount += 1;
      totalBytes += obj.Size ?? 0;
    }
    token = page.NextContinuationToken;
  } while (token);

  return { bucket, object_count: objectCount, total_bytes: totalBytes };
}

/** Uploads a staged file and returns its public URL (or the bare key). */
export async function upload(localPath, key, contentType = "video/mp4", onProgress) {
  const { client, bucket, conf } = await clientAndBucket();
  const transfer = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: contentType,
    },
  });
  if (onProgress) {
    transfer.on("httpUploadProgress", (p) => onProgress(p.loaded ?? 0, p.total ?? 0));
  }
  await transfer.done();

  const base = (conf.publicUrl || "").replace(/\/+$/, "");
  return base ? `${base}/${key}` : key;
}

/** Renders the configured folder pattern into a safe object key. */
export function buildKey(pattern, group, topic, ep, fileName) {
  const epText = ep === null || ep === undefined ? "000" : String(ep).padStart(3, "0");
  const rendered = pattern
    .replaceAll("{group}", slug(group))
    .replaceAll("{topic}", slug(topic || "general"))
    .replaceAll("{ep}", epText);
  const suffix = fileName.includes(".") ? fileName.split(".").pop() : "mp4";
  return `${rendered.replace(/^\/+|\/+$/g, "")}.${suffix}`;
}

function slug(value) {
  const cleaned = (value || "").replace(/[^\p{L}\p{N}\-. ]+/gu, "").trim();
  return cleaned.replace(/\s+/g, "-") || "untitled";
}
