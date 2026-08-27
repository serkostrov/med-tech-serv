import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistryPagination, registryPageCount, registryPageOffset } from "./RegistryPagination.js";

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
});
