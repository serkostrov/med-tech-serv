import { deflateSync } from "node:zlib";

/**
 * Карточки для Telegram в виде HTML-виджетов (Bot API 10.4, метод sendWidget).
 * Виджет рисует приложение Telegram в пузыре сообщения: только HTML и CSS, системный шрифт,
 * цвета темы чата приходят переменными --tg-theme-*. Скриптов в карточке задачи нет,
 * все данные экранируются, поэтому текст из задачи не может стать разметкой.
 */

/** Ограничения Telegram на HTML виджета: 32 КБ, после сжатия zlib (уровень 9) не больше 4 КБ. */
export const WIDGET_HTML_LIMIT_BYTES = 32_768;
export const WIDGET_COMPRESSED_LIMIT_BYTES = 4_096;
/** Подпись к виджету: её видно в уведомлении и в приложениях, которые виджеты не показывают. */
export const WIDGET_CAPTION_LIMIT = 1_024;

export interface TaskWidgetData {
  readonly eventCode: string;
  readonly taskNumber?: string;
  readonly taskTitle?: string;
  readonly siteName?: string;
  readonly engineerName?: string;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly reworkComment?: string;
}

interface StatusLook {
  readonly label: string;
  /** Цвет текста и полоски: в светлой и тёмной теме чата. */
  readonly light: string;
  readonly dark: string;
}

/** Этап задачи после события, цвета как в CRM: назначена жёлтая, в работе зелёная, на проверке синяя. */
const EVENT_LOOK: Readonly<Record<string, StatusLook>> = {
  task_application_accepted: { label: "Новая", light: "#52627a", dark: "#a3b1c6" },
  task_engineer_assigned: { label: "Назначена", light: "#946300", dark: "#f2b630" },
  task_engineer_accepted: { label: "В работе", light: "#1d7f47", dark: "#4fc47e" },
  task_work_completed: { label: "На проверке", light: "#1c66b8", dark: "#5ea9f2" },
  task_rework_requested: { label: "На доработке", light: "#b9570c", dark: "#f59d4f" },
  task_overdue: { label: "Просрочена", light: "#bf3434", dark: "#f27373" }
};
const DEFAULT_LOOK: StatusLook = { label: "Задача", light: "#52627a", dark: "#a3b1c6" };

