import type { MailRequestDraft, ParsedMailRequest } from "./mail-parser.js";

/**
 * Разбор письма нейросетью (необязательно). Поддерживаются YandexGPT и любой
 * сервис с API, совместимым с OpenAI (в том числе GigaChat через совместимый шлюз).
 * Без настроек служба работает на разборе по правилам.
 */
export interface AiMailParser {
  parse(subject: string, body: string): Promise<ParsedMailRequest | undefined>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const FIELDS = ["client", "contactName", "contactPhone", "equipmentName", "serialNumber", "description"] as const;

const SYSTEM_PROMPT = `Ты разбираешь письма-заявки в сервисную компанию по ремонту медицинской лабораторной техники.
Верни только JSON без пояснений: {"client": string|null, "contactName": string|null, "contactPhone": string|null,
"equipmentName": string|null, "serialNumber": string|null, "description": string|null, "confidence": number}.
client — наименование клиента (больница, лаборатория). contactName и contactPhone — ФИО и телефон для обратной связи.
equipmentName — наименование оборудования. serialNumber — заводской (серийный) номер ровно как в письме.
description — описание неисправности или работ. confidence — от 0 до 1, насколько ты уверен.
Не выдумывай: если поля нет в письме, ставь null. Цитаты прошлых писем не учитывай.`;

function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function draftFromAiJson(json: Record<string, unknown> | undefined): ParsedMailRequest | undefined {
  if (!json) return undefined;
  const draft: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = json[field];
    if (typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "null") draft[field] = value.trim().slice(0, 2000);
  }
  const rawConfidence = typeof json.confidence === "number" ? json.confidence : Number(json.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;
  return { draft: draft as MailRequestDraft, confidence, source: "ai" };
}

function userPrompt(subject: string, body: string): string {
  return `Тема: ${subject}\n\nТекст письма:\n${body.slice(0, 8000)}`;
}

export function aiMailParserFromEnv(environment: NodeJS.ProcessEnv, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): AiMailParser | undefined {
  const provider = environment.AI_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "none") return undefined;
  const timeoutMs = 20_000;
  const call = async (url: string, headers: Record<string, string>, payload: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), signal: controller.signal });
      if (response.status !== 200) throw new Error(`ai_http_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  if (provider === "yandex") {
    const apiKey = environment.YANDEX_API_KEY?.trim();
    const folderId = environment.YANDEX_FOLDER_ID?.trim();
    if (!apiKey || !folderId) throw new Error("Для AI_PROVIDER=yandex нужны YANDEX_API_KEY и YANDEX_FOLDER_ID");
    const model = environment.YANDEX_MODEL?.trim() || "yandexgpt-lite/latest";
    return {
      async parse(subject, body) {
        const result = await call("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", { Authorization: `Api-Key ${apiKey}`, "x-folder-id": folderId }, {
          modelUri: `gpt://${folderId}/${model}`,
          completionOptions: { stream: false, temperature: 0, maxTokens: 800 },
          messages: [{ role: "system", text: SYSTEM_PROMPT }, { role: "user", text: userPrompt(subject, body) }]
        }) as { result?: { alternatives?: Array<{ message?: { text?: string } }> } };
        return draftFromAiJson(extractJson(result.result?.alternatives?.[0]?.message?.text ?? ""));
      }
    };
  }
  if (provider === "openai") {
    const apiKey = environment.AI_API_KEY?.trim();
    const baseUrl = (environment.AI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/u, "");
    const model = environment.AI_MODEL?.trim();
    if (!apiKey || !model) throw new Error("Для AI_PROVIDER=openai нужны AI_API_KEY и AI_MODEL");
    return {
      async parse(subject, body) {
        const result = await call(`${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}` }, {
          model,
          temperature: 0,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt(subject, body) }]
        }) as { choices?: Array<{ message?: { content?: string } }> };
        return draftFromAiJson(extractJson(result.choices?.[0]?.message?.content ?? ""));
      }
    };
  }
  throw new Error("AI_PROVIDER должен быть none, yandex или openai");
}
