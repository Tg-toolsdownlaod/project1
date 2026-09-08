/** Cloudflare R2 (S3-compatible) helpers. */
import { createReadStream } from "node:fs";

import {
  DeleteObjectCommand,
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
  return uploadBody(createReadStream(localPath), key, contentType, onProgress);
}

/**
 * Uploads anything the AWS SDK accepts as a body -- a file stream, or the
 * request stream of a browser upload -- and returns the same public URL (or
 * bare key) that upload() does. lib-storage switches to a multipart upload on
 * its own, so a stream of unknown length is fine.
 */
export async function uploadBody(body, key, contentType = "video/mp4", onProgress) {
  const { client, bucket, conf } = await clientAndBucket();
  const transfer = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
  });
  if (onProgress) {
    transfer.on("httpUploadProgress", (p) => onProgress(p.loaded ?? 0, p.total ?? 0));
  }
  await transfer.done();

  return publicUrl(key, conf.publicUrl);
}

/** The public URL of a key, or the bare key when no public URL is configured. */
function publicUrl(key, configured) {
  const base = (configured || "").replace(/\/+$/, "");
  return base ? `${base}/${encodeURI(key)}` : key;
}

/** Lists what is in the bucket under a prefix, newest first, with URLs. */
export async function listObjects(prefix = "", limit = 100) {
  const { client, bucket, conf } = await clientAndBucket();
  const objects = [];
  let token;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: token,
      })
    );
    for (const obj of page.Contents ?? []) {
      objects.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        last_modified: obj.LastModified ? new Date(obj.LastModified).toISOString() : null,
        url: conf.publicUrl ? publicUrl(obj.Key, conf.publicUrl) : null,
      });
    }
    token = page.NextContinuationToken;
  } while (token);

  objects.sort((a, b) => String(b.last_modified).localeCompare(String(a.last_modified)));
  return { bucket, objects: objects.slice(0, limit), total: objects.length };
}

/** Removes one object, so a mistaken upload can be undone from the panel. */
export async function remove(key) {
  const { client, bucket } = await clientAndBucket();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * An object key for a file uploaded by hand from the panel. The random suffix
 * is what keeps two people uploading "video.mp4" from overwriting each other.
 */
export function buildUploadKey(folder, fileName) {
  const dir = slugPath(folder || "uploads");
  const name = fileName || "video.mp4";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase() : "mp4";
  const base = slug(dot > 0 ? name.slice(0, dot) : name).slice(0, 80);
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${dir ? `${dir}/` : ""}${stamp}-${base}-${rand}.${ext || "mp4"}`;
}

/** Slugs each segment of a folder path, dropping empty and dot-only ones. */
function slugPath(value) {
  return String(value || "")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && !/^\.+$/.test(part))
    .map((part) => slug(part))
    .join("/");
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
