import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type AppSupabaseClient = SupabaseClient;

declare global {
  interface Window {
    __MEDTECH_CONFIG__?: {
      readonly VITE_SUPABASE_URL?: string;
      readonly VITE_SUPABASE_ANON_KEY?: string;
    };
  }
}

let cached: AppSupabaseClient | undefined;

function readConfig(key: "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY"): string | undefined {
  const runtime = typeof window !== "undefined" ? window.__MEDTECH_CONFIG__?.[key] : undefined;
  if (typeof runtime === "string" && runtime.trim()) return runtime.trim();
  const built = (import.meta.env as ImportMetaEnv | undefined)?.[key];
  return typeof built === "string" && built.trim() ? built.trim() : undefined;
}

export function createSupabaseClient(
  url = readConfig("VITE_SUPABASE_URL"),
  anonKey = readConfig("VITE_SUPABASE_ANON_KEY")
): AppSupabaseClient {
  const trimmedUrl = url?.trim();
  const trimmedKey = anonKey?.trim();
  if (!trimmedUrl || !trimmedKey) {
    throw new Error(
      "Не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в Environment Dokploy"
    );
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
