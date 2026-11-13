import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskEmailHtml } from "./email-html.js";
import type { TaskCardData } from "./task-card.js";
import { taskWidgetHtml, widgetFitsLimits } from "./telegram-widget.js";

const taskUrl = "https://crm.example.test/tasks/00000000-0000-4000-8000-000000000139";
const card: TaskCardData = {
  eventCode: "task_engineer_assigned",
  recipientName: "Анна Сергеевна",
  taskNumber: "З-000007",
  taskTitle: "Замена датчика давления",
  siteName: "ГКБ №1, КДЛ",
  engineerName: "Иванов П. А.",
  periodFrom: "2026-11-12",
  periodTo: "2026-11-13"
};

/** Резерв из примера ТЗ: клапан 115-107131-00, 1 шт., новая, задача З-000041. */
const stock: TaskCardData = {
  eventCode: "stock_reservation_created",
  recipientName: "Кладовщик один",
  reservationNumber: "Р-000012",
  partArticle: "115-107131-00",
  partName: "клапан",
  quantity: "1",
  condition: "новая",
  taskNumber: "З-000041",
  taskTitle: "Ремонт BS-620",
  siteName: "ГКБ № 1",
  engineerName: "Иванов П. А."
};

function count(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

describe("HTML-письмо о задаче", () => {
  it("экранирует данные задачи, имя, тему и ссылку: текст из задачи не становится разметкой", () => {
    const html = taskEmailHtml({
      eventCode: "task_rework_requested",
      recipientName: "<b>Иван</b> & \"Ко\"",
      taskNumber: "З-1<script>",
      taskTitle: "<img src=x onerror=alert(1)>",
      siteName: "\"ГКБ\" & 'КДЛ'",
      engineerName: "<script>alert(1)</script>",
      reworkComment: "</td></tr></table><a href=\"javascript:alert(1)\">x</a>"
    }, { taskUrl: "https://crm.example.test/tasks/a\"onmouseover=\"alert(1)", subject: "Тема </title><script>" });
    assert.doesNotMatch(html, /<img|<script|<b>Иван|href="javascript:/u);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
    assert.match(html, /&quot;ГКБ&quot; &amp; &#39;КДЛ&#39;/u);
    assert.match(html, /Здравствуйте, &lt;b&gt;Иван&lt;\/b&gt; &amp; &quot;Ко&quot;!/u);
    assert.match(html, /<title>Тема &lt;\/title&gt;&lt;script&gt;<\/title>/u);
    assert.match(html, /&lt;\/td&gt;&lt;\/tr&gt;&lt;\/table&gt;&lt;a href=&quot;javascript:alert\(1\)&quot;&gt;x&lt;\/a&gt;/u);
    // Кавычка в ссылке не закрывает атрибут: ссылок ровно две, кнопка и строка внизу.
    assert.match(html, /href="https:\/\/crm\.example\.test\/tasks\/a&quot;onmouseover=&quot;alert\(1\)"/u);
    assert.equal(count(html, /<a /gu), 2);
  });

  it("карточка при разных событиях: цвет этапа и текст события те же, что в Telegram", () => {
    const looks = [
      ["task_application_accepted", "Заявка принята", "#52627a"],
      ["task_engineer_assigned", "Назначен инженер", "#946300"],
      ["task_engineer_accepted", "Инженер принял задачу", "#1d7f47"],
      ["task_work_completed", "Работы завершены", "#1c66b8"],
      ["task_rework_requested", "Возвращена на доработку", "#b9570c"],
      ["task_overdue", "Задача просрочена", "#bf3434"],
      ["equipment_moved", "Изменения по задаче", "#52627a"]
    ] as const;
    for (const [eventCode, event, color] of looks) {
      const html = taskEmailHtml({ ...card, eventCode }, { taskUrl });
      assert.match(html, new RegExp(`<h1 style="[^"]*color:${color};[^"]*">Замена датчика давления</h1>`, "u"), eventCode);
      assert.match(html, new RegExp(`border-top:3px solid ${color};`, "u"), eventCode);
      assert.match(html, new RegExp(`>${event} <span style="color:#445863;">· З-000007</span></p>`, "u"), eventCode);
      const widget = taskWidgetHtml({ ...card, eventCode });
      assert.match(widget, new RegExp(`--k:${color}`, "u"), eventCode);
      assert.match(widget, new RegExp(`<p class="e">${event} <span>· З-000007</span></p>`, "u"), eventCode);
    }
  });

  it("«Что доработать» только при возврате на доработку, переносы строк сохраняются", () => {
    const rework = taskEmailHtml({ ...card, eventCode: "task_rework_requested", reworkComment: "Нет фото\r\n\r\n\r\nакта   и подписи" }, { taskUrl });
    assert.match(rework, /color:#b9570c;font-weight:600;">Что доработать<\/p>/u);
    assert.match(rework, />Нет фото<br><br>акта и подписи<\/p>/u);
    // Фон блока — цвет этапа, смешанный с белым: rgba понимают не все почтовые программы.
    assert.match(rework, /bgcolor="#f8eee7"/u);
    assert.doesNotMatch(rework, /rgba\(/u);

    const assigned = taskEmailHtml({ ...card, reworkComment: "старый комментарий" }, { taskUrl });
    assert.doesNotMatch(assigned, /Что доработать|старый комментарий/u);
    const empty = taskEmailHtml({ ...card, eventCode: "task_rework_requested", reworkComment: "   " }, { taskUrl });
    assert.doesNotMatch(empty, /Что доработать/u);
  });

  it("строки карточки: площадка, инженер, срок; «не назначен» серым, пустые строки не выводятся", () => {
    const html = taskEmailHtml(card, { taskUrl });
    assert.match(html, />Площадка<\/td><td [^>]*color:#17232c;[^>]*>ГКБ №1, КДЛ<\/td>/u);
    assert.match(html, />Инженер<\/td><td [^>]*color:#17232c;[^>]*>Иванов П\. А\.<\/td>/u);
    assert.match(html, />Срок<\/td><td [^>]*>12–13 ноября<\/td>/u);

    const bare = taskEmailHtml({ eventCode: "task_application_accepted", engineerName: "не назначен" }, { taskUrl });
    assert.match(bare, />Без названия<\/h1>/u);
    assert.match(bare, />Инженер<\/td><td [^>]*color:#445863;[^>]*>не назначен<\/td>/u);
    assert.doesNotMatch(bare, /Площадка|Срок/u);
    assert.match(taskEmailHtml({ ...card, periodFrom: "2026-11-28", periodTo: "2026-12-03" }), />28 ноября – 3 декабря</u);
    assert.match(taskEmailHtml({ eventCode: "task_overdue" }), />Инженер<\/td><td [^>]*>не назначен</u);
  });

  it("шапка, приветствие, кнопка таблицей с фоном и подпись со ссылкой текстом", () => {
    const html = taskEmailHtml(card, { taskUrl, subject: "По задаче З-000007 назначен инженер" });
    assert.match(html, /^<!DOCTYPE html>\n<html lang="ru"/u);
    assert.match(html, /charset=utf-8/u);
    assert.match(html, /<td class="mts-pad" bgcolor="#132029"[^>]*>/u);
    assert.match(html, /МедТехСервис<\/td>/u);
    assert.match(html, />Здравствуйте, Анна Сергеевна!<\/td>/u);
    // Кнопка: фон у ячейки таблицы (bgcolor), а не только CSS у ссылки.
    assert.match(html, new RegExp(`<td align="center" bgcolor="#0e6e99" style="[^"]*mso-padding-alt:12px 24px;">\\n<a href="${taskUrl}" target="_blank" style="display:inline-block;[^"]*">Открыть задачу</a>`, "u"));
    assert.match(html, /Письмо отправлено автоматически CRM МедТехСервис\./u);
    assert.match(html, new RegExp(`Если кнопка не работает, откройте ссылку:<br><a href="${taskUrl}"[^>]*>${taskUrl}</a>`, "u"));
    // Скрытая строка для списка писем: название задачи, площадка и срок.
    assert.match(html, /mso-hide:all;[^>]*>Замена датчика давления · ГКБ №1, КДЛ · 12–13 ноября&zwnj;/u);

    assert.match(taskEmailHtml({ ...card, recipientName: "  " }, { taskUrl }), />Здравствуйте!<\/td>/u);
  });

  it("без ссылки на задачу или с небезопасной ссылкой кнопки и ссылки нет", () => {
    for (const options of [{}, { taskUrl: "javascript:alert(1)" }, { taskUrl: "ftp://crm.example.test/tasks/1" }]) {
      const html = taskEmailHtml(card, options);
      assert.doesNotMatch(html, /<a |Открыть задачу|Если кнопка не работает/u);
      assert.match(html, /Письмо отправлено автоматически CRM МедТехСервис\./u);
    }
  });

  it("без внешних картинок, шрифтов и скриптов, ширина до 600 px, теги таблиц закрыты", () => {
    const html = taskEmailHtml({ ...card, eventCode: "task_rework_requested", reworkComment: "Нет акта" }, { taskUrl });
    assert.doesNotMatch(html, /<img|<link|<script|<iframe|src=|url\(|@import|@font-face/iu);
    const urls = [...html.matchAll(/https?:\/\/[^\s"<>]+/gu)].map((match) => match[0]);
    assert.deepEqual([...new Set(urls)].sort(), ["http://www.w3.org/1999/xhtml", taskUrl]);
    assert.match(html, /max-width:600px/u);
    // Ширины в самом письме (в стилях есть только точка перехода для телефонов, 620 px).
    const body = html.slice(html.indexOf("<body"));
    for (const match of body.matchAll(/width="(\d+)"|width:(\d+)px/gu)) assert.ok(Number(match[1] ?? match[2]) <= 600, match[0]);
    for (const tag of ["table", "tr", "td", "p", "h1", "a", "span"]) {
      assert.equal(count(html, new RegExp(`<${tag}[\\s>]`, "gu")), count(html, new RegExp(`</${tag}>`, "gu")), tag);
    }
  });

  it("длинные поля обрезаются: письмо остаётся небольшим", () => {
    const long = "Очень длинный текст задачи с подробностями ".repeat(400);
    const html = taskEmailHtml({ ...card, eventCode: "task_rework_requested", taskTitle: long, siteName: long, engineerName: long, recipientName: long, reworkComment: long }, { taskUrl });
    assert.ok(Buffer.byteLength(html, "utf8") < 40_000);
    assert.match(html, /…<\/h1>/u);
  });

  it("карточка резерва: запчасть в заголовке, номер резерва рядом с событием", () => {
    const html = taskEmailHtml(stock, { taskUrl });
    assert.match(html, /color:#946300;font-weight:700;[^"]*">клапан<\/h1>/u);
    assert.match(html, />Новый резерв запчастей <span style="color:#445863;">· Р-000012<\/span><\/p>/u);
    assert.match(html, />Артикул<\/td><td[^>]*>115-107131-00<\/td>/u);
    assert.match(html, />Количество<\/td><td[^>]*>1 шт\., новая<\/td>/u);
    assert.match(html, />Задача<\/td><td[^>]*>З-000041 «Ремонт BS-620»<\/td>/u);
    assert.match(html, />Площадка<\/td><td[^>]*>ГКБ № 1<\/td>/u);
    assert.match(html, />Инженер<\/td><td[^>]*>Иванов П\. А\.<\/td>/u);
    // Скрытая строка для списка писем: по артикулу и количеству письмо понятно без открытия.
    assert.match(html, /mso-hide:all;[^>]*>клапан · 115-107131-00 · 1 шт\., новая&zwnj;/u);
    // Ссылка ведёт на задачу резерва: кнопка та же, что в задачных письмах.
    assert.match(html, />Открыть задачу<\/a>/u);

    // «Можно забрать»: цвет собранного резерва, про инженера строки нет — он и есть получатель.
    const ready = taskEmailHtml({ ...stock, eventCode: "stock_reservation_ready" }, { taskUrl });
    assert.match(ready, /color:#1c66b8;font-weight:700;[^"]*">клапан<\/h1>/u);
    assert.match(ready, />Запчасти можно забрать <span style="color:#445863;">· Р-000012<\/span><\/p>/u);
    assert.doesNotMatch(ready, />Инженер</u);
  });

  it("карточка резерва в Telegram повторяет письмо", () => {
    const widget = taskWidgetHtml(stock);
    assert.match(widget, /--k:#946300/u);
    assert.match(widget, /<p class="t">клапан<\/p>/u);
    assert.match(widget, /<p class="e">Новый резерв запчастей <span>· Р-000012<\/span><\/p>/u);
    assert.match(widget, /<dt>Артикул<\/dt><dd>115-107131-00<\/dd>/u);
    assert.match(widget, /<dt>Количество<\/dt><dd>1 шт\., новая<\/dd>/u);
    assert.match(widget, /<dt>Задача<\/dt><dd>З-000041 «Ремонт BS-620»<\/dd>/u);
    assert.ok(widgetFitsLimits(widget));

    const ready = taskWidgetHtml({ ...stock, eventCode: "stock_reservation_ready" });
    assert.match(ready, /--k:#1c66b8/u);
    assert.doesNotMatch(ready, /<dt>Инженер<\/dt>/u);
  });

  it("данные резерва экранируются: артикул и название запчасти не становятся разметкой", () => {
    const html = taskEmailHtml({
      eventCode: "stock_reservation_created",
      reservationNumber: "Р-1<script>",
      partArticle: "<img src=x onerror=alert(1)>",
      partName: "<b>клапан</b>",
      quantity: "1\"",
      condition: "новая' & 'б/у",
      taskNumber: "З-1",
      taskTitle: "<script>alert(1)</script>"
    }, { taskUrl });
    assert.doesNotMatch(html, /<img|<script|<b>клапан/u);
    assert.match(html, /&lt;b&gt;клапан&lt;\/b&gt;<\/h1>/u);
    const widget = taskWidgetHtml({ eventCode: "stock_reservation_ready", partName: "<b>клапан</b>", partArticle: "<img src=x>" });
    assert.doesNotMatch(widget, /<img|<b>клапан/u);
  });
});
