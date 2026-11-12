import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { chatIdWidgetHtml, clipText, clipUtf16, formatTaskPeriod, taskWidgetHtml, widgetFitsLimits, WIDGET_COMPRESSED_LIMIT_BYTES, WIDGET_HTML_LIMIT_BYTES } from "./telegram-widget.js";

describe("карточки Telegram", () => {
  it("экранирует данные задачи: текст из задачи не становится разметкой", () => {
    const html = taskWidgetHtml({ eventCode: "task_work_completed", taskNumber: "З-1", taskTitle: "<img src=x onerror=alert(1)>", siteName: "\"ГКБ\" & 'КДЛ'" });
    assert.doesNotMatch(html, /<img/u);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
    assert.match(html, /&quot;ГКБ&quot; &amp; &#39;КДЛ&#39;/u);
    assert.doesNotMatch(html, /<script/u);
    // Цвет этапа «на проверке» — точкой перед названием, без повторения номера и этапа текстом.
    assert.match(html, /--k:#1c66b8/u);
    assert.doesNotMatch(html, />З-1</u);
  });

  it("укладывается в лимиты Telegram даже с очень длинными полями", () => {
    const long = "Очень длинный текст задачи с подробностями ".repeat(60);
    const html = taskWidgetHtml({
      eventCode: "task_rework_requested", taskNumber: "З-000003", taskTitle: long, siteName: long, engineerName: long,
      periodFrom: "2026-11-12T00:00:00Z", periodTo: "2026-12-03T00:00:00Z", reworkComment: `${long}\n\n\n\n${long}`
    });
    assert.ok(Buffer.byteLength(html, "utf8") <= WIDGET_HTML_LIMIT_BYTES);
    assert.ok(deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length <= WIDGET_COMPRESSED_LIMIT_BYTES);
    assert.ok(widgetFitsLimits(html));
    assert.match(html, /…/u);
    assert.match(html, /Что доработать/u);
    assert.equal(widgetFitsLimits(""), false);
  });

  it("комментарий «Что доработать» только при возврате на доработку, инженер «не назначен» серым", () => {
    const assigned = taskWidgetHtml({ eventCode: "task_engineer_assigned", taskTitle: "Ремонт", reworkComment: "старый комментарий" });
    assert.doesNotMatch(assigned, /Что доработать|старый комментарий/u);
    assert.match(assigned, /class="x">не назначен/u);
  });

  it("пишет срок коротко", () => {
    assert.equal(formatTaskPeriod("2026-11-12T00:00:00+03:00", "2026-11-13T00:00:00+03:00"), "12–13 нояб");
    assert.equal(formatTaskPeriod("2026-11-12T00:00:00+03:00", "2026-11-12T18:00:00+03:00"), "12 нояб");
    assert.equal(formatTaskPeriod("2026-11-28T00:00:00+03:00", "2026-12-03T00:00:00+03:00"), "28 нояб – 3 дек");
    assert.equal(formatTaskPeriod(undefined, "2026-11-13T00:00:00+03:00"), "до 13 нояб");
    assert.equal(formatTaskPeriod(undefined, undefined), undefined);
    assert.equal(formatTaskPeriod("не дата", undefined), undefined);
  });

  it("считает длину как Telegram (UTF-16) и не разрывает эмодзи", () => {
    assert.equal(clipUtf16("абв", 5), "абв");
    const emoji = "😀".repeat(10);
    const clipped = clipUtf16(emoji, 7);
    assert.ok(clipped.length <= 7);
    assert.ok(!/[\ud800-\udbff]…$/u.test(clipped));
    assert.equal(clipped, "😀😀😀…");
  });

  it("обрезает текст по символам с многоточием", () => {
    assert.equal(clipText("  а   б  ", 10), "а б");
    assert.equal(clipText("абвгдеёжз", 5), "абвг…");
    assert.equal(clipText("   ", 5), undefined);
  });

  it("карточка номера чата с кнопкой копирования принимает только цифры", () => {
    const html = chatIdWidgetHtml("808374187");
    assert.match(html, /TelegramWidget\.copyText\('808374187'\)/u);
    assert.match(html, /Скопировать номер/u);
    assert.ok(widgetFitsLimits(html));
    assert.throws(() => chatIdWidgetHtml("1');alert('x"));
  });
});
