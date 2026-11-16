import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { M2ApiClient, M2ApiError } from "./m2-api.js";
import { PricePage } from "./PricePage.js";
import {
  ALL_CATEGORIES_LABEL,
  PRICE_NOT_SET_LABEL,
  bulkPriceItems,
  canDeletePriceRow,
  effectivePriceRow,
  filterPriceLines,
  MAX_PRICE,
  formatMoney,
  guaranteeWorkLabel,
  nextPriceAfter,
  nextPriceAmount,
  parseAmount,
  parseSignedNumber,
  priceAmountOn,
  priceLineAmountText,
  priceLineKey,
  priceLineNextText,
  priceLineStartText,
  priceLines,
  priceRowActiveOn,
  priceRowHistory,
  priceRowPeriodText,
  previewBulkPrices,
  zeroPriceCount,
  roundToKopecks,
  type PriceListRow
} from "./price-list.js";

const WORK_TYPES = [
  { code: "diagnostics", name: "Диагностика" },
  { code: "repair", name: "Ремонт" },
  { code: "maintenance", name: "Техническое обслуживание" }
] as const;

const CATEGORIES = [
  { id: "cat-gold", name: "Гарантия поставщика" },
  { id: "cat-none", name: "Без гарантии" }
] as const;

function row(values: Partial<PriceListRow> & { readonly id: string; readonly validFrom: string; readonly amount: number }): PriceListRow {
  return {
    workTypeCode: "diagnostics",
    guaranteeCategoryId: null,
    validTo: null,
    includeGuaranteeWork: false,
    createdAt: `${values.validFrom}T00:00:00.000Z`,
    ...values
  };
}

/**
 * Диагностика: цена менялась дважды, с нового года будет третья. Периоды не пересекаются —
 * база этого и не допустит, а у действующей цены перед будущей уже стоит дата конца.
 */
const DIAGNOSTICS: readonly PriceListRow[] = [
  row({ id: "d1", validFrom: "2025-01-01", validTo: "2026-03-01", amount: 1000 }),
  row({ id: "d2", validFrom: "2026-03-01", validTo: "2027-01-01", amount: 1500, includeGuaranteeWork: true }),
  row({ id: "d3", validFrom: "2027-01-01", amount: 1800 })
];

const REPAIR: readonly PriceListRow[] = [
  row({ id: "r1", workTypeCode: "repair", validFrom: "2026-01-01", amount: 2000 }),
  row({ id: "r2", workTypeCode: "repair", guaranteeCategoryId: "cat-gold", validFrom: "2026-01-01", amount: 500 })
];

const ROWS: readonly PriceListRow[] = [...DIAGNOSTICS, ...REPAIR];

describe("прайс: действующая цена на дату", () => {
  it("берёт цену того периода, в который попадает дата", () => {
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "diagnostics", on: "2025-06-01" }), 1000);
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "diagnostics", on: "2026-11-16" }), 1500);
    // День начала нового периода уже считается по новой цене, последний день старого — по старой.
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "diagnostics", on: "2026-02-28" }), 1000);
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "diagnostics", on: "2026-03-01" }), 1500);
  });

  it("не отдаёт цену за дату до первого периода и не заглядывает в будущую", () => {
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "diagnostics", on: "2024-12-31" }), undefined);
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "diagnostics", on: "2026-12-31" }), 1500);
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "diagnostics", on: "2027-01-01" }), 1800);
  });

  it("сначала ищет цену категории гарантии, потом цену «для всех»", () => {
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "repair", guaranteeCategoryId: "cat-gold", on: "2026-11-16" }), 500);
    // У этой категории своей цены нет: действует общая, как в work_price_on.
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "repair", guaranteeCategoryId: "cat-none", on: "2026-11-16" }), 2000);
    assert.equal(priceAmountOn(ROWS, { workTypeCode: "repair", on: "2026-11-16" }), 2000);
  });

  it("цены по другому виду работ не подставляет", () => {
    assert.equal(effectivePriceRow(ROWS, { workTypeCode: "maintenance", on: "2026-11-16" }), undefined);
    assert.equal(priceRowActiveOn(DIAGNOSTICS[1] as PriceListRow, "2026-11-16"), true);
    assert.equal(priceRowActiveOn(DIAGNOSTICS[0] as PriceListRow, "2026-11-16"), false);
  });
});

