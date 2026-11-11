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

const RETRYABLE_STATUSES = new Set([502, 503]);
const RETRY_DELAYS_MS = [400, 1200];

function sleepUnlessAborted(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Повтор чтения при кратком сбое шлюза (502/503) для входа и файлов.
 * Запросы к данным (/rest/v1/) не трогаем: postgrest-js сам повторяет
 * GET/HEAD при 503 с паузами 1, 2 и 4 с. 504 не повторяем: тяжёлый запрос,
 * скорее всего, ещё выполняется в базе. Запись (POST, PATCH, PUT, DELETE)
 * не повторяется никогда, чтобы не создать дубль.
 */
export async function fetchWithReadRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  baseFetch: typeof fetch = fetch,
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void> = sleepUnlessAborted
): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = input instanceof Request ? input.url : String(input);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const retryable = (method === "GET" || method === "HEAD") && !url.includes("/rest/v1/");
  let response = await baseFetch(input, init);
  if (!retryable) return response;
  for (const delay of RETRY_DELAYS_MS) {
    if (!RETRYABLE_STATUSES.has(response.status) || signal?.aborted) return response;
    await response.body?.cancel().catch(() => undefined);
    await sleep(delay, signal);
    response = await baseFetch(input, init);
  }
  return response;
}

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
    global: { fetch: (input, init) => fetchWithReadRetry(input, init) },
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
