import { deflateSync } from "node:zlib";
import { clipMultiline, clipText, escapeHtml, formatTaskPeriod, isReworkEvent, taskStageLook, type TaskCardData } from "./task-card.js";

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

/** Полупрозрачный цвет этапа для фона блока: #rrggbb → rgba(). */
function tint(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
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

/**
 * Общие стили: поля как у обычного текста сообщения. Место под время в углу пузыря — только снизу:
 * отступ справа на всю высоту сужал блоки карточки.
 */
const BASE_STYLE = "body{margin:0;padding:0}"
  + ".c{padding:10px 12px max(10px,env(safe-area-inset-bottom));"
  + "font:15px/1.35 system-ui,sans-serif;color:var(--tg-theme-text-color)}";

const TASK_STYLE = BASE_STYLE
  // Название задачи цветом этапа, под ним что случилось и номер задачи.
  + ".t{margin:0 0 2px;font-size:17px;font-weight:700;line-height:1.3;color:var(--k);word-break:break-word}"
  + ".e{margin:0 0 9px;font-size:14px;color:var(--tg-theme-text-color)}"
  + ".e span{color:var(--tg-theme-hint-color);font-variant-numeric:tabular-nums}"
  + ".r{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;font-size:14px}"
  + ".r dt{color:var(--tg-theme-hint-color)}.r dd{margin:0;word-break:break-word}"
  // «Что доработать»: блок, слегка тонированный цветом этапа, без рамок
  // (полоску слева со скруглением Telegram рисует с искажением).
  + ".m{display:block;box-sizing:border-box;width:100%;margin:10px 0 0;padding:8px 11px;border-radius:10px;background:var(--kb);font-size:14px;white-space:pre-wrap;word-break:break-word}"
  + ".m b{display:block;margin:0 0 2px;font-size:12px;font-weight:600;color:var(--k);white-space:normal}"
  + ".x{color:var(--tg-theme-hint-color)}";

/**
 * HTML карточки задачи для sendWidget: название цветом этапа, под ним что случилось и номер,
 * затем площадка, инженер, срок и «Что доработать». Подписи над карточкой нет.
 */
export function taskWidgetHtml(data: TaskCardData, timeZone = "Europe/Moscow"): string {
  const look = taskStageLook(data.eventCode);
  const number = clipText(data.taskNumber, 24);
  // Высота пузыря не больше 600 px, лишнее обрезается: поля держим короткими.
  const title = clipText(data.taskTitle, 120) ?? "Без названия";
  const site = clipText(data.siteName, 100);
  const engineer = clipText(data.engineerName, 60);
  const period = formatTaskPeriod(data.periodFrom, data.periodTo, timeZone);
  const comment = isReworkEvent(data.eventCode) ? clipMultiline(data.reworkComment, 240) : undefined;
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
    + `<p class="t">${escapeHtml(title)}</p>`
    + `<p class="e">${escapeHtml(look.event)}${number ? ` <span>· ${escapeHtml(number)}</span>` : ""}</p>`
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
    + "<p class=\"t\">Вставьте его в CRM: нажмите на своё имя внизу меню, откроется «Мой профиль». Тогда уведомления CRM будут приходить сюда.</p>"
    + `<button onclick="TelegramWidget.copyText('${id}')">Скопировать номер</button>`
    + "</div>";
}

/** Укладывается ли HTML в ограничения Telegram для виджета. */
export function widgetFitsLimits(html: string): boolean {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes < 1 || bytes > WIDGET_HTML_LIMIT_BYTES || html.includes("\u0000")) return false;
  return deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length <= WIDGET_COMPRESSED_LIMIT_BYTES;
}