describe("прайс: история по виду работ", () => {
  it("складывает историю одной строки прайса от новых цен к старым", () => {
    const history = priceRowHistory(ROWS, { workTypeCode: "diagnostics" });
    assert.deepEqual(history.map((item) => item.id), ["d3", "d2", "d1"]);
    assert.deepEqual(priceRowHistory(ROWS, { workTypeCode: "repair", guaranteeCategoryId: "cat-gold" }).map((item) => item.id), ["r2"]);
  });

  it("на вид работ даёт строку «для всех» и по строке на каждую категорию с ценой", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    assert.deepEqual(lines.map((line) => line.key), [
      priceLineKey("diagnostics", null),
      priceLineKey("repair", null),
      priceLineKey("repair", "cat-gold"),
      priceLineKey("maintenance", null)
    ]);
    const [diagnostics, repair, repairGold, maintenance] = lines;
    assert.equal(diagnostics?.current?.amount, 1500);
    assert.equal(diagnostics?.next?.amount, 1800);
    assert.deepEqual(diagnostics?.history.map((item) => item.id), ["d3", "d2", "d1"]);
    assert.equal(diagnostics?.guaranteeCategoryName, ALL_CATEGORIES_LABEL);
    assert.equal(repair?.current?.amount, 2000);
    assert.equal(repairGold?.guaranteeCategoryName, "Гарантия поставщика");
    assert.equal(repairGold?.current?.amount, 500);
    // Вид работ без цен из списка не выпадает: с его строки цену и заводят.
    assert.equal(maintenance?.current, undefined);
    assert.deepEqual(maintenance?.history, []);
  });

  it("в строке категории показывает её собственную цену, а не подставленную общую", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    const gold = lines.find((line) => line.key === priceLineKey("repair", "cat-gold"));
    assert.equal(gold?.current?.id, "r2");
    assert.equal(gold?.current?.amount, 500);
  });

  it("ближайшей будущей ценой считает самую раннюю из будущих", () => {
    const rows = [
      row({ id: "f2", validFrom: "2028-01-01", amount: 3000 }),
      row({ id: "f1", validFrom: "2027-01-01", validTo: "2028-01-01", amount: 2000 })
    ];
    const [line] = priceLines({ workTypes: [WORK_TYPES[0]], rows, on: "2026-11-16" });
    assert.equal(line?.next?.id, "f1");
    assert.equal(priceLineNextText({ next: line?.next }), "с 01.01.2027 — 2 000,00 ₽");
  });

  it("пустой справочник и пустой прайс дают пустой список, а не падение", () => {
    assert.deepEqual(priceLines({ workTypes: [], rows: [], on: "2026-11-16" }), []);
    assert.deepEqual(filterPriceLines([], "ремонт"), []);
  });

  it("не теряет цены вида работ, которого нет в справочнике", () => {
    const lines = priceLines({ workTypes: [WORK_TYPES[0]], rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    const codes = lines.map((line) => line.workTypeCode);
    assert.deepEqual(codes, ["diagnostics", "repair", "repair"]);
    assert.equal(lines.at(-1)?.workTypeName, "repair");
  });

  it("ищет строки по виду работ, коду и категории", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    assert.deepEqual(filterPriceLines(lines, " ремонт ").map((line) => line.key), [
      priceLineKey("repair", null),
      priceLineKey("repair", "cat-gold")
    ]);
    assert.deepEqual(filterPriceLines(lines, "поставщика").map((line) => line.key), [priceLineKey("repair", "cat-gold")]);
    assert.deepEqual(filterPriceLines(lines, "diagnostics").map((line) => line.key), [priceLineKey("diagnostics", null)]);
    assert.equal(filterPriceLines(lines, "").length, lines.length);
  });
});

