import { clipMultiline, clipText, escapeHtml, formatTaskPeriod, isReworkEvent, taskStageLook, type TaskCardData } from "./task-card.js";

/**
 * HTML-письмо о задаче: узкая шапка «МедТехСервис», приветствие, карточка задачи как в Telegram
 * (название цветом этапа, событие и номер, площадка, инженер, срок, «Что доработать»), кнопка
 * «Открыть задачу» и мелкая подпись со ссылкой текстом.
 * Вёрстка таблицами с инлайн-стилями, ширина до 600 px, системные шрифты, без внешних картинок
 * и шрифтов: так письмо открывается в Gmail, Яндекс Почте, Mail.ru и Outlook. Все данные экранируются.
 */

export interface TaskEmailOptions {
  /** Ссылка на задачу в CRM: кнопка и строка внизу письма. Без неё письмо без кнопки. */
  readonly taskUrl?: string;
  /** Тема письма: заголовок документа. */
  readonly subject?: string;
  readonly timeZone?: string;
}

/** Цвета CRM (src/styles.css). */
const COLOR = {
  canvas: "#f4f6f8",
  surface: "#ffffff",
  border: "#dde5ea",
  borderSoft: "#eef2f4",
  ink: "#17232c",
  muted: "#445863",
  accent: "#0e6e99",
  accentDark: "#0c5c81",
  header: "#132029",
  white: "#ffffff"
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
/** Длинные слова (номера, адреса) переносятся, а не растягивают письмо. */
const WRAP = "word-wrap:break-word;overflow-wrap:break-word;word-break:break-word;";
const TABLE = "role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"";

function font(size: number, lineHeight: number, color: string): string {
  return `font-family:${FONT};font-size:${size}px;line-height:${lineHeight}px;color:${color};`;
}

/** Цвет этапа, смешанный с белым: фон блока «Что доработать» (rgba понимают не все почтовые программы). */
function tintOnWhite(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `#${[16, 8, 0]
    .map((shift) => Math.round(((value >> shift) & 255) * alpha + 255 * (1 - alpha)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Ссылка только http(s): другое (javascript: и т. п.) в письмо не попадает. */
function safeUrl(value: string | undefined): string | undefined {
  return value && /^https?:\/\/\S+$/iu.test(value) ? value : undefined;
}

/** HTML-документ письма о задаче. Текстовая версия письма — шаблон из CRM, она уходит рядом. */
export function taskEmailHtml(card: TaskCardData, options: TaskEmailOptions = {}): string {
  const look = taskStageLook(card.eventCode);
  const stage = look.light;
  const name = clipText(card.recipientName, 120);
  const number = clipText(card.taskNumber, 40);
  const title = clipText(card.taskTitle, 300) ?? "Без названия";
  const site = clipText(card.siteName, 200);
  const engineer = clipText(card.engineerName, 120);
  const assigned = engineer !== undefined && engineer !== "не назначен";
  const period = formatTaskPeriod(card.periodFrom, card.periodTo, options.timeZone ?? "Europe/Moscow", "long");
  const comment = isReworkEvent(card.eventCode) ? clipMultiline(card.reworkComment, 2_000) : undefined;
  const url = safeUrl(options.taskUrl);
  const href = url ? escapeHtml(url) : undefined;

  // Строки карточки: подпись серым, значение; над первой строкой тонкая линия, как в карточке на доске.
  const rows: Array<{ readonly label: string; readonly value: string; readonly dim: boolean }> = [];
  if (site) rows.push({ label: "Площадка", value: site, dim: false });
  rows.push({ label: "Инженер", value: assigned ? engineer : "не назначен", dim: !assigned });
  if (period) rows.push({ label: "Срок", value: period, dim: false });
  const rowsHtml = rows.map((row, index) => {
    const edge = index === 0 ? `padding-top:12px;border-top:1px solid ${COLOR.borderSoft};` : "padding-top:6px;";
    return "<tr>"
      + `<td width="96" valign="top" style="width:96px;${edge}padding-right:12px;${font(14, 20, COLOR.muted)}">${row.label}</td>`
      + `<td valign="top" style="${edge}${font(14, 20, row.dim ? COLOR.muted : COLOR.ink)}${WRAP}">${escapeHtml(row.value)}</td>`
      + "</tr>";
  });
  if (comment) {
    const tint = tintOnWhite(stage, 0.1);
    rowsHtml.push(
      `<tr><td colspan="2" style="padding-top:16px;">`
      + `<table ${TABLE} width="100%" style="width:100%;"><tr>`
      + `<td bgcolor="${tint}" style="padding:10px 12px;background-color:${tint};border-radius:10px;">`
      + `<p style="margin:0 0 2px;${font(12, 16, stage)}font-weight:600;">Что доработать</p>`
      + `<p style="margin:0;${font(14, 20, COLOR.ink)}${WRAP}">${escapeHtml(comment).replace(/\n/gu, "<br>")}</p>`
      + "</td></tr></table>"
      + "</td></tr>"
    );
  }

  const cardHtml = [
    `<table ${TABLE} width="100%" style="width:100%;">`,
    `<tr><td class="mts-card" bgcolor="${COLOR.surface}" style="padding:16px 18px 18px;background-color:${COLOR.surface};border:1px solid ${COLOR.border};border-top:3px solid ${stage};border-radius:10px;">`,
    `<h1 style="margin:0 0 4px;${font(19, 25, stage)}font-weight:700;${WRAP}">${escapeHtml(title)}</h1>`,
    `<p style="margin:0 0 12px;${font(14, 20, COLOR.ink)}">${escapeHtml(look.event)}${number ? ` <span style="color:${COLOR.muted};">· ${escapeHtml(number)}</span>` : ""}</p>`,
    `<table ${TABLE} width="100%" style="width:100%;">`,
    ...rowsHtml,
    "</table>",
    "</td></tr>",
    "</table>"
  ];

  // «Пуленепробиваемая» кнопка: фон у ячейки таблицы, поэтому кнопку видно и там, где у ссылки
  // не работают отступы (Outlook берёт их из mso-padding-alt ячейки).
  const buttonHtml = href ? [
    `<tr><td style="padding:24px 0 0;">`,
    `<table ${TABLE}>`,
    `<tr><td align="center" bgcolor="${COLOR.accent}" style="background-color:${COLOR.accent};border-radius:8px;mso-padding-alt:12px 24px;">`,
    `<a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;${font(15, 20, COLOR.white)}font-weight:600;text-decoration:none;border-radius:8px;">Открыть задачу</a>`,
    "</td></tr>",
    "</table>",
    "</td></tr>"
  ] : [];

  // Скрытая первая строка: её почта показывает в списке писем рядом с темой.
  const preview = comment ? [title, `Что доработать: ${clipText(comment, 120) ?? ""}`] : [title, site, period];
  const preheader = `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${COLOR.canvas};">`
    + escapeHtml(clipText(preview.filter((part) => part).join(" · "), 200) ?? "")
    + "&zwnj;&nbsp;".repeat(80)
    + "</div>";

  return [
    "<!DOCTYPE html>",
    "<html lang=\"ru\" xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\">",
    "<head>",
    "<meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"x-apple-disable-message-reformatting\">",
    "<meta name=\"format-detection\" content=\"telephone=no, date=no, address=no, email=no\">",
    "<meta name=\"color-scheme\" content=\"light\">",
    "<meta name=\"supported-color-schemes\" content=\"light\">",
    `<title>${escapeHtml(options.subject?.trim() || "МедТехСервис")}</title>`,
    "<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->",
    "<!--[if mso]><style>body,table,td,p,a,span,h1{font-family:'Segoe UI',Arial,sans-serif !important;}</style><![endif]-->",
    "<style>",
    "body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}",
    "a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}",
    "@media only screen and (max-width:620px){.mts-pad{padding-left:16px!important;padding-right:16px!important}.mts-card{padding-left:14px!important;padding-right:14px!important}}",
    "</style>",
    "</head>",
    `<body style="margin:0;padding:0;background-color:${COLOR.canvas};">`,
    preheader,
    `<table ${TABLE} width="100%" bgcolor="${COLOR.canvas}" style="width:100%;background-color:${COLOR.canvas};">`,
    `<tr><td align="center" style="padding:24px 12px 32px;">`,
    `<!--[if mso]><table ${TABLE} width="600" align="center"><tr><td><![endif]-->`,
    `<table ${TABLE} width="100%" style="width:100%;max-width:600px;margin:0 auto;">`,
    // Шапка: знак и название, как в боковой панели CRM.
    `<tr><td class="mts-pad" bgcolor="${COLOR.header}" style="padding:12px 24px;background-color:${COLOR.header};border-radius:10px 10px 0 0;">`,
    `<table ${TABLE}><tr>`,
    `<td aria-hidden="true" width="28" height="28" align="center" valign="middle" bgcolor="${COLOR.accent}" style="width:28px;height:28px;background-color:${COLOR.accent};border-radius:6px;${font(12, 28, COLOR.white)}font-weight:700;letter-spacing:-0.04em;">МТ</td>`,
    `<td style="padding-left:10px;${font(14, 20, COLOR.white)}font-weight:700;letter-spacing:0.02em;">МедТехСервис</td>`,
    "</tr></table>",
    "</td></tr>",
    // Приветствие, карточка задачи и кнопка.
    `<tr><td class="mts-pad" bgcolor="${COLOR.surface}" style="padding:24px 24px 28px;background-color:${COLOR.surface};border:1px solid ${COLOR.border};border-top:0;border-radius:0 0 10px 10px;">`,
    `<table ${TABLE} width="100%" style="width:100%;">`,
    `<tr><td style="padding:0 0 16px;${font(16, 24, COLOR.ink)}">${name ? `Здравствуйте, ${escapeHtml(name)}!` : "Здравствуйте!"}</td></tr>`,
    "<tr><td>",
    ...cardHtml,
    "</td></tr>",
    ...buttonHtml,
    "</table>",
    "</td></tr>",
    // Подпись мелко и ссылка текстом на случай, если кнопка не открывается.
    `<tr><td class="mts-pad" style="padding:16px 24px 0;${font(12, 18, COLOR.muted)}">`,
    `<p style="margin:0;${font(12, 18, COLOR.muted)}">Письмо отправлено автоматически CRM МедТехСервис.</p>`,
    ...(href ? [`<p style="margin:4px 0 0;${font(12, 18, COLOR.muted)}">Если кнопка не работает, откройте ссылку:<br><a href="${href}" target="_blank" style="color:${COLOR.accentDark};text-decoration:underline;word-break:break-all;">${href}</a></p>`] : []),
    "</td></tr>",
    "</table>",
    "<!--[if mso]></td></tr></table><![endif]-->",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>"
  ].join("\n");
}
