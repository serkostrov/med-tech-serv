import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2ApiClient } from "./m2-api.js";
import { planBoardPositions } from "./TaskBoard.js";

const at = (id: string, boardPosition?: number) => (boardPosition === undefined ? { id } : { id, boardPosition });
const positions = (plan: readonly { readonly taskId: string; readonly position: number }[]) => plan.map((item) => [item.taskId, Number(item.position.toFixed(4))]);

describe("board card order", () => {
  it("puts a card into an empty column, on top and at the bottom", () => {
    assert.deepEqual(positions(planBoardPositions([], 0, ["x"])), [["x", 0]]);
    assert.deepEqual(positions(planBoardPositions([at("a", 5), at("b", 6)], 0, ["x", "y"])), [["x", 3], ["y", 4]]);
    assert.deepEqual(positions(planBoardPositions([at("a", 5), at("b", 6)], 2, ["x"])), [["x", 7]]);
  });

  it("puts a card between two placed cards without touching them", () => {
    assert.deepEqual(positions(planBoardPositions([at("a", 1), at("b", 2)], 1, ["x"])), [["x", 1.5]]);
    assert.deepEqual(positions(planBoardPositions([at("a", 1), at("b", 2)], 1, ["x", "y"])), [["x", 1.3333], ["y", 1.6667]]);
    // Ниже расставленных, над карточками без места: сразу за последней расставленной.
    assert.deepEqual(positions(planBoardPositions([at("a", 1), at("b")], 1, ["x"])), [["x", 2]]);
  });

  it("pins cards without a place above the drop, so the dropped card does not jump over them", () => {
    // Порядок по сортировке: a, b, c без мест. Ставим под b: a и b закрепляются как стоят.
    assert.deepEqual(positions(planBoardPositions([at("a"), at("b"), at("c")], 2, ["x"])), [["a", 0], ["b", 1], ["x", 2]]);
    // Над местом есть расставленная p: закреплённые встают за ней.
    assert.deepEqual(positions(planBoardPositions([at("p", 4), at("a"), at("b")], 2, ["x"])), [["a", 5], ["x", 6]]);
    // Наверх колонки без мест: закреплять нечего.
    assert.deepEqual(positions(planBoardPositions([at("a"), at("b")], 0, ["x"])), [["x", 0]]);
  });

  it("uses the next card beyond the loaded part when dropping at the bottom of a long column", () => {
    assert.deepEqual(positions(planBoardPositions([at("a", 1), at("b", 2)], 2, ["x"], { boardPosition: 3 })), [["x", 2.5]]);
    assert.deepEqual(positions(planBoardPositions([at("a", 1), at("b", 2)], 2, ["x"], {})), [["x", 3]]);
  });

  it("spreads placed cards again when there is no room left between neighbours", () => {
    const plan = planBoardPositions([at("a", 0), at("b", 1e-10), at("c", 5)], 1, ["x"]);
    assert.deepEqual(plan.map((item) => item.taskId), ["a", "x", "b", "c"]);
    assert.equal(plan[0]?.position, 0);
    assert.equal(plan.at(-1)?.position, 5);
    for (let index = 1; index < plan.length; index += 1) assert.ok((plan[index]?.position ?? 0) > (plan[index - 1]?.position ?? 0));
  });
});

interface RecordedCall {
  readonly table: string;
  select?: string;
  readonly orders: (readonly [string, unknown])[];
  upsert?: unknown;
  upsertOptions?: unknown;
}

/** Поддельный клиент Supabase: записывает запросы и отдаёт заготовленные ответы по очереди. */
function fakeClient(responses: { data?: unknown; error?: { message: string; code?: string } | null; count?: number }[]) {
  const calls: RecordedCall[] = [];
  const client = {
    from(table: string) {
      const call: RecordedCall = { table, orders: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: (fields: string) => { call.select = fields; return builder; },
        order: (column: string, options: unknown) => { call.orders.push([column, options]); return builder; },
        upsert: (rows: unknown, options: unknown) => { call.upsert = rows; call.upsertOptions = options; return builder; },
        range: chain, eq: chain, or: chain, gte: chain, lte: chain, lt: chain, not: chain,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const response = responses.shift() ?? { data: [], error: null, count: 0 };
          return Promise.resolve({ data: null, error: null, count: null, ...response }).then(resolve, reject);
        }
      });
      return builder;
    }
  };
  return { client: client as never, calls };
}

const taskRow = (id: string, boardPosition: number | null) => ({
  id, number: `З-${id}`, title: id, status_code: "new", board_position: boardPosition,
  created_at: "2026-11-01T09:00:00.000Z", updated_at: "2026-11-01T09:00:00.000Z"
});

describe("board order requests", () => {
  it("orders a board column by the manual place first, then by the board sort", async () => {
    const { client, calls } = fakeClient([{ data: [taskRow("a", 1), taskRow("b", null)], count: 2 }]);
    const page = await new M2ApiClient(client).tasksPage({ status: "new", sort: "updated_desc", boardOrder: true, limit: 12 });
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.select ?? "", /board_position/u);
    assert.deepEqual(calls[0]?.orders, [
      ["board_position", { ascending: true, nullsFirst: false }],
      ["updated_at", { ascending: false }],
      ["id", { ascending: true }]
    ]);
    assert.equal(page.items[0]?.boardPosition, 1);
    assert.equal(page.items[1]?.boardPosition, undefined);
  });

  it("keeps plain lists without the board order", async () => {
    const { client, calls } = fakeClient([{ data: [], count: 0 }]);
    await new M2ApiClient(client).tasksPage({ status: "new", sort: "deadline_asc" });
    assert.doesNotMatch(calls[0]?.select ?? "", /board_position/u);
    assert.deepEqual(calls[0]?.orders, [["deadline_to", { ascending: true }]]);
  });

  it("saves card places in one request keyed by task", async () => {
    const { client, calls } = fakeClient([{ error: null }]);
    await new M2ApiClient(client).setTaskBoardPositions("assigned", [{ taskId: "a", position: 1.5 }, { taskId: "b", position: 2 }]);
    assert.equal(calls[0]?.table, "task_board_positions");
    assert.deepEqual(calls[0]?.upsert, [
      { task_id: "a", status_code: "assigned", position: 1.5 },
      { task_id: "b", status_code: "assigned", position: 2 }
    ]);
    assert.deepEqual(calls[0]?.upsertOptions, { onConflict: "task_id" });
  });

  it("explains a missing access instead of a raw database error", async () => {
    const { client } = fakeClient([{ error: { message: "new row violates row-level security policy for table \"task_board_positions\"", code: "42501" } }]);
    await assert.rejects(new M2ApiClient(client).setTaskBoardPositions("assigned", [{ taskId: "a", position: 1 }]), /Нет прав менять порядок/u);
  });

  // Последним: после него в этом процессе доска считает, что порядка в базе нет.
  it("shows the board by the usual sort while the database has no card order yet", async () => {
    const { client, calls } = fakeClient([
      { error: { message: "column tasks.board_position does not exist", code: "42703" } },
      { data: [taskRow("a", null)], count: 1 }
    ]);
    const page = await new M2ApiClient(client).tasksPage({ status: "new", sort: "updated_desc", boardOrder: true });
    assert.equal(page.items.length, 1);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[1]?.select ?? "", /board_position/u);
    assert.deepEqual(calls[1]?.orders, [["updated_at", { ascending: false }]]);
    await assert.rejects(new M2ApiClient(client).setTaskBoardPositions("new", [{ taskId: "a", position: 1 }]), /не обновлена база/u);
  });
});