describe("прайс: пока цены нет", () => {
  it("вместо суммы и даты показывает понятный текст, а не ноль", () => {
    const [line] = priceLines({ workTypes: [WORK_TYPES[2]], rows: [], on: "2026-11-16" });
    assert.ok(line);
    assert.equal(priceLineAmountText(line), PRICE_NOT_SET_LABEL);
    assert.equal(priceLineAmountText(line), "Цена не задана");
    assert.equal(priceLineStartText(line), "—");
    assert.equal(priceLineNextText(line), undefined);
  });

  it("пометку про гарантию берёт у действующей цены", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    assert.equal(lines[0]?.current?.includeGuaranteeWork, true);
    assert.equal(guaranteeWorkLabel(true), "Гарантия в счёт");
    assert.equal(guaranteeWorkLabel(false), "Без гарантии");
  });

  it("удалять разрешает только ещё не начавшуюся цену", () => {
    assert.equal(canDeletePriceRow({ validFrom: "2027-01-01" }, "2026-11-16"), true);
    assert.equal(canDeletePriceRow({ validFrom: "2026-11-16" }, "2026-11-16"), false);
    assert.equal(canDeletePriceRow({ validFrom: "2025-01-01" }, "2026-11-16"), false);
  });

  it("период цены в истории пишет с датой конца, а у действующей — без неё", () => {
    assert.equal(priceRowPeriodText({ validFrom: "2025-01-01", validTo: "2026-03-01" }), "01.01.2025 — 01.03.2026");
    assert.equal(priceRowPeriodText({ validFrom: "2026-03-01", validTo: null }), "с 01.03.2026");
  });
});

describe("прайс: куда попадёт цена с выбранной даты", () => {
  it("находит цену, которая начинается позже, — новая будет действовать только до неё", () => {
    const history = priceRowHistory(ROWS, { workTypeCode: "diagnostics" });
    // Дата в прошлом: впереди и действующая цена, и будущая — ближайшая из них 2026-03-01.
    assert.equal(nextPriceAfter(history, "2025-06-01")?.validFrom, "2026-03-01");
    // Правка той же датой трогает саму строку, а не ту, что за ней.
    assert.equal(nextPriceAfter(history, "2026-03-01")?.validFrom, "2027-01-01");
    // Позже всех цен ничего нет: цена станет действующей.
    assert.equal(nextPriceAfter(history, "2027-06-01"), undefined);
    assert.equal(nextPriceAfter([], "2026-11-16"), undefined);
  });
});

