import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { M2ApiClient } from "./m2-api.js";
import {
  cleanModelLine,
  competenciesToSave,
  competencyKey,
  competencyLabel,
  competencyMatchesEquipment,
  competencyPayload,
  sameCompetencySet,
  preselectedEngineerId,
  sortCompetencies,
  withManufacturerIds,
  type EngineerCompetency
} from "./engineer-competencies.js";

interface Call {
  readonly table?: string;
  readonly rpc?: string;
  readonly args?: unknown;
  readonly ops: unknown[][];
}

type Response = { data?: unknown; error?: { message: string; code?: string } | null; count?: number };

/** Поддельный Supabase: записывает запросы, ответ выбирает по таблице и цепочке вызовов. */
function fakeSupabase(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const chain = (call: Call) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "not", "is", "order", "range", "update", "delete", "insert", "maybeSingle", "single"]) {
      builder[method] = (...args: unknown[]) => { call.ops.push([method, ...args]); return builder; };
    }
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve().then(() => ({ data: null, error: null, count: null, ...answer(call) })).then(resolve, reject);
    return builder;
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "actor-1" } } } }) },
    from: (table: string) => { const call: Call = { table, ops: [] }; calls.push(call); return chain(call); },
    rpc: (fn: string, args: unknown) => {
      const call: Call = { rpc: fn, args, ops: [] };
      calls.push(call);
      return Promise.resolve({ data: null, error: null, ...answer(call) });
    }
  };
  return { client: client as never, calls };
}

const op = (call: Call | undefined, name: string) => call?.ops.find((item) => item[0] === name);

const engineerRows = [
  {
    id: "eng-1", full_name: "Иванов", is_active: true,
    engineer_competencies: [
      { id: "c-2", manufacturer_id: "m-sys", model_line: "XN", manufacturer: { name: "Sysmex" } },
      { id: "c-1", manufacturer_id: "m-mr", model_line: "BC", manufacturer: { name: "Mindray" } }
    ]
  },
  { id: "eng-2", full_name: "Петров", is_active: false, engineer_competencies: [{ id: "c-3", manufacturer_id: "m-mr", model_line: "BC-6800", manufacturer: { name: "Mindray" } }] },
  { id: "eng-3", full_name: "Сидоров", is_active: true, engineer_competencies: [] }
];

function engineersAnswer(call: Call): Response {
  if (call.table === "users") return { data: engineerRows };
  if (call.table === "tasks") return { data: [], count: 0 };
  return {};
}

