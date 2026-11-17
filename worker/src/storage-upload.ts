import { randomUUID } from "node:crypto";

/**
 * Загрузка файлов писем в хранилище Supabase от имени службы (ключ сервиса).
 * Ключ объекта: mail/<id письма>/<uuid>.<расширение> — без кириллицы и пробелов.
 */
export interface MailFileStore {
  put(mailId: string, fileName: string, contentType: string, data: Uint8Array): Promise<string>;
}

export type UploadFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number; text(): Promise<string> }>;

export function storageObjectName(fileName: string): string {
  const extension = /\.([A-Za-z0-9]{1,10})$/u.exec(fileName)?.[1]?.toLowerCase();
  return `${randomUUID()}${extension ? `.${extension}` : ""}`;
}

export function supabaseMailFileStore(environment: NodeJS.ProcessEnv, fetchImpl: UploadFetch = globalThis.fetch as unknown as UploadFetch): MailFileStore | undefined {
  const baseUrl = environment.SUPABASE_URL?.trim().replace(/\/$/u, "");
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!baseUrl || !serviceKey) return undefined;
  const bucket = environment.STORAGE_BUCKET?.trim() || "medtech-files";
  return {
    async put(mailId, fileName, contentType, data) {
      const key = `mail/${mailId}/${storageObjectName(fileName)}`;
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/${bucket}/${key}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": contentType || "application/octet-stream", "x-upsert": "false" },
        body: data
      });
      if (response.status !== 200) throw new Error(`storage_upload_${response.status}`);
      return key;
    }
  };
}

/** Чтение файла из хранилища Supabase ключом сервиса: акт для письма «Работы завершены». */
export interface StoredFileReader {
  get(key: string, limitBytes: number): Promise<Uint8Array | undefined>;
}

export type DownloadFetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Ключ объекта в адресе: каждую часть пути кодируем отдельно, «/» остаётся разделителем. */
export function storageObjectPath(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function supabaseFileReader(
  environment: NodeJS.ProcessEnv,
  fetchImpl: DownloadFetch = globalThis.fetch as unknown as DownloadFetch,
  timeoutMs = 20_000
): StoredFileReader | undefined {
  const baseUrl = environment.SUPABASE_URL?.trim().replace(/\/$/u, "");
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!baseUrl || !serviceKey) return undefined;
  const bucket = environment.STORAGE_BUCKET?.trim() || "medtech-files";
  return {
    async get(key, limitBytes) {
      // Ключ из базы: без «..» и пустых частей, чтобы не выйти за пределы корзины.
      if (!key || key.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${storageObjectPath(key)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
          signal: controller.signal
        });
        if (response.status !== 200) throw new Error(`storage_download_${response.status}`);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > limitBytes) return undefined;
        const data = new Uint8Array(await response.arrayBuffer());
        return data.byteLength > 0 && data.byteLength <= limitBytes ? data : undefined;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