describe("прайс: пересчёт процентом и суммой", () => {
  it("округляет до копеек, а не до рублей", () => {
    assert.equal(roundToKopecks(1.005), 1.01);
    assert.equal(roundToKopecks(1234.5649), 1234.56);
    assert.equal(roundToKopecks(1234.565), 1234.57);
    assert.equal(roundToKopecks(0.1 + 0.2), 0.3);
    assert.equal(roundToKopecks(-1.005), -1.01);
    assert.throws(() => roundToKopecks(Number.NaN), /число/u);
    // Самая большая сумма, какую примет numeric(14,2), не должна разъехаться при округлении.
    assert.equal(roundToKopecks(999999999999.99), 999999999999.99);
    assert.equal(parseAmount("999999999999,99"), 999999999999.99);
  });

  it("процентом считает от действующей цены с копейками", () => {
    assert.equal(nextPriceAmount(1500, { mode: "percent", value: 10 }), 1650);
    assert.equal(nextPriceAmount(1234.56, { mode: "percent", value: 7.5 }), 1327.15);
    assert.equal(nextPriceAmount(1000.01, { mode: "percent", value: 3 }), 1030.01);
    assert.equal(nextPriceAmount(1500, { mode: "percent", value: -20 }), 1200);
    // Ниже нуля результат не прижимается к нулю: так ошибку в проценте видно, а не молча
    // применяется 0,00 ₽. Строку с таким результатом предпросмотр пропустит с причиной.
    assert.equal(nextPriceAmount(1500, { mode: "percent", value: -150 }), -750);
    assert.equal(nextPriceAmount(1500, { mode: "percent", value: -200 }), -1500);
    // Ровно −100 % — это ноль, он разрешён.
    assert.equal(nextPriceAmount(1500, { mode: "percent", value: -100 }), 0);
  });

  it("прибавляет и задаёт фиксированную сумму", () => {
    assert.equal(nextPriceAmount(1500, { mode: "delta", value: 250.5 }), 1750.5);
    assert.equal(nextPriceAmount(1500, { mode: "delta", value: -1600 }), -100);
    assert.equal(nextPriceAmount(1500, { mode: "delta", value: -1500 }), 0);
    assert.equal(nextPriceAmount(1500, { mode: "fixed", value: 999.999 }), 1000);
    // Задать сумму можно и там, где цены ещё нет, а процент считать не из чего.
    assert.equal(nextPriceAmount(undefined, { mode: "fixed", value: 700 }), 700);
    assert.equal(nextPriceAmount(undefined, { mode: "percent", value: 10 }), undefined);
    assert.equal(nextPriceAmount(undefined, { mode: "delta", value: 10 }), undefined);
  });

  it("показывает, что получится у каждой выбранной строки, до применения", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    const changes = previewBulkPrices(lines, { mode: "percent", value: 10 });
    assert.deepEqual(changes.map((change) => [change.key, change.before, change.after, change.skipReason]), [
      [priceLineKey("diagnostics", null), 1500, 1650, undefined],
      [priceLineKey("repair", null), 2000, 2200, undefined],
      [priceLineKey("repair", "cat-gold"), 500, 550, undefined],
      [priceLineKey("maintenance", null), undefined, undefined, "Цены ещё нет: процентом и прибавкой считать не из чего"]
    ]);
    // Флаг гарантии остаётся прежним: массовое изменение касается только суммы.
    assert.equal(changes[0]?.includeGuaranteeWork, true);
    assert.equal(changes[1]?.includeGuaranteeWork, false);
    assert.deepEqual(bulkPriceItems(changes), [
      { workTypeCode: "diagnostics", guaranteeCategoryId: null, amount: 1650, includeGuaranteeWork: true },
      { workTypeCode: "repair", guaranteeCategoryId: null, amount: 2200, includeGuaranteeWork: false },
      { workTypeCode: "repair", guaranteeCategoryId: "cat-gold", amount: 550, includeGuaranteeWork: false }
    ]);
  });

  it("считает от цены, действующей на дату начала, а не на сегодня", () => {
    // С 2027-01-01 действует уже 1800, и +10% база посчитает от неё: иначе показанное
    // «1 650,00 ₽» оказалось бы снижением цены.
    const onNewYear = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2027-01-01" });
    const changes = previewBulkPrices(onNewYear.slice(0, 1), { mode: "percent", value: 10 });
    assert.deepEqual(changes.map((change) => [change.before, change.after]), [[1800, 1980]]);
    // Флаг гарантии берём у той же строки: её база и будет править.
    assert.equal(changes[0]?.includeGuaranteeWork, false);
    // На дату, когда цены ещё не было, считать не из чего.
    const onStart = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2024-01-01" });
    assert.equal(previewBulkPrices(onStart.slice(0, 1), { mode: "percent", value: 10 })[0]?.after, undefined);
  });

  it("не отправляет в базу строки, где цена не меняется", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    const changes = previewBulkPrices(lines, { mode: "fixed", value: 1500 });
    assert.equal(changes[0]?.skipReason, "Цена и так такая");
    assert.deepEqual(bulkPriceItems(changes).map((item) => [item.workTypeCode, item.guaranteeCategoryId, item.amount]), [
      ["repair", null, 1500],
      ["repair", "cat-gold", 1500],
      ["maintenance", null, 1500]
    ]);
    assert.deepEqual(bulkPriceItems(previewBulkPrices(lines, { mode: "percent", value: 0 })), []);
  });

  it("минус 200 процентов не обнуляет цены, а объясняет ошибку (находка 40)", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    const changes = previewBulkPrices(lines, { mode: "percent", value: -200 });
    assert.deepEqual(changes.map((change) => [change.before, change.after, change.skipReason]), [
      [1500, -1500, "Цена ушла ниже нуля: снизить больше чем на 100 % нельзя"],
      [2000, -2000, "Цена ушла ниже нуля: снизить больше чем на 100 % нельзя"],
      [500, -500, "Цена ушла ниже нуля: снизить больше чем на 100 % нельзя"],
      [undefined, undefined, "Цены ещё нет: процентом и прибавкой считать не из чего"]
    ]);
    // Главное: в базу не уходит ни одной нулевой цены.
    assert.deepEqual(bulkPriceItems(changes), []);
    assert.equal(zeroPriceCount(changes), 0);
  });

  it("у прибавки и у суммы своя причина про минус", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    assert.equal(previewBulkPrices(lines, { mode: "delta", value: -5000 })[0]?.skipReason, "Цена ушла ниже нуля: проверьте прибавку");
    assert.equal(previewBulkPrices(lines, { mode: "fixed", value: -10 })[0]?.skipReason, "Цена ниже нуля: укажите сумму от нуля");
    assert.deepEqual(bulkPriceItems(previewBulkPrices(lines, { mode: "fixed", value: -10 })), []);
  });

  it("ноль разрешён, но его видно отдельно (находка 39)", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    const zeroed = previewBulkPrices(lines, { mode: "fixed", value: 0 });
    // Ноль применяется: бывает работа, которая в счёт не попадает.
    assert.deepEqual(zeroed.map((change) => [change.after, change.skipReason]), [
      [0, undefined],
      [0, undefined],
      [0, undefined],
      [0, undefined]
    ]);
    assert.equal(zeroPriceCount(zeroed), 4);
    assert.equal(bulkPriceItems(zeroed).length, 4);
    // Минус 100 процентов — тот же ноль, и предупреждение такое же.
    assert.equal(zeroPriceCount(previewBulkPrices(lines, { mode: "percent", value: -100 })), 3);
    // Там, где нулей нет, предупреждать не о чем.
    assert.equal(zeroPriceCount(previewBulkPrices(lines, { mode: "percent", value: 10 })), 0);
  });
});

