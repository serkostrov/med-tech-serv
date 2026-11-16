import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  clearClosureDraft,
  closureDraftChecked,
  closureDraftIsEmpty,
  closureDraftValue,
  closureDraftValues,
  readClosureDraft,
  saveClosureDraft
} from "./closure-draft.js";

/** Хранилище браузера: в тестах своё, с возможностью сломаться, как в приватном окне. */
function installStorage(broken = false): Map<string, string> {
  const data = new Map<string, string>();
  const fail = (): never => { throw new Error("данные сайта запрещены"); };
  (globalThis as { window?: unknown }).window = {
    localStorage: broken ? { getItem: fail, setItem: fail, removeItem: fail } : {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); }
    }
  };
  return data;
}

function form(values: Record<string, string>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.append(key, value);
  return result;
}

describe("черновик результата работ", () => {
  beforeEach(() => { installStorage(); });

  it("запоминает заполненное и возвращает при следующем открытии", () => {
    saveClosureDraft("t1", closureDraftValues(form({
      callReason: "Не включается",
      workDescription: "Заменили блок питания",
      workCompleted: "on",
      // Пустое поле не храним: оно и так пустое.
      recommendations: ""
    })));
    const draft = readClosureDraft("t1");
    assert.equal(draft?.values.callReason, "Не включается");
    assert.equal(draft?.values.workDescription, "Заменили блок питания");
    assert.equal(draft?.values.workCompleted, "on");
    assert.equal(draft?.values.recommendations, undefined);
  });

  it("черновик одной задачи не подставляется в другую", () => {
    saveClosureDraft("t1", { callReason: "Задача раз" });
    assert.equal(readClosureDraft("t2"), null);
  });

  it("после сохранения результата черновик убирается", () => {
    saveClosureDraft("t1", { callReason: "Текст" });
    clearClosureDraft("t1");
    assert.equal(readClosureDraft("t1"), null);
  });

  it("пустой черновик не хранится: иначе появилась бы подпись «восстановлен» без текста", () => {
    assert.equal(closureDraftIsEmpty({}), true);
    assert.equal(closureDraftIsEmpty({ callReason: "" }), true);
    assert.equal(closureDraftIsEmpty({ callReason: "а" }), false);
    saveClosureDraft("t1", { callReason: "Текст" });
    saveClosureDraft("t1", {});
    assert.equal(readClosureDraft("t1"), null);
  });

  it("черновик старше недели не всплывает: задача давно закрыта", () => {
    const old = new Date("2026-11-01T10:00:00Z");
    saveClosureDraft("t1", { callReason: "Старое" }, old);
    assert.equal(readClosureDraft("t1", new Date("2026-11-05T10:00:00Z"))?.values.callReason, "Старое");
    assert.equal(readClosureDraft("t1", new Date("2026-11-20T10:00:00Z")), null);
    // И не остаётся лежать мёртвым грузом.
    assert.equal(readClosureDraft("t1", new Date("2026-11-20T10:00:00Z")), null);
  });

  it("битая запись не роняет форму", () => {
    const data = installStorage();
    data.set("medtech-closure-draft:t1", "{не json");
    assert.equal(readClosureDraft("t1"), null);
  });

  it("запрет на данные сайта не мешает работать", () => {
    installStorage(true);
    assert.doesNotThrow(() => saveClosureDraft("t1", { callReason: "Текст" }));
    assert.doesNotThrow(() => clearClosureDraft("t1"));
    assert.equal(readClosureDraft("t1"), null);
  });

  it("поле берётся из черновика, а без него — из задачи", () => {
    const draft = { values: { callReason: "Из черновика", workCompleted: "on" }, savedAt: "2026-11-16T10:00:00.000Z" };
    assert.equal(closureDraftValue(draft, "callReason", "Из задачи"), "Из черновика");
    assert.equal(closureDraftValue(draft, "recommendations", "Из задачи"), "Из задачи");
    assert.equal(closureDraftValue(null, "callReason", "Из задачи"), "Из задачи");
    assert.equal(closureDraftChecked(draft, "workCompleted", false), true);
    assert.equal(closureDraftChecked(draft, "apparatusApproved", true), true);
    assert.equal(closureDraftChecked(null, "workCompleted", true), true);
  });

  it("пустая строка в черновике — это осознанно стёртое поле, а не «нет значения»", () => {
    // Пустые поля в черновик не попадают, поэтому стёртое поле вернётся из задачи.
    saveClosureDraft("t1", closureDraftValues(form({ callReason: "", workDescription: "Текст" })));
    const draft = readClosureDraft("t1");
    assert.equal(closureDraftValue(draft, "callReason", "Было в задаче"), "Было в задаче");
    assert.equal(closureDraftValue(draft, "workDescription", "Было в задаче"), "Текст");
  });
});
