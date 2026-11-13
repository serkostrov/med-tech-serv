import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { M2ApiClient, searchTextPattern, searchTokens } from "./m2-api.js";

type FakeResponse = { readonly data?: unknown; readonly error?: { readonly message: string; readonly code?: string } | null; readonly count?: number | null };

/**
 * Поддельный клиент Supabase: на каждую таблицу или функцию свой ответ (список — по очереди),
 * запоминает цепочку каждого запроса.
 */
function fakeSupabase(routes: Readonly<Record<string, FakeResponse | readonly FakeResponse[]>>) {
  const requests: { readonly target: string; readonly calls: unknown[][] }[] = [];
  const used = new Map<string, number>();
  const respond = (target: string): FakeResponse => {
    const route = routes[target];
    const index = used.get(target) ?? 0;
    used.set(target, index + 1);
    if (Array.isArray(route)) return route[Math.min(index, route.length - 1)] ?? {};
    return (route as FakeResponse | undefined) ?? {};
  };
  const builder = (target: string, first: unknown[]) => {
    const calls: unknown[][] = [first];
    requests.push({ target, calls });
    const result = Promise.resolve({ data: null, error: null, count: null, ...respond(target) });
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "ilike", "or", "order", "range", "limit", "maybeSingle"]) {
      chain[method] = (...args: unknown[]) => { calls.push([method, ...args]); return chain; };
    }
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => result.then(resolve, reject);
    return chain;
  };
  const client = {
    from: (table: string) => builder(table, ["from", table]),
    rpc: (fn: string, args?: unknown, options?: unknown) => builder(`rpc:${fn}`, ["rpc", fn, args, options])
  };
  const of = (target: string) => requests.filter((request) => request.target === target).map((request) => request.calls);
  const step = (calls: readonly unknown[][] | undefined, method: string) => (calls ?? []).filter((call) => call[0] === method).map((call) => call.slice(1));
  return { client: client as never, requests, of, step };
}

const VIEW_ROW = {
  id: "p1", article_number: "A-1", name: "Клапан", minimum_stock: "5.000", notes: null, is_active: true,
  on_hand_quantity: "4.000", reserved_quantity: "1.000", available_quantity: "3.000", with_engineers_quantity: "2.000", below_minimum: true
};