describe("компетенции инженера: правила", () => {
  it("линейка без лишних пробелов, одна компетенция без учёта регистра", () => {
    assert.equal(cleanModelLine("  AU   480 "), "AU 480");
    assert.equal(competencyKey({ manufacturerId: "m-1", modelLine: "AU 480" }), competencyKey({ manufacturerId: "m-1", modelLine: " au  480" }));
    assert.notEqual(competencyKey({ manufacturerId: "m-1", modelLine: "AU" }), competencyKey({ manufacturerId: "m-2", modelLine: "AU" }));
    assert.equal(competencyLabel({ manufacturer: "Mindray", modelLine: " BC " }), "Mindray · BC");
  });

  it("набор сравнивается без порядка, смена регистра — тоже изменение, теги по порядку", () => {
    const set = [{ manufacturerId: "m-1", manufacturer: "Mindray", modelLine: "BC" }, { manufacturerId: "m-2", manufacturer: "Beckman", modelLine: "AU" }];
    assert.ok(sameCompetencySet(set, [...set].reverse()));
    assert.ok(sameCompetencySet(set, [{ manufacturerId: "m-1", modelLine: " BC " }, { manufacturerId: "m-2", modelLine: "AU" }]));
    assert.ok(!sameCompetencySet(set, set.slice(0, 1)));
    assert.ok(!sameCompetencySet(set, [{ manufacturerId: "m-1", modelLine: "bc" }, { manufacturerId: "m-2", modelLine: "AU" }]));
    assert.deepEqual(sortCompetencies(set).map((item) => item.manufacturer), ["Beckman", "Mindray"]);
  });

  it("при сохранении не теряет набранную, но не добавленную линейку", () => {
    const manufacturers = [{ id: "m-1", name: "Mindray" }, { id: "m-2", name: "Sysmex" }];
    const saved = [{ id: "c-1", manufacturerId: "m-1", manufacturer: "Mindray", modelLine: "BC" }];
    const withPending = competenciesToSave(saved, { manufacturerId: "m-2", modelLine: " XN " }, saved, manufacturers);
    assert.ok(!("error" in withPending));
    assert.deepEqual(withPending.items.map((item) => [item.manufacturerId, item.modelLine]), [["m-1", "BC"], ["m-2", "XN"]]);
    assert.equal(withPending.changed, true);
    // Линейка набрана, производитель не выбран: не сохраняем и объясняем.
    assert.match(String((competenciesToSave(saved, { manufacturerId: "", modelLine: "XN" }, saved, manufacturers) as { error: string }).error), /Выберите производителя для линейки «XN»/u);
    // Ничего не меняли (производитель выбран, линейка пустая): набор не трогаем.
    const same = competenciesToSave(saved, { manufacturerId: "m-2", modelLine: "  " }, saved, manufacturers);
    assert.ok(!("error" in same) && same.changed === false);
    // Повтор уже добавленной линейки не дублируется.
    const duplicate = competenciesToSave(saved, { manufacturerId: "m-1", modelLine: "bc" }, saved, manufacturers);
    assert.ok(!("error" in duplicate) && duplicate.items.length === 1 && duplicate.changed === false);
    // Убрали «BC» и добавили «bc»: это изменение, его сохраняем.
    const recased = competenciesToSave([{ manufacturerId: "m-1", manufacturer: "Mindray", modelLine: "bc" }], { manufacturerId: "", modelLine: "" }, saved, manufacturers);
    assert.ok(!("error" in recased) && recased.changed === true);
  });

  it("в окне назначения: смена — другой инженер, новая задача с инженером из плана — он", () => {
    const ranked = [{ engineerId: "e-1" }, { engineerId: "e-2" }, { engineerId: "e-3" }];
    assert.equal(preselectedEngineerId(ranked, "e-2", false), "e-2");
    assert.equal(preselectedEngineerId(ranked, "e-1", true), "e-2");
    assert.equal(preselectedEngineerId(ranked, undefined, false), "e-1");
    // Инженер из плана отключён (его нет в списке): выбираем лучшего из подходящих.
    assert.equal(preselectedEngineerId(ranked, "e-off", false), "e-1");
    assert.equal(preselectedEngineerId([], "e-1", false), "");
  });

  it("на сохранение уходят только полные компетенции, повторы один раз", () => {
    assert.deepEqual(
      competencyPayload([{ manufacturerId: "m-1", manufacturer: "Mindray", modelLine: " BC " }, { manufacturerId: "m-1", modelLine: "bc" }]),
      [{ manufacturerId: "m-1", modelLine: "BC" }]
    );
    assert.throws(() => competencyPayload([{ manufacturer: "Mindray", modelLine: "BC" }]), /производителя из справочника для «Mindray»/u);
    assert.throws(() => competencyPayload([{ manufacturerId: "m-1", modelLine: "  " }]), /линейка/u);
    assert.throws(() => competencyPayload([{ manufacturerId: "m-1", modelLine: "x".repeat(101) }]), /длиннее 100/u);
  });

  it("находит id производителя по названию, если пришло только название", () => {
    const loaded: EngineerCompetency[] = [{ manufacturer: "mindray", modelLine: "BC" }, { manufacturer: "Нет такого", modelLine: "X" }];
    const [found, unknown] = withManufacturerIds(loaded, [{ id: "m-1", name: "Mindray" }]);
    assert.equal(found?.manufacturerId, "m-1");
    assert.equal(unknown?.manufacturerId, undefined);
  });

  it("подходит к прибору по производителю и началу названия модели целыми частями", () => {
    const bc = { manufacturer: "Mindray", modelLine: "BC" };
    assert.ok(competencyMatchesEquipment(bc, "Mindray", "BC-6800"));
    assert.ok(competencyMatchesEquipment(bc, " mindray ", "bc 5000"));
    assert.ok(competencyMatchesEquipment({ manufacturer: "Mindray", modelLine: "BC-6800" }, "Mindray", "BC 6800"));
    assert.ok(competencyMatchesEquipment({ manufacturer: "Mindray", modelLine: "CL-900" }, "Mindray", "CL-900i"));
    assert.ok(competencyMatchesEquipment({ manufacturer: "Roche Diagnostics", modelLine: "cobas" }, "Roche Diagnostics", "cobas c 311"));
    assert.ok(competencyMatchesEquipment({ manufacturer: "Roche Diagnostics", modelLine: "cobas c" }, "Roche Diagnostics", "cobas c 311"));
    assert.ok(!competencyMatchesEquipment({ manufacturer: "Roche Diagnostics", modelLine: "cobas e" }, "Roche Diagnostics", "cobas c 311"));
    assert.ok(competencyMatchesEquipment({ manufacturer: "Beckman Coulter", modelLine: "AU 480" }, "Beckman Coulter", "AU 480"));
    assert.ok(!competencyMatchesEquipment({ manufacturer: "Beckman Coulter", modelLine: "AU 480" }, "Beckman Coulter", "AU 680"));
    // Начало числа — не начало модели: «AU 480» не AU 4800, «XN-10» не XN-1000, «cob» не cobas.
    assert.ok(!competencyMatchesEquipment({ manufacturer: "Beckman Coulter", modelLine: "AU 480" }, "Beckman Coulter", "AU 4800"));
    assert.ok(!competencyMatchesEquipment({ manufacturer: "Sysmex", modelLine: "XN-10" }, "Sysmex", "XN-1000"));
    assert.ok(!competencyMatchesEquipment({ manufacturer: "Roche Diagnostics", modelLine: "cob" }, "Roche Diagnostics", "cobas c 311"));
    assert.ok(!competencyMatchesEquipment({ manufacturer: "Mindray", modelLine: "BC-6800 Plus" }, "Mindray", "BC-6800"));
    assert.ok(!competencyMatchesEquipment(bc, "Sysmex", "BC-6800"));
    // Модель прибора неизвестна: хватает производителя.
    assert.ok(competencyMatchesEquipment(bc, "Mindray"));
    assert.ok(!competencyMatchesEquipment(bc, ""));
  });
});