describe("прайс: суммы в поле и на экране", () => {
  it("пишет сумму разрядами и с копейками", () => {
    assert.equal(formatMoney(1500), "1 500,00 ₽");
    assert.equal(formatMoney(1234567.5), "1 234 567,50 ₽");
    assert.equal(formatMoney(0), "0,00 ₽");
    assert.equal(formatMoney(999.999), "1 000,00 ₽");
    assert.equal(formatMoney(-250.4), "−250,40 ₽");
    assert.equal(formatMoney(Number.NaN), "");
  });

  it("принимает сумму с пробелами и запятой, но не минус и не буквы", () => {
    assert.equal(parseAmount("1 234,56"), 1234.56);
    assert.equal(parseAmount("1 234.56"), 1234.56);
    assert.equal(parseAmount("1234,555"), 1234.56);
    assert.equal(parseAmount("0"), 0);
    assert.equal(parseAmount(""), null);
    assert.equal(parseAmount("-100"), null);
    assert.equal(parseAmount("1 000 ₽"), null);
  });

  it("принимает процент и прибавку со знаком", () => {
    assert.equal(parseSignedNumber("10"), 10);
    assert.equal(parseSignedNumber("+7,5"), 7.5);
    assert.equal(parseSignedNumber("-10"), -10);
    assert.equal(parseSignedNumber("−10"), -10);
    assert.equal(parseSignedNumber(""), null);
    assert.equal(parseSignedNumber("десять"), null);
  });
});

type FakeResponse = { readonly data?: unknown; readonly error?: { readonly message: string; readonly code?: string } | null };

/** Поддельный клиент Supabase: на таблицу и на функцию свой ответ, запоминает цепочку запроса. */
function fakeSupabase(routes: Readonly<Record<string, FakeResponse>>) {
  const requests: { readonly target: string; readonly calls: unknown[][] }[] = [];
  const builder = (target: string, first: unknown[]) => {
    const calls: unknown[][] = [first];
    requests.push({ target, calls });
    const result = Promise.resolve({ data: null, error: null, ...routes[target] });
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "maybeSingle"]) {
      chain[method] = (...args: unknown[]) => { calls.push([method, ...args]); return chain; };
    }
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => result.then(resolve, reject);
    return chain;
  };
  const client = {
    from: (table: string) => builder(table, ["from", table]),
    rpc: (fn: string, args?: unknown) => builder(`rpc:${fn}`, ["rpc", fn, args])
  };
  const of = (target: string) => requests.filter((request) => request.target === target).map((request) => request.calls);
  const step = (calls: readonly unknown[][] | undefined, method: string) => (calls ?? []).filter((call) => call[0] === method).map((call) => call.slice(1));
  return { client: client as never, requests, of, step };
}

