import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

/**
 * Единая шкала шрифта (вторая встреча 18.11: «не 10 видов шрифтов, всё единое»).
 * Новые размеры и начертания не заводим: только из шкалы в начале styles.css.
 */
describe("шкала шрифта", () => {
  it("в стилях только размеры шкалы: 11, 12, 13, 14, 16, 20, 24 (и 8 — точки-значки)", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    const sizes = new Set([...css.matchAll(/font-size:\s*([0-9.]+(?:px|rem|em))/gu)].map((match) => match[1]));
    assert.deepEqual([...sizes].filter((size) => !["8px", "11px", "12px", "13px", "14px", "16px", "20px", "24px"].includes(size)), []);
  });

  it("начертаний четыре: 400, 500, 600, 700; жирный у strong — 700, а не «bolder»", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    const weights = new Set([...css.matchAll(/font-weight:\s*([0-9a-z]+)/gu)].map((match) => match[1]));
    assert.deepEqual([...weights].filter((weight) => !["400", "500", "600", "700"].includes(weight)), []);
    assert.match(css, /strong, b \{ font-weight: 700; \}/u);
  });
});
