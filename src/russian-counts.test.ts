import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { formatRussianCount, russianCountForm } from "./equipment-changes.js";

/** Выражение похоже на счётчик штук: именно к таким числам нужно правильное окончание. */
const COUNT_EXPRESSION = /(?:\.length|\.size|[Cc]ount\b|[Tt]otal\b)/u;

/** Слова, которые при числе не меняются или вообще не считают штуки. */
const UNCHANGED_AFTER_NUMBER = new Set(["из", "фото", "видео", "шт", "МБ", "КБ"]);

/** Выражение в `${…}` или `{…}`, которое стоит прямо перед словом. */
function expressionBefore(source: string, closeIndex: number): string | null {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    const char = source[index];
    if (char === "}") depth += 1;
    else if (char === "{") {
      depth -= 1;
      if (depth === 0) return source.slice(index + 1, closeIndex);
    }
  }
  return null;
}

/**
 * Куски исходника внутри вызова общего помощника: там слово уже выбрано по форме числа,
 * и склеенным оно только выглядит («Станет бесплатной ${count} строка…»).
 */
function helperCallRanges(source: string): readonly (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  for (const match of source.matchAll(/(?:formatRussianCount|russianCountForm)\s*\(/gu)) {
    let depth = 0;
    for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) { ranges.push([match.index, index]); break; }
      }
    }
  }
  return ranges;
}

async function sourceFiles(): Promise<readonly string[]> {
  const root = new URL("./", import.meta.url);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.includes(".test."))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .sort();
}

describe("окончания в числах", () => {
  it("склоняет слово по числу: 1 строка, 2 строки, 5 строк", () => {
    const forms = ["строка", "строки", "строк"] as const;
    assert.equal(formatRussianCount(0, forms), "0 строк");
    assert.equal(formatRussianCount(1, forms), "1 строка");
    assert.equal(formatRussianCount(2, forms), "2 строки");
    assert.equal(formatRussianCount(4, forms), "4 строки");
    assert.equal(formatRussianCount(5, forms), "5 строк");
    assert.equal(formatRussianCount(11, forms), "11 строк");
    assert.equal(formatRussianCount(12, forms), "12 строк");
    assert.equal(formatRussianCount(14, forms), "14 строк");
    assert.equal(formatRussianCount(21, forms), "21 строка");
    assert.equal(formatRussianCount(22, forms), "22 строки");
    assert.equal(formatRussianCount(25, forms), "25 строк");
    assert.equal(formatRussianCount(111, forms), "111 строк");
    assert.equal(formatRussianCount(241, forms), "241 строка");
  });

  it("даёт форму и для глагола рядом с числом", () => {
    const verb = ["Изменится", "Изменятся", "Изменятся"] as const;
    assert.equal(russianCountForm(1, verb), "Изменится");
    assert.equal(russianCountForm(2, verb), "Изменятся");
    assert.equal(russianCountForm(5, verb), "Изменятся");
    assert.equal(russianCountForm(11, verb), "Изменятся");
    assert.equal(russianCountForm(21, verb), "Изменится");
  });

  it("находки аудита 15, 22, 33, 42 и 58 посчитаны правильным помощником", async () => {
    const [app, operations, customers, price] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./OperationsPages.tsx", import.meta.url), "utf8"),
      readFile(new URL("./CustomerReferencesPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("./PricePage.tsx", import.meta.url), "utf8")
    ]);
    // 15: «Инженеры» — «4 человека» и подсказка «Загрузка: 4 задачи».
    assert.match(operations, /formatRussianCount\(engineers\.length, \["человек", "человека", "человек"\]\)/u);
    assert.match(operations, /formatRussianCount\(engineer\.assignedTaskCount, \["задача", "задачи", "задач"\]\)/u);
    // 42: «Отчёты» — «241 заявка».
    assert.match(operations, /formatRussianCount\(report\.metrics\.taskCount, \["заявка", "заявки", "заявок"\]\)/u);
    // 58: «Склад» — «1 позиция», в обоих видах раздела.
    assert.equal(operations.match(/formatRussianCount\(total, \["позиция", "позиции", "позиций"\]\)/gu)?.length, 2);
    // 22: «Клиенты», блок «Без площадки» — «1 активная запись».
    assert.match(customers, /formatRussianCount\(orphanPayers\.filter[^\n]*\["активная запись", "активные записи", "активных записей"\]\)/u);
    // 33: справочники — «1 активная запись · 1 неактивная», шаблоны, разделы и счета.
    assert.match(app, /\["активная запись", "активные записи", "активных записей"\]/u);
    assert.match(app, /\["неактивная", "неактивные", "неактивных"\]/u);
    assert.match(app, /formatRussianCount\(catalogs\.length, \["справочник", "справочника", "справочников"\]\)/u);
    assert.match(app, /formatRussianCount\(templates\.length, \["шаблон", "шаблона", "шаблонов"\]\)/u);
    assert.match(app, /formatRussianCount\(invoices\.length, \["документ", "документа", "документов"\]\)/u);
    // 15: в карточке задачи у числа фото — «из»: «Фото с выезда: 1 из 2» (встреча 18.11: без «добавьте ещё»).
    assert.match(app, /Фото с выезда: \$\{photoCount\} из \$\{MIN_CLOSURE_PHOTOS\}/u);
    // «Изменится 2 строки» — согласован и глагол.
    assert.match(price, /russianCountForm\(items\.length, \["Изменится", "Изменятся", "Изменятся"\]\)/u);
  });

  it("счётчик штук нигде не склеен со словом напрямую", async () => {
    const files = await sourceFiles();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const ranges = helperCallRanges(source);
      for (const match of source.matchAll(/\}[ \u00A0]?([А-Яа-яЁё]+)/gu)) {
        const word = match[1] ?? "";
        if (UNCHANGED_AFTER_NUMBER.has(word)) continue;
        // Внутри вызова помощника все три формы написаны рядом, проверять нечего.
        if (ranges.some(([from, to]) => match.index > from && match.index < to)) continue;
        const expression = expressionBefore(source, match.index);
        if (expression === null || !COUNT_EXPRESSION.test(expression)) continue;
        // Слово уже взято из общего помощника, дальше идёт обычный текст.
        if (/(?:formatRussianCount|russianCountForm)\s*\(/u.test(expression)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${file.split("/src/")[1] ?? file}:${line} — «${expression.trim()} ${word}»`);
      }
    }
    assert.deepEqual(violations, [], `Число нужно считать через formatRussianCount:\n${violations.join("\n")}`);
  });
});