describe("прайс: запросы к базе", () => {
  it("читает прайс обычным select и приводит строки к виду экрана", async () => {
    const fake = fakeSupabase({
      price_list: {
        data: [{
          id: "p1", work_type_code: "diagnostics", guarantee_category_id: null,
          valid_from: "2026-03-01", valid_to: null, amount: "1500.00",
          include_guarantee_work: true, created_at: "2026-02-20T10:00:00.000Z"
        }, {
          id: "p2", work_type_code: "repair", guarantee_category_id: "cat-gold",
          valid_from: "2026-01-01", valid_to: "2026-03-01", amount: "500.50",
          include_guarantee_work: false, created_at: "2025-12-20T10:00:00.000Z"
        }]
      }
    });
    const rows = await new M2ApiClient(fake.client).listPriceList();
    const [request] = fake.of("price_list");
    assert.match(String(fake.step(request, "select")[0]?.[0]), /work_type_code, guarantee_category_id, valid_from, valid_to, amount, include_guarantee_work/u);
    assert.deepEqual(fake.step(request, "order"), [["work_type_code", { ascending: true }], ["valid_from", { ascending: false }]]);
    assert.deepEqual(rows[0], {
      id: "p1", workTypeCode: "diagnostics", guaranteeCategoryId: null, validFrom: "2026-03-01", validTo: null,
      amount: 1500, includeGuaranteeWork: true, createdAt: "2026-02-20T10:00:00.000Z"
    });
    assert.deepEqual(rows[1], {
      id: "p2", workTypeCode: "repair", guaranteeCategoryId: "cat-gold", validFrom: "2026-01-01", validTo: "2026-03-01",
      amount: 500.5, includeGuaranteeWork: false, createdAt: "2025-12-20T10:00:00.000Z"
    });
  });

  it("правит цену только через set_work_price", async () => {
    const fake = fakeSupabase({ "rpc:set_work_price": { data: [{ id: "p3", valid_from: "2026-12-01", valid_to: null, amount: "1700.00" }] } });
    await new M2ApiClient(fake.client).setWorkPrice({
      workTypeCode: "diagnostics", guaranteeCategoryId: null, amount: 1700, validFrom: "2026-12-01", includeGuaranteeWork: false
    });
    assert.deepEqual(fake.of("rpc:set_work_price")[0]?.[0], ["rpc", "set_work_price", {
      p_work_type_code: "diagnostics",
      p_guarantee_category_id: null,
      p_amount: 1700,
      p_valid_from: "2026-12-01",
      p_include_guarantee_work: false
    }]);
    // Запись только через функцию базы: в price_list напрямую не ходим, там страж.
    assert.deepEqual(fake.requests.map((request) => request.target), ["rpc:set_work_price"]);
  });

  it("массовое изменение уходит одним вызовом и возвращает число изменённых позиций", async () => {
    const fake = fakeSupabase({ "rpc:bulk_update_work_prices": { data: 2 } });
    const changed = await new M2ApiClient(fake.client).bulkUpdateWorkPrices([
      { workTypeCode: "diagnostics", guaranteeCategoryId: null, amount: 1650, includeGuaranteeWork: true },
      { workTypeCode: "repair", guaranteeCategoryId: "cat-gold", amount: 550, includeGuaranteeWork: false }
    ], "2026-12-01");
    assert.equal(changed, 2);
    assert.deepEqual(fake.of("rpc:bulk_update_work_prices")[0]?.[0], ["rpc", "bulk_update_work_prices", {
      p_items: [
        { work_type_code: "diagnostics", guarantee_category_id: null, amount: 1650, include_guarantee_work: true },
        { work_type_code: "repair", guarantee_category_id: "cat-gold", amount: 550, include_guarantee_work: false }
      ],
      p_valid_from: "2026-12-01"
    }]);
    assert.deepEqual(fake.requests.map((request) => request.target), ["rpc:bulk_update_work_prices"]);
  });

  it("удаляет будущую цену функцией базы, а не записью в таблицу", async () => {
    const fake = fakeSupabase({ "rpc:delete_future_work_price": {} });
    await new M2ApiClient(fake.client).deleteFutureWorkPrice("p3");
    assert.deepEqual(fake.of("rpc:delete_future_work_price")[0]?.[0], ["rpc", "delete_future_work_price", { p_id: "p3" }]);
    assert.deepEqual(fake.requests.map((request) => request.target), ["rpc:delete_future_work_price"]);
  });

  it("пока функций прайса нет в базе, говорит про обновление базы, а не про ошибку запроса", async () => {
    const fake = fakeSupabase({ "rpc:set_work_price": { error: { message: "Could not find the function public.set_work_price", code: "PGRST202" } } });
    await assert.rejects(() => new M2ApiClient(fake.client).setWorkPrice({
      workTypeCode: "diagnostics", guaranteeCategoryId: null, amount: 1700, validFrom: "2026-12-01", includeGuaranteeWork: false
    }), (error: unknown) => error instanceof M2ApiError && error.status === 501 && /обновления базы/u.test(error.message));
  });

  it("не отправляет в базу пустое массовое изменение и отрицательную цену", async () => {
    const fake = fakeSupabase({});
    const api = new M2ApiClient(fake.client);
    await assert.rejects(() => api.bulkUpdateWorkPrices([], "2026-12-01"), /строку прайса/u);
    await assert.rejects(() => api.setWorkPrice({
      workTypeCode: "diagnostics", guaranteeCategoryId: null, amount: -1, validFrom: "2026-12-01", includeGuaranteeWork: false
    }), /цену/u);
    assert.deepEqual(fake.requests, []);
  });
});