/** Полупрозрачный цвет этапа для фона блока: #rrggbb → rgba(). */
function tint(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/** Обрезает длинный текст по символам (не посреди суррогатной пары) и ставит многоточие. */
export function clipText(value: string | undefined, limit: number): string | undefined {
  const text = value?.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : text;
}

/**
 * Обрезка по длине, как её считает Telegram: в единицах UTF-16 (эмодзи занимает две),
 * не разрывая суррогатную пару. Для подписи и текста сообщения.
 */
export function clipUtf16(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

/** Многострочный текст (комментарий): переносы сохраняем, лишние пустые строки убираем. */
function clipMultiline(value: string | undefined, limit: number): string | undefined {
  const text = value?.replace(/\r\n?/gu, "\n").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
  if (!text) return undefined;
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : text;
}

function shortDate(value: string | undefined, timeZone: string): { readonly day: string; readonly month: string } | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value.replace(/\.$/u, "");
  return day && month ? { day, month } : undefined;
}

/** Срок задачи коротко: «12 нояб», «12–13 нояб», «28 нояб – 3 дек», «до 13 нояб». */
export function formatTaskPeriod(from: string | undefined, to: string | undefined, timeZone = "Europe/Moscow"): string | undefined {
  const start = shortDate(from, timeZone);
  const end = shortDate(to, timeZone);
  if (!start && !end) return undefined;
  if (!start && end) return `до ${end.day} ${end.month}`;
  if (start && !end) return `с ${start.day} ${start.month}`;
  if (!start || !end) return undefined;
  if (start.day === end.day && start.month === end.month) return `${end.day} ${end.month}`;
  if (start.month === end.month) return `${start.day}–${end.day} ${end.month}`;
  return `${start.day} ${start.month} – ${end.day} ${end.month}`;
}

/**
 * Общие стили: поля как у обычного текста сообщения. Место под время в углу пузыря — только снизу:
 * отступ справа на всю высоту сужал блоки карточки.
 */
const BASE_STYLE = "body{margin:0;padding:0}"
  + ".c{padding:10px 12px max(10px,env(safe-area-inset-bottom));"
  + "font:15px/1.35 system-ui,sans-serif;color:var(--tg-theme-text-color)}";

const TASK_STYLE = BASE_STYLE
  // Цветная точка этапа перед названием, как у колонок на доске CRM.
  + ".d{display:inline-block;width:9px;height:9px;margin:0 8px 2px 0;border-radius:50%;background:var(--k);vertical-align:middle}"
  + ".t{margin:0 0 8px;font-size:17px;font-weight:700;line-height:1.3;word-break:break-word}"
  + ".r{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;font-size:14px}"
  + ".r dt{color:var(--tg-theme-hint-color)}.r dd{margin:0;word-break:break-word}"
  // «Что доработать»: блок, слегка тонированный цветом этапа, без рамок
  // (полоску слева со скруглением Telegram рисует с искажением).
  + ".m{display:block;box-sizing:border-box;width:100%;margin:10px 0 0;padding:8px 11px;border-radius:10px;background:var(--kb);font-size:14px;white-space:pre-wrap;word-break:break-word}"
  + ".m b{display:block;margin:0 0 2px;font-size:12px;font-weight:600;color:var(--k);white-space:normal}"
  + ".x{color:var(--tg-theme-hint-color)}";

/**
 * HTML карточки задачи для sendWidget. Что случилось и номер задачи пишет подпись над карточкой
 * (её же видно в уведомлении), поэтому в карточке их нет: название, площадка, инженер, срок, комментарий.
 */
export function taskWidgetHtml(data: TaskWidgetData, timeZone = "Europe/Moscow"): string {
  const look = EVENT_LOOK[data.eventCode] ?? DEFAULT_LOOK;
  // Высота пузыря не больше 600 px, лишнее обрезается: поля держим короткими.
  const title = clipText(data.taskTitle, 120) ?? "Без названия";
  const site = clipText(data.siteName, 100);
  const engineer = clipText(data.engineerName, 60);
  const period = formatTaskPeriod(data.periodFrom, data.periodTo, timeZone);
  const comment = data.eventCode === "task_rework_requested" ? clipMultiline(data.reworkComment, 240) : undefined;
  const rows = [
    site ? `<dt>Площадка</dt><dd>${escapeHtml(site)}</dd>` : "",
    `<dt>Инженер</dt><dd${engineer && engineer !== "не назначен" ? "" : " class=\"x\""}>${escapeHtml(engineer ?? "не назначен")}</dd>`,
    period ? `<dt>Срок</dt><dd>${escapeHtml(period)}</dd>` : ""
  ].join("");
  // Цвет этапа: в светлой теме темнее, в тёмной светлее.
  const colors = `.c{--k:${look.light};--kb:${tint(look.light, 0.1)}}`
    // В тёмной теме тонировка на синем фоне выходит грязной: там родной фон блока Telegram,
    // заданный прямо в свойстве (var() внутри переменной документация виджетов не упоминает).
    + `@media (prefers-color-scheme:dark){.c{--k:${look.dark}}.m{background:var(--tg-theme-secondary-bg-color)}}`;
  return `<style>${TASK_STYLE}${colors}</style>`
    + `<div class="c" title="${escapeHtml(look.label)}">`
    + `<p class="t"><span class="d"></span>${escapeHtml(title)}</p>`
    + `<dl class="r">${rows}</dl>`
    + (comment ? `<div class="m"><b>Что доработать</b>${escapeHtml(comment)}</div>` : "")
    + "</div>";
}

const CHAT_STYLE = BASE_STYLE
  + ".l{margin:0;font-size:13px;color:var(--tg-theme-hint-color)}"
  + ".n{margin:2px 0 6px;font-size:28px;font-weight:700;letter-spacing:.02em;font-variant-numeric:tabular-nums}"
  + ".t{margin:0 0 10px;font-size:14px;color:var(--tg-theme-hint-color)}"
  + "button{width:100%}";

/**
 * Ответ на /start: номер чата крупно и кнопка «Скопировать номер».
 * Виджет нельзя переслать, поэтому номер удобнее копировать кнопкой. Номер только из цифр.
 */
export function chatIdWidgetHtml(chatId: string): string {
  const id = chatId.trim();
  if (!/^-?\d{1,20}$/u.test(id)) throw new Error("Номер чата Telegram должен состоять из цифр");
  return `<style>${CHAT_STYLE}</style>`
    + "<div class=\"c\">"
    + "<p class=\"l\">Номер вашего чата</p>"
    + `<p class="n">${id}</p>`
    + "<p class=\"t\">Передайте его администратору МедТехСервиса, чтобы получать уведомления о задачах здесь.</p>"
    + `<button onclick="TelegramWidget.copyText('${id}')">Скопировать номер</button>`
    + "</div>";
}

/** Укладывается ли HTML в ограничения Telegram для виджета. */
export function widgetFitsLimits(html: string): boolean {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes < 1 || bytes > WIDGET_HTML_LIMIT_BYTES || html.includes("\u0000")) return false;
  return deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length <= WIDGET_COMPRESSED_LIMIT_BYTES;
}
