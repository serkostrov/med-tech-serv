import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type AppSupabaseClient = SupabaseClient;

let cached: AppSupabaseClient | undefined;

export function createSupabaseClient(
  url = (import.meta.env as ImportMetaEnv | undefined)?.VITE_SUPABASE_URL,
  anonKey = (import.meta.env as ImportMetaEnv | undefined)?.VITE_SUPABASE_ANON_KEY
): AppSupabaseClient {
  const trimmedUrl = url?.trim();
  const trimmedKey = anonKey?.trim();
  if (!trimmedUrl || !trimmedKey) {
    throw new Error("Задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY");
  }
  return createClient(trimmedUrl, trimmedKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
}

export function getSupabase(): AppSupabaseClient {
  cached ??= createSupabaseClient();
  return cached;
}
