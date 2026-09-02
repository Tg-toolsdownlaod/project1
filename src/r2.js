import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getR2Settings } from './supabase.js';

let cachedClient = null;
let cachedSettings = null;

async function getClient() {
  const settings = await getR2Settings();
  if (!settings?.account_id || !settings?.access_key_id || !settings?.secret_access_key || !settings?.bucket) {
    throw new Error('Cloudflare R2 is not configured yet. Save account_id, access_key_id, secret_access_key and bucket first.');
  }

  if (cachedClient && cachedSettings?.access_key_id === settings.access_key_id && cachedSettings?.account_id === settings.account_id) {
    return { client: cachedClient, settings };
  }

  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${settings.account_id}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: settings.access_key_id,
      secretAccessKey: settings.secret_access_key,
    },
  });
  cachedSettings = settings;
  return { client: cachedClient, settings };
}

/** Uploads a buffer to R2 under `key` and returns a public URL if one is configured. */
export async function uploadToR2(key, buffer, contentType = 'application/octet-stream') {
  const { client, settings } = await getClient();

  await client.send(
    new PutObjectCommand({
      Bucket: settings.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  const url = settings.public_url ? `${settings.public_url.replace(/\/$/, '')}/${key}` : null;
  return { url, key };
}
