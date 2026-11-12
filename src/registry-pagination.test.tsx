import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PAGE_SIZE_OPTIONS, RegistryPagination, registryPageCount, registryPageOffset, storedPageSize } from "./RegistryPagination.js";

describe("registry pagination", () => {
  it("calculates server offsets for records beyond the first page", () => {
    assert.equal(registryPageOffset(0, 100), 0);
    assert.equal(registryPageOffset(1, 100), 100);
    assert.equal(registryPageOffset(3, 50), 150);
    assert.equal(registryPageCount(251, 100), 3);
  });

  it("renders navigation and the total page count", () => {
    const markup = renderToStaticMarkup(<RegistryPagination
      ariaLabel="Страницы тестового реестра"
      onPageChange={() => undefined}
      pageIndex={1}
      pageSize={50}
      total={121}
    />);
    assert.match(markup, /Страница 2 из 3/u);
    assert.match(markup, />Назад</u);
    assert.match(markup, />Далее</u);
  });

  it("lets people choose 10, 50, 100 or 200 rows and shows the visible range", () => {
    assert.deepEqual(PAGE_SIZE_OPTIONS, [10, 50, 100, 200]);
    assert.equal(storedPageSize("100"), 100);
    assert.equal(storedPageSize("25"), 50);
    assert.equal(storedPageSize(null), 50);
    const markup = renderToStaticMarkup(<RegistryPagination
      ariaLabel="Страницы тестового реестра"
      onPageChange={() => undefined}
      onPageSizeChange={() => undefined}
      pageIndex={1}
      pageSize={50}
      total={121}
    />);
    assert.match(markup, /Показывать по/u);
    assert.match(markup, /51–100 из 121/u);
    // Всё на одной странице: переключатель размера остаётся, кнопок страниц нет.
    const single = renderToStaticMarkup(<RegistryPagination
      ariaLabel="Страницы тестового реестра"
      onPageChange={() => undefined}
      onPageSizeChange={() => undefined}
      pageIndex={0}
      pageSize={50}
      total={30}
    />);
    assert.match(single, /Показывать по/u);
    assert.doesNotMatch(single, />Далее</u);
  });
});