describe("прайс: экран и его место в приложении", () => {
  it("раздел открывается по price.read или finance.read, правка — только по price.write", async () => {
    const [app, navigation, page] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./navigation.ts", import.meta.url), "utf8"),
      readFile(new URL("./PricePage.tsx", import.meta.url), "utf8")
    ]);
    assert.match(app, /case "price": return <PricePage \/>/u);
    assert.match(app, /permission === "price\.read" \|\| permission === "finance\.read"/u);
    assert.match(navigation, /id: "price", label: "Прайс"/u);
    assert.match(page, /m2Api\.hasPermission\("price\.write"\)\.then\(setCanWrite\)/u);
    // Сегодня по Москве, а не по поясу устройства.
    assert.match(page, /companyToday\(\)/u);
    // Общие окна и выпадающие списки, как на соседних экранах.
    assert.match(page, /DialogForm/u);
    assert.match(page, /ConfirmationDialog/u);
    assert.doesNotMatch(page, /<select[\s>]/u);
    assert.doesNotMatch(page, /window\.(?:alert|confirm|prompt)\s*\(/u);
  });

  it("рисуется до загрузки данных: заголовок, сводка и «идёт загрузка»", () => {
    const html = renderToStaticMarkup(createElement(PricePage));
    assert.match(html, /Прайс/u);
    assert.match(html, /Загружаем прайс/u);
    assert.match(html, /Цены заданы/u);
    // Права ещё не прочитаны: кнопок правки на экране нет.
    assert.doesNotMatch(html, /Изменить выбранные/u);
  });
});

describe("прайс: ноль говорит о себе сам", () => {
  it("в окне правки объясняет, что значит нулевая цена (находка 39)", async () => {
    const page = await readFile(new URL("./PricePage.tsx", import.meta.url), "utf8");
    assert.match(page, /parseAmount\(amountDraft\) === 0 \?/u);
    assert.match(page, /в счёт такая работа не попадёт/u);
  });

  it("в массовом изменении предупреждает про нули отдельной строкой (находка 40)", async () => {
    const page = await readFile(new URL("./PricePage.tsx", import.meta.url), "utf8");
    assert.match(page, /const zeroCount = zeroPriceCount\(changes\);/u);
    assert.match(page, /zeroCount === 0 \? null :/u);
    assert.match(page, /в счёт такие работы не попадут/u);
    assert.match(page, /form-hint form-hint--warning/u);
  });
});

describe("прайс: пределы суммы", () => {
  it("цена из трёхсот знаков не роняет окно, а просто не читается", () => {
    // Раньше такое число превращалось в Infinity и округление копеек бросало исключение
    // прямо при отрисовке окна массового изменения: страница становилась белой.
    assert.equal(parseAmount("9".repeat(400)), null);
    assert.equal(parseAmount("1e400"), null);
    assert.equal(parseAmount("1 500,50"), 1500.5);
  });

  it("слишком большая цена отсекается в предпросмотре, а не отказом базы по всему списку", () => {
    const lines = priceLines({ workTypes: WORK_TYPES, rows: ROWS, categories: CATEGORIES, on: "2026-11-16" });
    const changes = previewBulkPrices(lines, { mode: "fixed", value: MAX_PRICE + 1 });
    // База отвергла бы весь вызов целиком, не назвав строку. Поэтому не отправляем вовсе.
    assert.deepEqual(new Set(changes.map((change) => change.skipReason)), new Set(["Цена слишком большая"]));
    assert.deepEqual(bulkPriceItems(changes), []);
    // Ровно предел проходит.
    const atLimit = previewBulkPrices(lines, { mode: "fixed", value: MAX_PRICE });
    assert.equal(atLimit[0]?.skipReason, undefined);
    assert.equal(atLimit[0]?.after, MAX_PRICE);
  });
});
