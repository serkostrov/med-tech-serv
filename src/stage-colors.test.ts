import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

/**
 * Один набор цветов этапов (UI/UX-разбор 19.11): «Назначена» была трёх разных жёлтых,
 * «Выполнена» на доске инженера красная, в календаре серая. Цвет этапа задаётся один раз в :root.
 */
describe("цвета этапов задачи", () => {
  const stages = ["planned", "new", "assigned", "in_progress", "under_review", "closed", "cancelled"];

  it("заданы один раз и берутся доской, календарём и отчётами оттуда", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    for (const stage of stages) {
      assert.equal(css.match(new RegExp(`--stage-${stage}:\\s*#[0-9a-f]{6};`, "gu"))?.length, 1, stage);
      assert.match(css, new RegExp(`\\.task-board__column--${stage} \\{ --stage-color: var\\(--stage-${stage}\\); \\}`, "u"));
    }
    for (const stage of stages.filter((item) => item !== "cancelled")) {
      assert.match(css, new RegExp(`\\.calendar-bar--${stage} \\{ --bar: var\\(--stage-${stage}\\);`, "u"));
      assert.match(css, new RegExp(`\\.report-bar--${stage} i \\{ background: var\\(--stage-${stage}\\); \\}`, "u"));
    }
  });

  it("доска инженера и клиента — тех же цветов", async () => {
    const board = await readFile(new URL("./TaskStageBoard.tsx", import.meta.url), "utf8");
    for (const stage of stages) assert.match(board, new RegExp(`key: "${stage}"[^}]*color: "var\\(--stage-${stage}\\)"`, "u"));
    assert.doesNotMatch(board, /color: "#/u);
  });
});
