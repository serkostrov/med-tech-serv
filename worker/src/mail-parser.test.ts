import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeDrafts, parseMailByRules } from "./mail-parser.js";

describe("разбор письма-заявки по правилам", () => {
  it("реальный пример заказчика", () => {
    const body = `Информация по Вашему запросу.

Клиент: Подпорожская МБ
Инженер: Кайдин Никита
Прибор: Mindray BS-620
S/N BJ1-58000885 — это поле обязательно.
запчасть 115-107131-00    Клапан
форма истории во вложении`;
    const result = parseMailByRules("Заявка", body);
    assert.equal(result.draft.client, "Подпорожская МБ");
    assert.equal(result.draft.equipmentName, "Mindray BS-620");
    assert.equal(result.draft.serialNumber, "BJ1-58000885");
    assert.equal(result.draft.engineerName, "Кайдин Никита");
    assert.deepEqual(result.draft.partNumbers, ["115-107131-00"]);
    assert.ok(result.confidence >= 0.6);
  });

  it("форма менеджера с ФИО и телефоном в одной строке, порядок другой", () => {
    const body = `Добрый день!
Описание неисправности или описание работ, которые необходимо выполнить: не включается, ошибка E-12
Заводской номер: 5412 HB 77
Наименование оборудования: Sysmex XN-350
Ф.И.О. и телефон для обратной связи: Петрова Анна Сергеевна, +7 (921) 555-12-34
Наименование клиента: ГБУЗ Городская поликлиника №3

С уважением, Анна`;
    const result = parseMailByRules("Срочно", body);
    assert.equal(result.draft.client, "ГБУЗ Городская поликлиника №3");
    assert.equal(result.draft.equipmentName, "Sysmex XN-350");
    assert.equal(result.draft.serialNumber, "5412 HB 77");
    assert.equal(result.draft.contactName, "Петрова Анна Сергеевна");
    assert.equal(result.draft.contactPhone, "+7 (921) 555-12-34");
    assert.match(result.draft.description ?? "", /не включается/u);
    assert.equal(result.confidence, 1);
  });

  it("номер в теме и свободный текст", () => {
    const result = parseMailByRules("Поломка анализатора S/N: AB-123456", "Не работает дозатор, прошу прислать инженера");
    assert.equal(result.draft.serialNumber, "AB-123456");
    assert.match(result.draft.description ?? "", /дозатор/u);
    assert.ok(result.confidence >= 0.5);
  });

  it("цитата прошлого письма не попадает в черновик", () => {
    const body = "Прибор: XN-350\n\n12.11.2026, 10:00, Иван пишет:\n> Клиент: Чужая больница\n> S/N ZZZ-999";
    const result = parseMailByRules("Re: Заявка", body);
    assert.equal(result.draft.client, undefined);
    assert.equal(result.draft.serialNumber, undefined);
  });

  it("пустое письмо даёт низкую уверенность", () => {
    const result = parseMailByRules("", "Здравствуйте");
    assert.ok(result.confidence < 0.3);
  });

  it("нейросеть дополняет пустые поля, заводской номер из правил сохраняется", () => {
    const rules = parseMailByRules("", "S/N AA-111\nне включается");
    const merged = mergeDrafts(rules, { draft: { serialNumber: "BB-222", client: "Больница №1" }, confidence: 0.9, source: "ai" });
    assert.equal(merged.draft.serialNumber, "AA-111");
    assert.equal(merged.draft.client, "Больница №1");
    assert.equal(merged.confidence, 0.9);
  });
});