describe("склад: фильтр, сортировка, поиск и сводка считает база", () => {
  it("«Ниже минимума», сначала малый остаток, вторая страница: всё уходит в запрос к представлению склада", async () => {
    const fake = fakeSupabase({
      inventory_part_registry: { data: [VIEW_ROW], count: 51 },
      "rpc:inventory_part_summary": { data: [{ active: 120, below_minimum: 7, with_engineers: 3 }] }
    });
    const page = await new M2ApiClient(fake.client).inventoryPartPage({ search: "  клапан 50%_ ", state: "low", sort: "available_asc", limit: 50, offset: 50 });
    const [registry] = fake.of("inventory_part_registry");
    assert.ok(registry, "запрос к представлению склада");
    const [select] = fake.step(registry, "select");
    assert.match(String(select?.[0]), /available_quantity, with_engineers_quantity, below_minimum/u);
    assert.deepEqual(select?.[1], { count: "exact" });
    assert.deepEqual(fake.step(registry, "eq"), [["is_active", true], ["below_minimum", true]]);
    assert.deepEqual(fake.step(registry, "ilike"), [["search_text", "%клапан%"], ["search_text", "%50\\%\\_%"]]);
    assert.deepEqual(fake.step(registry, "order"), [
      ["available_quantity", { ascending: true }], ["article_number", { ascending: true }], ["id", { ascending: true }]
    ]);
    assert.deepEqual(fake.step(registry, "range"), [[50, 99]]);
    assert.deepEqual(fake.of("rpc:inventory_part_summary")[0]?.[0], ["rpc", "inventory_part_summary", {}, { get: true }]);
    // Остатки считает представление: таблицы остатков и резервов по странице больше не читаются.
    assert.deepEqual(fake.requests.map((request) => request.target).sort(), ["inventory_part_registry", "rpc:inventory_part_summary"]);
    assert.deepEqual(page.summary, { active: 120, belowMinimum: 7, withEngineers: 3 });
    assert.equal(page.total, 51);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextOffset, undefined);
    assert.deepEqual(page.items[0], {
      id: "p1", articleNumber: "A-1", name: "Клапан", minimumStock: 5, notes: undefined, isActive: true,
      onHandQuantity: 4, reservedQuantity: 1, availableQuantity: 3, withEngineersQuantity: 2, belowMinimum: true
    });
  });

  it("каждое состояние склада — свой фильтр, «Все» без фильтра", async () => {
    const cases: readonly [string | undefined, readonly unknown[][]][] = [
      ["active", [["is_active", true]]],
      ["low", [["is_active", true], ["below_minimum", true]]],
      ["inactive", [["is_active", false]]],
      ["all", []],
      [undefined, []]
    ];
    for (const [state, expected] of cases) {
      const fake = fakeSupabase({ inventory_part_registry: { data: [], count: 0 }, "rpc:inventory_part_summary": { data: [] } });
      await new M2ApiClient(fake.client).inventoryPartPage(state ? { state } : {});
      assert.deepEqual(fake.step(fake.of("inventory_part_registry")[0], "eq"), expected, `состояние ${state ?? "не задано"}`);
    }
  });

  it("каждая сортировка окна «Склад» с однозначным порядком, без выбора — по наименованию", async () => {
    const cases: readonly [string | undefined, readonly unknown[][]][] = [
      ["article_asc", [["article_number", { ascending: true }], ["id", { ascending: true }]]],
      ["article_desc", [["article_number", { ascending: false }], ["id", { ascending: false }]]],
      ["name_asc", [["name", { ascending: true }], ["article_number", { ascending: true }], ["id", { ascending: true }]]],
      ["available_asc", [["available_quantity", { ascending: true }], ["article_number", { ascending: true }], ["id", { ascending: true }]]],
      ["available_desc", [["available_quantity", { ascending: false }], ["article_number", { ascending: true }], ["id", { ascending: true }]]],
      [undefined, [["name", { ascending: true }], ["article_number", { ascending: true }], ["id", { ascending: true }]]],
      ["constructor", [["name", { ascending: true }], ["article_number", { ascending: true }], ["id", { ascending: true }]]]
    ];
    for (const [sort, expected] of cases) {
      const fake = fakeSupabase({ inventory_part_registry: { data: [], count: 0 }, "rpc:inventory_part_summary": { data: [] } });
      await new M2ApiClient(fake.client).inventoryPartPage(sort ? { sort } : {});
      assert.deepEqual(fake.step(fake.of("inventory_part_registry")[0], "order"), expected, `сортировка ${sort ?? "не задана"}`);
    }
  });

  it("сводка не зависит от страницы: на пустой странице карточки всё равно по всему складу", async () => {
    const fake = fakeSupabase({
      inventory_part_registry: { data: [], count: 0 },
      "rpc:inventory_part_summary": { data: [{ active: 3, below_minimum: 1, with_engineers: 2 }] }
    });
    const page = await new M2ApiClient(fake.client).inventoryPartPage({ search: "нет такого", state: "inactive" });
    assert.deepEqual(page.summary, { active: 3, belowMinimum: 1, withEngineers: 2 });
    assert.equal(page.total, 0);
  });

  it("выбор запчасти в задаче берёт активные по наименованию и не считает сводку", async () => {
    const fake = fakeSupabase({ inventory_part_registry: { data: [VIEW_ROW], count: 1 } });
    const parts = await new M2ApiClient(fake.client).inventoryParts(false);
    assert.equal(parts.length, 1);
    const [registry] = fake.of("inventory_part_registry");
    assert.deepEqual(fake.step(registry, "eq"), [["is_active", true]]);
    assert.deepEqual(fake.step(registry, "range"), [[0, 499]]);
    assert.equal(fake.of("rpc:inventory_part_summary").length, 0);
  });

  it("пока миграции 0025 нет, склад работает как раньше, второй раз представление не спрашивает", async () => {
    const fake = fakeSupabase({
      inventory_part_registry: { error: { code: "PGRST205", message: "Could not find the table 'public.inventory_part_registry' in the schema cache" } },
      "rpc:inventory_part_summary": { error: { code: "PGRST202", message: "Could not find the function public.inventory_part_summary without parameters in the schema cache" } },
      parts: { data: [
        { id: "p1", article_number: "A-1", name: "Клапан", minimum_stock: 5, notes: null, is_active: true },
        { id: "p2", article_number: "B-2", name: "Фильтр", minimum_stock: 0, notes: "склад 2", is_active: true }
      ], count: 2 },
      stock_balances: { data: [
        { part_id: "p1", on_hand_quantity: "3.000", reserved_quantity: "1.000", available_quantity: "2.000" },
        { part_id: "p1", on_hand_quantity: "1.000", reserved_quantity: "0.000", available_quantity: "1.000" }
      ] },
      stock_reservations: { data: [{ part_id: "p2", quantity: "2.000" }] }
    });
    const api = new M2ApiClient(fake.client);
    const page = await api.inventoryPartPage({ search: "клапан, (1.5)", state: "active", sort: "available_desc" });
    const [parts] = fake.of("parts");
    assert.deepEqual(fake.step(parts, "order"), [["name"]]);
    assert.deepEqual(fake.step(parts, "eq"), [["is_active", true]]);
    assert.deepEqual(fake.step(parts, "or"), [["article_number.ilike.%клапан 15%,name.ilike.%клапан 15%"]]);
    assert.deepEqual(page.items.map((item) => [item.id, item.onHandQuantity, item.availableQuantity, item.withEngineersQuantity, item.belowMinimum]), [
      ["p1", 4, 3, 0, true],
      ["p2", 0, 0, 2, false]
    ]);
    assert.deepEqual(page.summary, { active: 2, belowMinimum: 1, withEngineers: 1 });
    await api.inventoryPartPage({});
    assert.equal(fake.of("inventory_part_registry").length, 1);
    assert.equal(fake.of("rpc:inventory_part_summary").length, 1);
    assert.equal(fake.of("parts").length, 2);
  });

  it("другие ошибки базы не прячутся за старым складом", async () => {
    const fake = fakeSupabase({
      inventory_part_registry: { error: { code: "42501", message: "permission denied for view inventory_part_registry" } },
      "rpc:inventory_part_summary": { data: [] }
    });
    await assert.rejects(new M2ApiClient(fake.client).inventoryPartPage({}), /Недостаточно прав/u);
    assert.equal(fake.of("parts").length, 0);
  });
});

