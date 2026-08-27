import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("мобильный список инженера", () => {
  it("сохраняет touch-размер, одноколоночный viewport и явное выделение новых задач", async () => {
    const [app, styles] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    const engineerSection = app.slice(
      app.indexOf("function EngineerTaskCard"),
      app.indexOf("function EngineerWorkspace")
    );

    assert.match(engineerSection, /m2Api\.engineerTasks\(\)/u);
    assert.match(engineerSection, /m2Api\.taskCard\(/u);
    assert.match(engineerSection, /onClick=\{\(\) => onOpen\(task\.id\)\}/u);
    assert.match(engineerSection, /mobile-task-card--new/u);
    assert.match(engineerSection, /className=\{`mobile-task-card/u);
    assert.doesNotMatch(engineerSection, /engineer-identity|Профиль инженера|Открыть задачу/u);
    assert.doesNotMatch(engineerSection, /цена|сумма|плательщик|финансовые поля/iu);
    assert.match(styles, /\.mobile-task-card\s*\{[\s\S]*?cursor:\s*pointer;/u);
    assert.match(styles, /\.mobile-task-card\s*\{[\s\S]*?touch-action:\s*manipulation;/u);
    assert.match(styles, /@media \(max-width:\s*700px\)[\s\S]*?\.mobile-task-list\s*\{[\s\S]*?grid-template-columns:\s*1fr;/u);
  });
});
