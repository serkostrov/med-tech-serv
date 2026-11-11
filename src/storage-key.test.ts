import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { storageObjectName } from "./m2-api.js";

const SAFE = /^[0-9a-f-]{36}(\.[a-z0-9]{1,10})?$/u;

describe("имя объекта в хранилище", () => {
  it("русское имя со скриншота Mac даёт безопасный ключ с расширением", () => {
    const name = storageObjectName("Снимок экрана — 2026-11-11 в 15.00.30.png");
    assert.match(name, SAFE);
    assert.ok(name.endsWith(".png"));
  });

  it("расширение приводится к нижнему регистру, без расширения тоже работает", () => {
    assert.ok(storageObjectName("АКТ.JPG").endsWith(".jpg"));
    assert.match(storageObjectName("без расширения"), SAFE);
    assert.match(storageObjectName("файл.очень-странное"), SAFE);
  });

  it("каждый раз новое имя", () => {
    assert.notEqual(storageObjectName("a.png"), storageObjectName("a.png"));
  });
});
