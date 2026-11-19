import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

/**
 * Единая шкала шрифта (встречи 18.11 и 19.11: «не 10 видов шрифтов, всё единое», «пусть будет не 7, а 5»).
 * Новые размеры, межстрочные и начертания не заводим: только из шкалы в начале styles.css.
 * Проверяем и стили, и классы Tailwind в разметке: text-sm (14px) и text-lg (18px) обходили шкалу.
 */
const SIZES = ["8px", "12px", "13px", "16px", "20px", "24px"];
const TAILWIND_SIZES = ["text-xs", "text-base", "text-xl", "text-2xl", "text-[12px]", "text-[13px]", "text-[16px]", "text-[20px]", "text-[24px]"];

async function markupFiles(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) return markupFiles(url);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [await readFile(url, "utf8")] : [];
  }));
  return nested.flat();
}

describe("шкала шрифта", () => {
  it("в стилях пять размеров: 12, 13, 16, 20, 24 (и 8 — точки-значки); «плавающих» clamp нет", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    const sizes = new Set([...css.matchAll(/font-size:\s*([^;!}]+)/gu)].map((match) => (match[1] ?? "").trim()));
    assert.deepEqual([...sizes].filter((size) => !SIZES.includes(size) && size !== "inherit" && size !== "0"), []);
  });

  it("межстрочных три: 1, 1.25, 1.45", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    const heights = new Set([...css.matchAll(/line-height:\s*([^;!}]+)/gu)].map((match) => (match[1] ?? "").trim()));
    assert.deepEqual([...heights].filter((height) => !["1", "1.25", "1.45", "inherit"].includes(height)), []);
  });

  it("классы Tailwind в разметке — из той же шкалы", async () => {
    const files = await markupFiles(new URL("./", import.meta.url));
    const used = new Set(files.flatMap((source) => [...source.matchAll(/\btext-(?:xs|sm|base|lg|xl|[2-9]xl|\[[0-9.]+px\])(?![\w-])/gu)].map((match) => match[0])));
    assert.deepEqual([...used].filter((name) => !TAILWIND_SIZES.includes(name)), []);
    const leading = new Set(files.flatMap((source) => [...source.matchAll(/\bleading-(?:\d+|\[[^\]]+\]|none|tight|snug|normal|relaxed|loose)(?![\w-])/gu)].map((match) => match[0])));
    assert.deepEqual([...leading].filter((name) => !["leading-[1.25]", "leading-[1.45]", "leading-none"].includes(name)), []);
  });

  it("начертаний четыре: 400, 500, 600, 700; жирный у strong — 700, а не «bolder»", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    const weights = new Set([...css.matchAll(/font-weight:\s*([0-9a-z]+)/gu)].map((match) => match[1] ?? ""));
    assert.deepEqual([...weights].filter((weight) => !["400", "500", "600", "700"].includes(weight)), []);
    assert.match(css, /strong, b \{ font-weight: 700; \}/u);
  });
});
