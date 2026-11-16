import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { detectReceiptColumns, receiptFileProblem, receiptPreviewSummary, receiptRowsFromSheet } from "./stock-receipt-import.js";

const INVOICE: readonly (readonly string[])[] = [
  ["ООО «Поставщик»", "", "", "", ""],
  ["Накладная 108 от 14.11.2026", "", "", "", ""],
  ["", "", "", "", ""],
  ["Артикул поставщика", "Наименование", "Кол-во, шт.", "Состояние", "Цена, ₽"],
  ["12V20W-AU", "Лампа галогеновая", "4", "Н", "1 500,50"],
  ["", "", "", "", ""],
  ["XN-FILTER-WB", "Фильтр цельной крови", "10", "", "320"]
];

describe("накладная файлом: раскладка по колонкам", () => {
  it("находит строку заголовков под шапкой документа", () => {
    assert.deepEqual(detectReceiptColumns(INVOICE), { article: 0, name: 1, quantity: 2, condition: 3, price: 4, headerRow: 4 });
  });

  it("узнаёт колонки по началу слова и не путается в регистре и «ё»", () => {
    const columns = detectReceiptColumns([["КОЛИЧЕСТВО", "Артикул", "Цена за единицу", "Сост.", "Наимен."]]);
    assert.deepEqual(columns, { article: 1, name: 4, quantity: 0, condition: 3, price: 2, headerRow: 1 });
  });

  it("без понятных заголовков берёт порядок по умолчанию и считает строки с первой", () => {
    const rows = [["AU-1", "Лампа", "2", "Н", "100"]];
    const columns = detectReceiptColumns(rows);
    assert.equal(columns.headerRow, 0);
    assert.deepEqual(receiptRowsFromSheet(rows, columns), [
      { row: 1, article: "AU-1", quantity: "2", condition: "Н", unit_price: "100" }
    ]);
  });

  it("строки идут с номерами из файла, пустые пропускаются, комментарий общий", () => {
    const columns = detectReceiptColumns(INVOICE);
    assert.deepEqual(receiptRowsFromSheet(INVOICE, columns, " Накладная 108 "), [
      { row: 5, article: "12V20W-AU", quantity: "4", condition: "Н", unit_price: "1 500,50", comment: "Накладная 108" },
      // Шестая строка в файле пустая: её пропустили, а нумерация не сдвинулась.
      { row: 7, article: "XN-FILTER-WB", quantity: "10", condition: "", unit_price: "320", comment: "Накладная 108" }
    ]);
  });

  it("числа и состояния не трогает: их разбирает база, одинаково для предпросмотра и прихода", () => {
    const [first] = receiptRowsFromSheet(INVOICE, detectReceiptColumns(INVOICE));
    assert.equal(first?.quantity, "4");
    assert.equal(first?.unit_price, "1 500,50");
  });

  it("о том, чего база не увидит, говорит страница: пустой файл и файл без артикулов", () => {
    const empty = detectReceiptColumns([]);
    assert.match(String(receiptFileProblem([], empty, [])), /Файл пустой/u);
    const onlyHeader = [["Артикул", "Кол-во"]];
    assert.match(String(receiptFileProblem(onlyHeader, detectReceiptColumns(onlyHeader), [])), /Под строкой заголовков/u);
    const noArticle = [["", "Лампа", "5", "Н", ""], ["", "Фильтр", "2", "Н", ""]];
    const columns = detectReceiptColumns(noArticle);
    const prepared = receiptRowsFromSheet(noArticle, columns);
    assert.match(String(receiptFileProblem(noArticle, columns, prepared)), /Не нашлась колонка с артикулом/u);
  });

  it("готовый файл проблемой не считается", () => {
    const columns = detectReceiptColumns(INVOICE);
    assert.equal(receiptFileProblem(INVOICE, columns, receiptRowsFromSheet(INVOICE, columns)), undefined);
  });

  it("сводка считает готовые строки, ошибки, количество и находки по псевдониму", () => {
    assert.deepEqual(receiptPreviewSummary([
      { quantity: 4, matchedBy: "alias" },
      { quantity: 10, matchedBy: "article" },
      { error: "Артикул «НЕТ-ТАКОГО» на складе не найден" },
      { quantity: 2.5, matchedBy: "article" }
    ]), { ready: 3, broken: 1, quantity: 16.5, byAlias: 1 });
  });

  it("тексты отказов живут только в базе: страница их не придумывает", async () => {
    const source = await readFile(new URL("./stock-receipt-import.ts", import.meta.url), "utf8");
    // Про строки говорит база (preview_stock_receipt): иначе человек увидел бы одно,
    // а при приходе получил другое.
    assert.doesNotMatch(source, /не найден|снята с учёта|должно быть числом/u);
  });
});
