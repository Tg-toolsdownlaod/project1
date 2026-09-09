/**
 * Supabase access for the service.
 *
 * Everything here runs with the service-role key, so it bypasses RLS. Only
 * this process should ever hold that key.
 */
import { createClient } from "@supabase/supabase-js";

import { config } from "./config.js";

let client = null;

export function db() {
  if (!client) {
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
    }
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/** Throws on a Supabase error, otherwise hands back the rows. */
export function rows(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

/** Reads the one settings row a table is expected to hold ({} when empty). */
export async function single(table) {
  const data = rows(await db().from(table).select("*").limit(1));
  return data[0] ?? {};
}

/** Updates the single settings row, inserting it when the table is empty. */
export async function upsertSingle(table, values) {
  const existing = await single(table);
  const result = existing.id
    ? await db().from(table).update(values).eq("id", existing.id).select()
    : await db().from(table).insert(values).select();
  return rows(result)[0] ?? {};
}

/** Telegram credentials, preferring environment variables over the database. */
export async function telegramSettings() {
  const row = await single("telegram_settings");
  return {
    id: row.id,
    apiId: config.telegramApiId || row.api_id || "",
    apiHash: config.telegramApiHash || row.api_hash || "",
    phone: config.telegramPhone || row.phone || "",
    sessionString: config.telegramSession || row.session_string || "",
  };
}

/** R2 credentials, preferring environment variables over the database. */
export async function r2Settings() {
  const fromEnv = {
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucketName: config.r2BucketName,
    endpointUrl: config.r2EndpointUrl,
    publicUrl: config.r2PublicUrl,
    region: config.r2Region || "auto",
  };
  // Fully configured by environment variables -- skip Supabase entirely, so a
  // local one-off script (e.g. the S3-to-R2 migration) needs no
  // SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY just to read R2 credentials.
  if (fromEnv.accessKeyId && fromEnv.secretAccessKey && fromEnv.bucketName && (fromEnv.endpointUrl || fromEnv.accountId)) {
    return fromEnv;
  }
  const row = await single("r2_settings");
  return {
    accountId: fromEnv.accountId || row.account_id || "",
    accessKeyId: fromEnv.accessKeyId || row.access_key_id || "",
    secretAccessKey: fromEnv.secretAccessKey || row.secret_access_key || "",
    bucketName: fromEnv.bucketName || row.bucket_name || "",
    endpointUrl: fromEnv.endpointUrl || row.endpoint_url || "",
    publicUrl: fromEnv.publicUrl || row.public_url || "",
    region: fromEnv.region || row.region || "auto",
  };
}

export async function downloadSettings() {
  const row = await single("download_settings");
  return {
    concurrentDownloads: row.concurrent_downloads ?? 3,
    autoR2Upload: row.auto_r2_upload ?? true,
    r2FolderPattern: row.r2_folder_pattern || "{group}/{topic}/EP{ep}",
    retryOnFail: row.retry_on_fail ?? true,
  };
}

export const nowIso = () => new Date().toISOString();