describe("компетенции инженера: запросы", () => {
  it("загружает компетенции с id производителя, по порядку", async () => {
    const { client, calls } = fakeSupabase(engineersAnswer);
    const engineers = await new M2ApiClient(client).engineers();
    assert.match(String(op(calls.find((call) => call.table === "users"), "select")?.[1]), /engineer_competencies\(id, manufacturer_id, model_line, manufacturer:manufacturers\(name\)\)/u);
    assert.deepEqual(engineers[0]?.competencies, [
      { id: "c-1", manufacturerId: "m-mr", manufacturer: "Mindray", modelLine: "BC" },
      { id: "c-2", manufacturerId: "m-sys", manufacturer: "Sysmex", modelLine: "XN" }
    ]);
  });

  it("заменяет набор одной функцией базы, затем сохраняет имя", async () => {
    const { client, calls } = fakeSupabase(engineersAnswer);
    await new M2ApiClient(client).updateEngineer("eng-1", {
      fullName: "Иванов Иван",
      competencies: [
        { manufacturerId: "m-mr", manufacturer: "Mindray", modelLine: "  BC  6800 " },
        { manufacturerId: "m-mr", manufacturer: "Mindray", modelLine: "bc 6800" },
        { manufacturerId: "m-sys", manufacturer: "Sysmex", modelLine: "XN" }
      ]
    });
    assert.deepEqual(calls[0], {
      rpc: "replace_engineer_competencies",
      args: { p_engineer_id: "eng-1", p_competencies: [{ manufacturerId: "m-mr", modelLine: "BC 6800" }, { manufacturerId: "m-sys", modelLine: "XN" }] },
      ops: []
    });
    assert.equal(calls[1]?.table, "users");
    assert.deepEqual(op(calls[1], "update"), ["update", { full_name: "Иванов Иван" }]);
    // Ни одной прямой записи в таблицу компетенций: только через функцию.
    assert.ok(!calls.some((call) => call.table === "engineer_competencies"));
  });

  it("без компетенций в запросе набор не трогает", async () => {
    const { client, calls } = fakeSupabase(engineersAnswer);
    await new M2ApiClient(client).updateEngineer("eng-1", { fullName: "Иванов" });
    assert.ok(!calls.some((call) => call.rpc));
  });

  it("неполную компетенцию в базу не отправляет", async () => {
    const { client, calls } = fakeSupabase(engineersAnswer);
    await assert.rejects(new M2ApiClient(client).updateEngineer("eng-1", { fullName: "Иванов", competencies: [{ manufacturer: "Mindray", modelLine: "BC" }] }), /производителя из справочника/u);
    assert.equal(calls.length, 0);
  });

  it("пока базу не обновили, честно говорит, что ничего не сохранено", async () => {
    const { client, calls } = fakeSupabase((call) => call.rpc
      ? { error: { message: "Could not find the function public.replace_engineer_competencies(p_competencies, p_engineer_id)", code: "PGRST202" } }
      : engineersAnswer(call));
    await assert.rejects(
      new M2ApiClient(client).updateEngineer("eng-1", { fullName: "Новое имя", competencies: [{ manufacturerId: "m-mr", modelLine: "BC" }] }),
      /после обновления базы.*не сохранена/u
    );
    // Имя тоже не записано: карточка не сохраняется наполовину.
    assert.ok(!calls.some((call) => call.table === "users" && op(call, "update")));
  });

  it("ошибку базы показывает по-русски", async () => {
    const { client } = fakeSupabase((call) => call.rpc ? { error: { message: "Компетенция может принадлежать только активному инженеру", code: "23514" } } : engineersAnswer(call));
    await assert.rejects(new M2ApiClient(client).updateEngineer("eng-2", { competencies: [{ manufacturerId: "m-mr", modelLine: "BC" }] }), /только активному инженеру/u);
  });

  it("подсказка назначения: по компетенциям, без отключённых инженеров", async () => {
    const { client } = fakeSupabase(engineersAnswer);
    const suggestions = await new M2ApiClient(client).taskAssignmentSuggestions("t-1", "Mindray", "BC-6800");
    assert.deepEqual(suggestions.map((item) => [item.fullName, item.previouslyWorkedWithEquipment]), [["Иванов", true], ["Сидоров", false]]);
  });
});

