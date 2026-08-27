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

function runtimeConfig(key: "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY"): string | undefined {
  const fromWindow = typeof window !== "undefined" ? window.__MEDTECH_CONFIG__?.[key] : undefined;
  if (typeof fromWindow === "string" && fromWindow.trim()) return fromWindow.trim();
  const fromVite = (import.meta.env as ImportMetaEnv | undefined)?.[key];
  return typeof fromVite === "string" && fromVite.trim() ? fromVite.trim() : undefined;
}

export function createSupabaseClient(
  url = runtimeConfig("VITE_SUPABASE_URL"),
  anonKey = runtimeConfig("VITE_SUPABASE_ANON_KEY")
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
