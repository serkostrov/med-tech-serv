import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileCaption, fileSizeLabel } from "./FileGallery.js";

describe("подпись размера файла", () => {
  it("килобайты и мегабайты", () => {
    assert.equal(fileSizeLabel(58_599), "57 КБ");
    assert.equal(fileSizeLabel(300), "1 КБ");
    assert.equal(fileSizeLabel(5 * 1024 * 1024), "5.0 МБ");
  });
  it("неизвестный размер (исходник письма — 1 байт в базе) не подписывается", () => {
    assert.equal(fileSizeLabel(1), "");
    assert.equal(fileSizeLabel(0), "");
    assert.equal(fileCaption(undefined, 1), "");
    assert.equal(fileCaption("Из письма клиента", 1), "Из письма клиента");
    assert.equal(fileCaption("Фото", 58_599), "Фото · 57 КБ");
  });
});
