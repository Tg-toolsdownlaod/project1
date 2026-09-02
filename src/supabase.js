import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

/** telegram_settings is a single-row table (one operator, one Telegram account). */
export async function getTelegramSettings() {
  const { data, error } = await supabase.from('telegram_settings').select('*').maybeSingle();
  if (error) throw error;
  return data;
}

/** Insert-or-update the one telegram_settings row. */
export async function upsertTelegramSettings(patch) {
  const existing = await getTelegramSettings();
  if (existing?.id) {
    const { data, error } = await supabase
      .from('telegram_settings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('telegram_settings').insert(patch).select().maybeSingle();
  if (error) throw error;
  return data;
}

/** r2_settings is a single-row table holding your Cloudflare R2 credentials. */
export async function getR2Settings() {
  const { data, error } = await supabase.from('r2_settings').select('*').maybeSingle();
  if (error) throw error;
  return data;
}