describe("компетенции инженера: экран", () => {
  it("теги с кнопкой «убрать», производитель из справочника, сохранение не теряет набранную линейку", async () => {
    const [page, editor, css] = await Promise.all([
      readFile(new URL("./OperationsPages.tsx", import.meta.url), "utf8"),
      readFile(new URL("./EngineerCompetencyEditor.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.match(page, /<EngineerCompetencyEditor/u);
    assert.match(page, /<CompetencyTags engineer=\{engineer\} \/>/u);
    assert.match(page, /passportReferences\(\)/u);
    assert.match(page, /competenciesToSave\(competencies, draft, editing\.competencies, references\.manufacturers\)/u);
    assert.match(page, /prepared\.changed \?/u);
    assert.doesNotMatch(page, /name="manufacturer"/u);
    assert.match(editor, /aria-label=\{`Убрать «\$\{label\}»`\}/u);
    assert.match(editor, /references\.manufacturers\.map/u);
    assert.match(editor, /event\.key !== "Enter"/u);
    // На телефоне строка добавления в столбик, теги переносятся, а не обрезаются.
    assert.match(css, /\.competency-editor__chips\s*\{[^}]*flex-wrap:\s*wrap/su);
    assert.match(css, /\.competency-chip > span\s*\{[^}]*overflow-wrap:\s*anywhere/su);
    assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.competency-editor__add\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/su);
    assert.doesNotMatch(css, /\.competency[^{]*\{[^}]*text-overflow:\s*ellipsis/su);
  });
});
