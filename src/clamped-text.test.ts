import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ClampedText } from "./ClampedText.js";

describe("длинный текст в строке списка", () => {
  it("весь текст в разметке, ограничение в 4 строки задаёт класс", () => {
    const markup = renderToStaticMarkup(createElement(ClampedText, { className: "mail-recognized__summary", text: "Анализатор не включается" }));
    assert.equal(markup, '<span class="mail-recognized__summary clamped-text">Анализатор не включается</span>');
  });

  it("без своего класса остаётся только ограничение", () => {
    assert.equal(renderToStaticMarkup(createElement(ClampedText, { text: "Текст" })), '<span class="clamped-text">Текст</span>');
  });
});