const EQUIPMENT_ROW = {
  id: "e1", serial_number: "BE49081", status_code: "in_use", notes: null, current_site_id: "s1", current_payer_id: "y1",
  manufacturer_id: "m1", model_id: "md1",
  manufacturer: { id: "m1", name: "Beckman Coulter" }, model: { id: "md1", name: "DxH-800", manufacturer_id: "m1" },
  status: { code: "in_use", name: "В эксплуатации" },
  site: { id: "s1", name: "Лаборатория", organization: { name: "Областная клиника" } }, payer: { id: "y1", name: "ИП Бета" }
};
const SITE = "11111111-1111-4111-8111-111111111111";
const PAYER = "22222222-2222-4222-8222-222222222222";
const MANUFACTURER = "33333333-3333-4333-8333-333333333333";

describe("реестр приборов: поиск по любой сущности в базе", () => {
  it("слова поиска уходят в представление поиска вместе со всеми фильтрами и страницей", async () => {
    const fake = fakeSupabase({ equipment_search: { data: [EQUIPMENT_ROW], count: 21 } });
    const page = await new M2ApiClient(fake.client).equipmentPage({
      search: " DxH  Лаборатория ", status: "in_use", site: SITE, payer: PAYER, manufacturer: MANUFACTURER, limit: 10, offset: 20
    });
    assert.deepEqual(fake.requests.map((request) => request.target), ["equipment_search"]);
    const [search] = fake.of("equipment_search");
    const [select] = fake.step(search, "select");
    assert.match(String(select?.[0]), /site:sites!current_site_id\(id, name, organization_id, organization:organizations\(name\)\)/u);
    assert.deepEqual(select?.[1], { count: "exact" });
    assert.deepEqual(fake.step(search, "eq"), [["status_code", "in_use"], ["current_site_id", SITE], ["current_payer_id", PAYER], ["manufacturer_id", MANUFACTURER]]);
    assert.deepEqual(fake.step(search, "ilike"), [["search_text", "%DxH%"], ["search_text", "%Лаборатория%"]]);
    assert.deepEqual(fake.step(search, "order"), [["serial_number"]]);
    assert.deepEqual(fake.step(search, "range"), [[20, 29]]);
    assert.deepEqual(fake.step(search, "or"), []);
    assert.deepEqual({ total: page.total, limit: page.limit, offset: page.offset }, { total: 21, limit: 10, offset: 20 });
    assert.equal(page.items[0]?.organization, "Областная клиника");
    assert.equal(page.items[0]?.payer, "ИП Бета");
  });

  it("без поиска реестр читает таблицу приборов, как раньше", async () => {
    const fake = fakeSupabase({ equipment: { data: [EQUIPMENT_ROW], count: 1 } });
    await new M2ApiClient(fake.client).equipmentPage({ search: "   ", status: "in_use" });
    assert.deepEqual(fake.requests.map((request) => request.target), ["equipment"]);
    const [table] = fake.of("equipment");
    assert.deepEqual(fake.step(table, "ilike"), []);
    assert.deepEqual(fake.step(table, "or"), []);
    assert.deepEqual(fake.step(table, "eq"), [["status_code", "in_use"]]);
  });

  it("запятые, точки и скобки ищутся как есть, % и _ — как обычные знаки", async () => {
    const fake = fakeSupabase({ equipment_search: { data: [], count: 0 } });
    await new M2ApiClient(fake.client).equipmentPage({ search: "ООО «Мед,Тех» (1.2) 100%_x" });
    assert.deepEqual(fake.step(fake.of("equipment_search")[0], "ilike"), [
      ["search_text", "%ООО%"], ["search_text", "%«Мед,Тех»%"], ["search_text", "%(1.2)%"], ["search_text", "%100\\%\\_x%"]
    ]);
  });

  it("пока миграции 0025 нет, ищет по S/N и примечанию, как раньше, и больше не спрашивает представление", async () => {
    for (const error of [
      { code: "PGRST205", message: "Could not find the table 'public.equipment_search' in the schema cache" },
      { code: "PGRST200", message: "Could not find a relationship between 'equipment_search' and 'manufacturers' in the schema cache" },
      { code: "42P01", message: "relation \"public.equipment_search\" does not exist" }
    ]) {
      const fake = fakeSupabase({ equipment_search: { error }, equipment: { data: [EQUIPMENT_ROW], count: 1 } });
      const api = new M2ApiClient(fake.client);
      const page = await api.equipmentPage({ search: "BE49081", status: "in_use", limit: 10 });
      assert.equal(page.total, 1, error.code);
      const [table] = fake.of("equipment");
      assert.deepEqual(fake.step(table, "or"), [["serial_number.ilike.%BE49081%,notes.ilike.%BE49081%"]], error.code);
      assert.deepEqual(fake.step(table, "eq"), [["status_code", "in_use"]], error.code);
      await api.equipmentPage({ search: "DxH" });
      assert.equal(fake.of("equipment_search").length, 1, error.code);
      assert.equal(fake.of("equipment").length, 2, error.code);
    }
  });

  it("ошибка прав в поиске показывается, а не подменяется старым поиском", async () => {
    const fake = fakeSupabase({ equipment_search: { error: { code: "42501", message: "permission denied for view equipment_search" } } });
    await assert.rejects(new M2ApiClient(fake.client).equipmentPage({ search: "BE" }), /Недостаточно прав/u);
    assert.equal(fake.of("equipment").length, 0);
  });

  it("площадка, плательщик или производитель, которых нет, дают пустую страницу с верным размером", async () => {
    const fake = fakeSupabase({ payers: { data: [] } });
    const page = await new M2ApiClient(fake.client).equipmentPage({ payer: "Нет такого", limit: 10, offset: 30 });
    assert.deepEqual(page, { items: [], total: 0, limit: 10, offset: 30 });
  });
});

