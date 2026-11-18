import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mailBoxFilter, mailInBox } from "./mail-boxes.js";

describe("вкладки писем", () => {
  it("потенциальные задачи — открытые письма без отметки «не заявка»", () => {
    assert.equal(mailInBox({ status: "parsed" }, "potential"), true);
    assert.equal(mailInBox({ status: "pending" }, "potential"), true);
    assert.equal(mailInBox({ status: "parsed", notRequest: true }, "potential"), false);
    assert.equal(mailInBox({ status: "converted" }, "potential"), false);
    assert.equal(mailInBox({ status: "ignored" }, "potential"), false);
  });
  it("рассылка и «Не требует работы» — во «Не заявках», созданная задача — нет", () => {
    assert.equal(mailInBox({ status: "parsed", notRequest: true }, "junk"), true);
    assert.equal(mailInBox({ status: "ignored" }, "junk"), true);
    assert.equal(mailInBox({ status: "converted", notRequest: true }, "junk"), false);
  });
  it("с задачей — созданные задачи и ответы клиентов; все — всё", () => {
    assert.equal(mailInBox({ status: "converted" }, "tasks"), true);
    assert.equal(mailInBox({ status: "reply" }, "tasks"), true);
    assert.equal(mailInBox({ status: "parsed" }, "tasks"), false);
    assert.equal(mailInBox({ status: "ignored" }, "all"), true);
  });
  it("запрос к базе: отметка в разборе письма, пустая отметка — заявка", () => {
    assert.match(mailBoxFilter("potential").or ?? "", /notRequest\.is\.null/);
    assert.deepEqual(mailBoxFilter("tasks").statuses, ["converted", "reply"]);
    assert.match(mailBoxFilter("junk").or ?? "", /^status\.eq\.ignored,and\(/);
    assert.deepEqual(mailBoxFilter("all"), {});
  });
});
