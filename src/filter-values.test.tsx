import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { filterSummary, filterValues, joinFilterValues, matchesFilter } from "./filter-values.js";
import { EngineerPicker, EngineerSelectField, matchesEngineerQuery } from "./EngineerPicker.js";
import { MultiSelect, WorkTypesPicker } from "./MultiSelect.js";
import type { AssignmentSuggestionRecord } from "./m2-api.js";

describe("фильтр с несколькими значениями", () => {
  it("строка через запятую превращается в список без пустых и повторов", () => {
    assert.deepEqual(filterValues("repair, installation,,repair"), ["repair", "installation"]);
    assert.deepEqual(filterValues(""), []);
    assert.deepEqual(filterValues(undefined), []);
    assert.equal(joinFilterValues(["a", "b", "a", " "]), "a,b");
  });
  it("одно значение — старые ссылки из отчётов работают как раньше", () => {
    assert.deepEqual(filterValues("closed"), ["closed"]);
    assert.equal(matchesFilter("closed", "closed"), true);
    assert.equal(matchesFilter("closed", "new"), false);
  });
  it("пустой отбор пропускает всё, список — любое из значений", () => {
    assert.equal(matchesFilter("", "new"), true);
    assert.equal(matchesFilter("new,assigned", "assigned"), true);
    assert.equal(matchesFilter("new,assigned", undefined), false);
  });
  it("подпись выбранного короткая", () => {
    const names: Record<string, string> = { a: "Ремонт", b: "ТО", c: "Инсталляция" };
    assert.equal(filterSummary([], (code) => names[code] ?? code), "Все");
    assert.equal(filterSummary(["a", "b"], (code) => names[code] ?? code), "Ремонт, ТО");
    assert.equal(filterSummary(["a", "b", "c"], (code) => names[code] ?? code), "Ремонт и ещё 2");
  });
  it("кнопка фильтра отмечает, что отбор задан", () => {
    const html = renderToStaticMarkup(<MultiSelect label="Вид работ" onChange={() => undefined} options={[{ value: "a", label: "Ремонт" }]} value={["a"]} />);
    assert.match(html, /data-filter-active="true"/);
    assert.match(html, /Ремонт/);
  });
});

describe("вид работ одним полем", () => {
  it("выпадающий список с галочками, как в фильтрах: выбранные видны на кнопке, строки «Все» нет", () => {
    const html = renderToStaticMarkup(<WorkTypesPicker onChange={() => undefined} options={[{ value: "repair", label: "Ремонт" }, { value: "install", label: "Инсталляция" }]} value={["install", "repair"]} />);
    assert.match(html, /Вид работ \*/);
    assert.match(html, /Инсталляция, Ремонт/);
    assert.doesNotMatch(html, /Можно выбрать несколько/);
  });
});

describe("поиск инженера", () => {
  const engineer = (index: number): AssignmentSuggestionRecord => ({ engineerId: `e${index}`, fullName: index === 0 ? "Кузнецова Мария Олеговна" : `Инженер ${index}`, isAvailable: true, previouslyWorkedWithEquipment: false });
  it("находит по началу фамилии без учёта регистра и «ё»", () => {
    assert.equal(matchesEngineerQuery("Кузнецова Мария Олеговна", "кузн"), true);
    assert.equal(matchesEngineerQuery("Королёв Пётр", "королев"), true);
    assert.equal(matchesEngineerQuery("Кузнецова Мария Олеговна", "петров"), false);
  });
  it("до 10 инженеров поиска нет, от 11 — есть", () => {
    const ten = Array.from({ length: 10 }, (_, index) => engineer(index));
    const eleven = Array.from({ length: 11 }, (_, index) => engineer(index));
    assert.doesNotMatch(renderToStaticMarkup(<EngineerPicker items={ten} onChange={() => undefined} value="" />), /Найти инженера/);
    assert.match(renderToStaticMarkup(<EngineerPicker items={eleven} onChange={() => undefined} value="" />), /Найти инженера/);
  });
});

describe("выбор инженера списком", () => {
  const list = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `e${index}`, fullName: `Инженер ${index}` }));
  it("в новой задаче и при назначении выбранным: поиск от 11 инженеров", () => {
    assert.doesNotMatch(renderToStaticMarkup(<EngineerSelectField emptyLabel="Назначу позже" engineers={list(10)} label="Инженер" onChange={() => undefined} value="" />), /Найти по фамилии/);
    assert.match(renderToStaticMarkup(<EngineerSelectField emptyLabel="Назначу позже" engineers={list(11)} label="Инженер" onChange={() => undefined} value="" />), /Найти по фамилии · всего 11/);
  });
});
