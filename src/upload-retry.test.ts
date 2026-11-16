import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pendingAfterRetry, pendingUploadNames, pendingUploadsText } from "./upload-retry.js";

const file = (name: string) => ({ name });

describe("повтор загрузки файлов", () => {
  it("называет, чего именно не хватает, с правильными окончаниями", () => {
    assert.equal(pendingUploadsText([]), "");
    assert.equal(pendingUploadsText([{ kind: "photo" }]), "Не загрузился 1 фотография");
    assert.equal(pendingUploadsText([{ kind: "photo" }, { kind: "photo" }]), "Не загрузились 2 фотографии");
    assert.equal(pendingUploadsText([{ kind: "photo" }, { kind: "photo" }, { kind: "photo" }, { kind: "photo" }, { kind: "photo" }]), "Не загрузились 5 фотографий");
    assert.equal(pendingUploadsText([{ kind: "video" }]), "Не загрузился 1 видео");
  });

  it("фото акта называется фото акта, а не фотографией: это разные вещи для приёмки", () => {
    assert.equal(pendingUploadsText([{ kind: "act" }]), "Не загрузился фото акта");
    assert.equal(pendingUploadsText([{ kind: "act" }, { kind: "act" }]), "Не загрузились 2 фото акта");
  });

  it("перечисляет виды по порядку: акт первым, он нужен для передачи на проверку", () => {
    assert.equal(
      pendingUploadsText([{ kind: "video" }, { kind: "photo" }, { kind: "act" }]),
      "Не загрузились фото акта, 1 фотография и 1 видео"
    );
    assert.equal(
      pendingUploadsText([{ kind: "video" }, { kind: "photo" }, { kind: "photo" }]),
      "Не загрузились 2 фотографии и 1 видео"
    );
  });

  it("показывает имена файлов: по ним видно, что именно переотправится", () => {
    assert.equal(pendingUploadNames([{ file: file("акт.jpg") }, { file: file("шильдик.jpg") }]), "акт.jpg, шильдик.jpg");
    assert.equal(pendingUploadNames([]), "");
  });

  it("после повтора остаются только те, что снова не дошли", () => {
    const a = { kind: "photo" as const, file: file("1.jpg") };
    const b = { kind: "photo" as const, file: file("2.jpg") };
    const c = { kind: "video" as const, file: file("3.mp4") };
    assert.deepEqual(pendingAfterRetry([a, b, c], [a, c]), [b]);
    assert.deepEqual(pendingAfterRetry([a, b], [a, b]), []);
    assert.deepEqual(pendingAfterRetry([a, b], []), [a, b]);
  });

  it("два файла с одинаковым именем не путаются: сравниваем сам файл, а не имя", () => {
    const first = { kind: "photo" as const, file: file("IMG_0001.jpg") };
    const second = { kind: "photo" as const, file: file("IMG_0001.jpg") };
    assert.deepEqual(pendingAfterRetry([first, second], [first]), [second]);
  });
});
