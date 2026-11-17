import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskMailThread } from "./App.js";
import type { TaskMailMessage } from "./types.js";

const letter: TaskMailMessage = {
  id: "m1",
  direction: "incoming",
  author: "Смирнова А. В. <a.smirnova@gkb1.example>",
  subject: "Срочно: XN-1000 не берёт пробу",
  body: "Анализатор не берёт пробу, ошибка Aspiration error.",
  occurredAt: "2026-11-11T05:31:00.000Z",
  status: "converted",
  attachments: [
    { fileId: "f1", fileName: "Письмо клиента.eml", contentType: "message/rfc822", byteSize: 18_400, storageKey: "mail/m1/message.eml" },
    { fileId: "f2", fileName: "ошибка-на-экране.jpg", contentType: "image/jpeg", byteSize: 288_000, storageKey: "mail/m1/error.jpg" }
  ]
};

const reply: TaskMailMessage = {
  id: "r1",
  direction: "outgoing",
  author: "Морозова Елена Владимировна",
  recipient: "a.smirnova@gkb1.example",
  subject: "Re: Срочно: XN-1000 не берёт пробу",
  body: "Инженер приедет в среду после обеда.",
  occurredAt: "2026-11-11T06:06:00.000Z",
  status: "failed",
  error: "smtp_recipient_rejected",
  attachments: []
};

const render = (props: Partial<React.ComponentProps<typeof TaskMailThread>> = {}) => renderToStaticMarkup(<TaskMailThread
  canReply={false}
  error={null}
  loading={false}
  messages={[letter, reply]}
  onReload={() => undefined}
  onReply={async () => undefined}
  {...props}
/>);

describe("переписка с клиентом в карточке задачи", () => {
  it("показывает письмо клиента: от кого, когда, тему, текст и вложения", () => {
    const html = render();
    assert.match(html, /Смирнова А\. В\./u);
    assert.match(html, /a\.smirnova@gkb1\.example/u);
    assert.match(html, /11\.11\.2026/u);
    assert.match(html, /тема: Срочно: XN-1000 не берёт пробу/u);
    assert.match(html, /Анализатор не берёт пробу/u);
    // Вложения рисует обычная галерея файлов задачи: имя, размер и ссылка на файл.
    assert.match(html, /Письмо клиента\.eml/u);
    assert.match(html, /ошибка-на-экране\.jpg/u);
    assert.match(html, /281 КБ/u);
  });

  it("показывает ответ координатора и то, что он не ушёл", () => {
    const html = render();
    assert.match(html, /Ответ · Морозова Елена Владимировна/u);
    assert.match(html, /кому: a\.smirnova@gkb1\.example/u);
    // Причина по-русски, словарём экрана, а не кодом SMTP.
    assert.match(html, /Не отправлено: почтовый сервер не знает такого адреса/u);
    assert.doesNotMatch(html, /smtp_recipient_rejected/u);
    assert.match(html, /Ответ клиенту не ушёл/u);
  });

  it("даёт форму ответа только тому, кому можно, и называет адрес до отправки", () => {
    const allowed = render({ canReply: true });
    // Ответ оформлен как письмо: «Кому» и «Тема» видны до отправки, как их соберёт база.
    assert.match(allowed, /<h4>Ответ клиенту<\/h4>/u);
    assert.match(allowed, /<dt>Кому<\/dt><dd><span class="mail-compose__to">a\.smirnova@gkb1\.example<\/span>/u);
    assert.match(allowed, /<dt>Тема<\/dt><dd>Re: Срочно: XN-1000 не берёт пробу<\/dd>/u);
    assert.match(allowed, /Заявка принята<\/button>/u);
    assert.match(allowed, /<span>Отправить<\/span>/u);
    const denied = render();
    assert.doesNotMatch(denied, /mail-compose/u);
    assert.match(denied, /Отвечать клиенту по задаче может координатор или руководитель/u);
  });

  it("не теряет переписку при загрузке и ошибке", () => {
    assert.match(render({ loading: true }), /Загружаем переписку/u);
    const failed = render({ error: "Нет связи с базой" });
    assert.match(failed, /Переписка не загрузилась/u);
    assert.match(failed, /Нет связи с базой/u);
    assert.match(failed, /Повторить/u);
  });
});
