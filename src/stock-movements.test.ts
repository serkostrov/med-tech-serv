import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  MOVEMENT_LABELS,
  MOVEMENT_TONES,
  conditionTotalsText,
  conditionTotalsTitle,
  conditionWithMostStock,
  conditionsWithStock,
  movementDeltaText,
  movementQuantityText,
  movementTargetText,
  movementWhenText
} from "./stock-movements.js";

describe("склад: подписи к движениям и остаткам по состояниям", () => {
  it("каждому типу движения базы есть русское название и свой цвет", async () => {
    // Типы живут в базе (stock_movement_type, миграция 0001): ни один не должен остаться без подписи.
    const init = await readFile(new URL("../supabase/migrations/0001_init.sql", import.meta.url), "utf8");
    const block = init.slice(init.indexOf("CREATE TYPE stock_movement_type"), init.indexOf("CREATE TYPE invoice_status"));
    const types = [...block.matchAll(/'([a-z]+)'/gu)].map((match) => match[1] as string);
    assert.ok(types.includes("writeoff") && types.includes("adjustment"), "типы движений прочитаны");
    for (const type of types) {
      assert.ok(MOVEMENT_LABELS[type as keyof typeof MOVEMENT_LABELS], `название для ${type}`);
      assert.ok(MOVEMENT_TONES[type as keyof typeof MOVEMENT_TONES], `цвет для ${type}`);
    }
  });

  it("изменение остатка пишется со знаком, а перестановка внутри склада — нулём", () => {
    assert.equal(movementDeltaText(5), "+5");
    assert.equal(movementDeltaText(-2), "−2");
    assert.equal(movementDeltaText(0), "0");
    assert.equal(movementDeltaText(-2.5), "−2,5");
  });

  it("количество целыми в штуках, дробное через запятую", () => {
    assert.equal(movementQuantityText(3), "3 шт.");
    assert.equal(movementQuantityText(2.5), "2,5");
  });

  it("к чему движение относится: задача, резерв, прибор — и ничего лишнего", () => {
    assert.equal(movementTargetText({ taskNumber: "З-000045", reservationNumber: "Р-000112", equipmentSerialNumber: "XN-004512" }),
      "задача З-000045 · резерв Р-000112 · прибор XN-004512");
    assert.equal(movementTargetText({}), "");
  });

  it("когда и кто: без автора остаётся только время", () => {
    assert.equal(movementWhenText({ occurredAt: "2026-11-14T09:30:00+03:00", actorName: "Никитина Ольга Павловна" }),
      "14.11.2026 09:30 · Никитина Ольга Павловна");
    assert.equal(movementWhenText({ occurredAt: "2026-11-14T09:30:00+03:00" }), "14.11.2026 09:30");
  });

  it("остаток по состояниям: только то, что есть, в порядке Г, Н, Б", () => {
    assert.equal(conditionTotalsText({ G: 1, N: 6, B: 0 }), "1 Г · 6 Н");
    // Считаем по-русски: «1 гарантийная», а не «1 гарантийных».
    assert.equal(conditionTotalsTitle({ G: 1, N: 6, B: 0 }), "1 гарантийная, 6 новых");
    assert.equal(conditionTotalsTitle({ G: 2, N: 21, B: 5 }), "2 гарантийные, 21 новая, 5 б/у");
    // Дробное количество (метры трубки) склонять не пытаемся.
    assert.equal(conditionTotalsTitle({ G: 0, N: 2.5, B: 0 }), "2,5 новых");
    assert.equal(conditionTotalsText({ G: 0, N: 0, B: 0 }), "—");
    assert.equal(conditionTotalsTitle({ G: 0, N: 0, B: 0 }), "ни в одном состоянии нет");
    assert.equal(conditionTotalsText({ G: 0, N: 2.5, B: 3 }), "2,5 Н · 3 Б");
  });

  it("в форме подставляется состояние, где запчастей больше всего", () => {
    assert.deepEqual(conditionsWithStock({ G: 1, N: 0, B: 4 }), ["G", "B"]);
    assert.equal(conditionWithMostStock({ G: 1, N: 0, B: 4 }), "B");
    // Всё гарантийное разобрано под задачи: списание предложит то, что ещё доступно.
    assert.equal(conditionWithMostStock({ G: 0, N: 2, B: 0 }), "N");
    // Пусто везде (корректировка по позиции без остатка) — новая, обычный приход.
    assert.equal(conditionWithMostStock({ G: 0, N: 0, B: 0 }), "N");
  });

  it("цена прихода не попадает ни в карточку позиции, ни в приход файлом", async () => {
    // Колонка закрыта от склада и инженера (0040): ни один экран её не спрашивает и не печатает.
    const [card, importDialog, movements] = await Promise.all([
      readFile(new URL("./InventoryPartCard.tsx", import.meta.url), "utf8"),
      readFile(new URL("./StockReceiptImport.tsx", import.meta.url), "utf8"),
      readFile(new URL("./stock-movements.ts", import.meta.url), "utf8")
    ]);
    for (const source of [card, importDialog, movements]) {
      assert.doesNotMatch(source, /receipt_unit_price/u);
    }
    // В карточке цена только вводится при приходе, обратно не читается.
    assert.match(card, /name="unitPrice"/u);
    assert.doesNotMatch(card, /part\.unitPrice|movement\.unitPrice/u);
  });
});
