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
