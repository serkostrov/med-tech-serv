import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AutoTextarea, textareaHeight } from "./components/ui/auto-textarea.js";

describe("поле текста под содержимое", () => {
  it("растёт ровно под текст, без прокрутки внутри", () => {
    assert.deepEqual(
      textareaHeight({ scrollHeight: 118, borders: 2, paddings: 16, borderBox: true, viewportHeight: 900 }),
      { height: 120, scroll: false }
    );
  });

  it("выше 60% экрана не растёт, дальше прокрутка", () => {
    assert.deepEqual(
      textareaHeight({ scrollHeight: 2000, borders: 2, paddings: 16, borderBox: true, viewportHeight: 800 }),
      { height: 480, scroll: true }
    );
  });

  it("на маленьком экране всё равно не меньше 160 px до прокрутки", () => {
    assert.deepEqual(
      textareaHeight({ scrollHeight: 150, borders: 2, paddings: 16, borderBox: true, viewportHeight: 200 }),
      { height: 152, scroll: false }
    );
  });

  it("при content-box вычитает рамку и отступы", () => {
    assert.deepEqual(
      textareaHeight({ scrollHeight: 118, borders: 2, paddings: 16, borderBox: false, viewportHeight: 900 }),
      { height: 102, scroll: false }
    );
  });

  it("рисуется обычным textarea с текстом и атрибутами", () => {
    const markup = renderToStaticMarkup(createElement(AutoTextarea, { defaultValue: "Не включается", name: "comment", rows: 3 }));
    assert.match(markup, /^<textarea[^>]*name="comment"[^>]*>Не включается<\/textarea>$/u);
    assert.match(markup, /style="resize:none"/u);
  });
});