describe("слова поиска", () => {
  it("делит по пробелам, «ё» как «е», не больше 10 слов", () => {
    assert.deepEqual(searchTokens("  Ёлочка   ёж\tDxH "), ["елочка", "еж", "DxH"]);
    assert.deepEqual(searchTokens(undefined), []);
    assert.equal(searchTokens("1 2 3 4 5 6 7 8 9 10 11 12").length, 10);
    assert.equal(searchTextPattern("a\\b"), "%a\\\\b%");
  });
});

describe("миграция 0025", () => {
  it("представления с правами вызывающего, анониму закрыты; функция сводки с правами вызывающего", async () => {
    const sql = await readFile(new URL("../supabase/migrations/0025_warehouse_and_equipment_search.sql", import.meta.url), "utf8");
    for (const view of ["inventory_part_registry", "equipment_search"]) {
      assert.match(sql, new RegExp(`CREATE OR REPLACE VIEW public\\.${view}\\s+WITH \\(security_invoker = true\\) AS`, "u"));
      assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${view} FROM PUBLIC, anon, authenticated;\\s+GRANT SELECT ON public\\.${view} TO authenticated;`, "u"));
    }
    assert.match(sql, /ALTER VIEW public\.stock_balances SET \(security_invoker = true\);/u);
    assert.match(sql, /FUNCTION public\.inventory_part_summary\(\)[\s\S]*?STABLE\s+SECURITY INVOKER\s+SET search_path = public, pg_temp/u);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.inventory_part_summary\(\) FROM PUBLIC, anon;/u);
    assert.doesNotMatch(sql, /SECURITY DEFINER/u);
  });

  it("в представлении поиска есть все столбцы прибора, которые выбирает реестр (и ключи связей)", async () => {
    const [sql, source] = await Promise.all([
      readFile(new URL("../supabase/migrations/0025_warehouse_and_equipment_search.sql", import.meta.url), "utf8"),
      readFile(new URL("./m2-api.ts", import.meta.url), "utf8")
    ]);
    const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW public.equipment_search"), sql.indexOf("FROM public.equipment AS e"));
    const select = /const EQUIPMENT_SELECT = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
    let depth = 0;
    let field = "";
    const columns: string[] = [];
    for (const char of `${select},`) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        const name = field.trim();
        if (name && !name.includes(":") && !name.includes("(")) columns.push(name);
        field = "";
      } else {
        field += char;
      }
    }
    assert.ok(columns.includes("current_site_id") && columns.includes("model_id"), "столбцы реестра прочитаны");
    for (const column of columns) assert.match(view, new RegExp(`\\be\\.${column},`, "u"), column);
    assert.match(view, /\) AS search_text\s*$/u);
  });

  it("в представлении склада есть все столбцы, которые выбирает, фильтрует и сортирует склад", async () => {
    const sql = await readFile(new URL("../supabase/migrations/0025_warehouse_and_equipment_search.sql", import.meta.url), "utf8");
    const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW public.inventory_part_registry"), sql.indexOf("FROM public.parts AS p"));
    const fake = fakeSupabase({ inventory_part_registry: { data: [], count: 0 }, "rpc:inventory_part_summary": { data: [] } });
    await new M2ApiClient(fake.client).inventoryPartPage({ search: "клапан", state: "low", sort: "available_desc" });
    const [registry] = fake.of("inventory_part_registry");
    const columns = new Set([
      ...String(fake.step(registry, "select")[0]?.[0]).split(",").map((column) => column.trim()),
      ...fake.step(registry, "eq").map((call) => String(call[0])),
      ...fake.step(registry, "ilike").map((call) => String(call[0])),
      ...fake.step(registry, "order").map((call) => String(call[0]))
    ]);
    assert.ok(columns.has("below_minimum") && columns.has("search_text") && columns.has("available_quantity"), "столбцы склада прочитаны");
    for (const column of columns) assert.match(view, new RegExp(`(\\bp\\.${column},|AS ${column}\\b)`, "u"), column);
  });
});
