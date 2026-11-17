import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { simpleParser } from "mailparser";
import { ChannelDeliveryError, type ChannelDeliveryCommand } from "./outbox.js";
import { actFileName, attachmentContentType, attachmentFileName, dotStuffed, NodeSmtpTransport, PostgresEmailActSource, SmtpDeliveryChannel, smtpConfiguration, smtpMessageData, testRedirectedMessage, type EmailTaskCardSource, type SmtpConfiguration, type SmtpAttachment, type SmtpConnectionFactory, type SmtpMessage, type SmtpSocket, type SmtpTransport } from "./smtp.js";
import { supabaseFileReader, type DownloadFetch } from "./storage-upload.js";
import type { TaskCardData } from "./task-card.js";

class MemorySmtpTransport implements SmtpTransport {
  public readonly messages: SmtpMessage[] = [];
  public async send(message: SmtpMessage): Promise<void> { this.messages.push(message); }
}

class ScriptedSmtpSocket extends Duplex {
  public readonly commands: string[] = [];
  /** Содержимое DATA каждого письма, без завершающей точки. */
  public readonly messages: string[] = [];
  private buffer = "";
  private receivingData = false;

  public constructor(private readonly disconnectAfterData = false) {
    super();
    queueMicrotask(() => {
      this.emit("connect");
      this.push("220 smtp.test ready\r\n");
    });
  }

  public setTimeout(_timeout: number, _callback: () => void): this { return this; }

  public override _read(): void {}

  public override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      if (this.receivingData) {
        const messageEnd = this.buffer.indexOf("\r\n.\r\n");
        if (messageEnd < 0) break;
        this.messages.push(this.buffer.slice(0, messageEnd));
        this.buffer = this.buffer.slice(messageEnd + 5);
        this.receivingData = false;
        if (this.disconnectAfterData) {
          this.destroy(new Error("synthetic disconnect after DATA"));
          break;
        }
        this.push("250 message accepted\r\n");
        continue;
      }
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd < 0) break;
      const command = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 2);
      this.commands.push(command);
      if (command.startsWith("EHLO ")) this.push("250 smtp.test\r\n");
      else if (command.startsWith("MAIL FROM:")) this.push("250 sender ok\r\n");
      else if (command.startsWith("RCPT TO:")) this.push("250 recipient ok\r\n");
      else if (command === "DATA") {
        this.receivingData = true;
        this.push("354 send message\r\n");
      } else if (command === "QUIT") {
        this.push("500 quit failed\r\n");
      }
    }
    callback();
  }
}

const testSmtpConfiguration: SmtpConfiguration = {
  host: "smtp.example.test",
  port: 25,
  secure: false,
  startTls: "disabled",
  fromAddress: "service@example.test",
  fromName: "МедТехСервис",
  timeoutMs: 1_000
};

function testMessage(toAddress = "recipient@example.test"): SmtpMessage {
  return {
    messageId: "test-message@example.test",
    fromAddress: "service@example.test",
    fromName: "МедТехСервис",
    toAddress,
    subject: "Задача завершена",
    body: "Результат работ принят"
  };
}

describe("SMTP delivery adapter", () => {
  it("loads safe environment configuration without embedding credentials", () => {
    const configuration = smtpConfiguration({
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "587",
      SMTP_STARTTLS: "required",
      SMTP_USERNAME: "test-user",
      SMTP_PASSWORD: "test-password",
      SMTP_FROM_ADDRESS: "service@example.test",
      SMTP_FROM_NAME: "МедТехСервис"
    });
    assert.equal(configuration.host, "smtp.example.test");
    assert.equal(configuration.startTls, "required");
    assert.equal(configuration.password, "test-password");
  });

  it("derives the Message-ID from the durable delivery idempotency key", async () => {
    const transport = new MemorySmtpTransport();
    const channel = new SmtpDeliveryChannel({ fromAddress: "service@example.test", fromName: "МедТехСервис" }, transport);
    const command = {
      idempotencyKey: "task:test-39:email:recipient",
      eventCode: "task_engineer_assigned" as const,
      channel: "email" as const,
      recipientAddress: "recipient@example.test",
      subject: "Назначена задача",
      body: "Откройте карточку задачи"
    };
    const receipt = await channel.deliver(command);
    assert.equal(transport.messages.length, 1);
    assert.equal(transport.messages[0]?.messageId, receipt.providerMessageId);
  });

  it("builds a UTF-8 message with a base64 body safe for any SMTP server", () => {
    const data = smtpMessageData({
      messageId: "test-39@example.test",
      fromAddress: "service@example.test",
      fromName: "МедТехСервис",
      toAddress: "recipient@example.test",
      subject: "Задача завершена",
      body: "Первая строка\n.служебная строка"
    });
    assert.match(data, /Subject: =\?UTF-8\?B\?/u);
    assert.match(data, /Content-Transfer-Encoding: base64/u);
    const body = data.split("\r\n\r\n")[1] ?? "";
    assert.ok(body.split("\r\n").every((line) => line.length <= 76 && !line.startsWith(".")));
    assert.equal(Buffer.from(body.replace(/\r\n/gu, ""), "base64").toString("utf8"), "Первая строка\r\n.служебная строка");
  });

  it("sends every e-mail to the test address on a test stand and names the real recipient in the subject", async () => {
    const configuration = smtpConfiguration({
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM_ADDRESS: "service@example.test",
      EMAIL_TEST_REDIRECT_TO: "tester@example.test"
    });
    assert.equal(configuration.testRedirectTo, "tester@example.test");
    assert.throws(() => smtpConfiguration({ SMTP_HOST: "smtp.example.test", SMTP_FROM_ADDRESS: "service@example.test", EMAIL_TEST_REDIRECT_TO: "не адрес" }), /EMAIL_TEST_REDIRECT_TO/u);
    assert.equal(smtpConfiguration({ SMTP_HOST: "smtp.example.test", SMTP_FROM_ADDRESS: "service@example.test" }).testRedirectTo, undefined);

    const redirected = testRedirectedMessage(testMessage("client@hospital.example.test"), "tester@example.test");
    assert.equal(redirected.toAddress, "tester@example.test");
    assert.equal(redirected.subject, "[Тест, для client@hospital.example.test] Задача завершена");
    assert.equal(testRedirectedMessage(testMessage("Tester@Example.test"), "tester@example.test").subject, "Задача завершена");
    assert.equal(testRedirectedMessage(testMessage(), undefined).toAddress, "recipient@example.test");

    const socket = new ScriptedSmtpSocket();
    const connectionFactory: SmtpConnectionFactory = {
      connect: () => socket as unknown as SmtpSocket,
      upgrade: () => { throw new Error("STARTTLS не ожидался"); }
    };
    const transport = new NodeSmtpTransport({ ...testSmtpConfiguration, testRedirectTo: "tester@example.test" }, connectionFactory);
    await transport.send(testMessage("client@hospital.example.test"));
    assert.ok(socket.commands.includes("RCPT TO:<tester@example.test>"));
    assert.ok(!socket.commands.some((command) => command.includes("client@hospital.example.test") && command.startsWith("RCPT")));
  });

  it("checks the real recipient before redirecting on a test stand", async () => {
    let connections = 0;
    const connectionFactory: SmtpConnectionFactory = {
      connect: () => { connections += 1; return new ScriptedSmtpSocket() as unknown as SmtpSocket; },
      upgrade: () => { throw new Error("STARTTLS не ожидался"); }
    };
    const transport = new NodeSmtpTransport({ ...testSmtpConfiguration, testRedirectTo: "tester@example.test" }, connectionFactory);
    await assert.rejects(
      transport.send(testMessage("victim@example.test\r\nRCPT TO:<attacker@example.test>")),
      (error: unknown) => error instanceof ChannelDeliveryError && error.diagnosticCode === "smtp_invalid_address"
    );
    assert.equal(connections, 0);
  });

  it("treats DATA 250 as delivered when QUIT returns an error", async () => {
    const socket = new ScriptedSmtpSocket();
    const connectionFactory: SmtpConnectionFactory = {
      connect: () => socket as unknown as SmtpSocket,
      upgrade: () => { throw new Error("STARTTLS не ожидался"); }
    };
    const transport = new NodeSmtpTransport(testSmtpConfiguration, connectionFactory);
    await transport.send({ ...testMessage(), messageId: "accepted-before-quit@example.test" });
    assert.equal(socket.commands.at(-1), "QUIT");
  });

  it("rejects a command-injection recipient before connecting or writing to a socket", async () => {
    const socket = new ScriptedSmtpSocket();
    let connections = 0;
    const connectionFactory: SmtpConnectionFactory = {
      connect: () => { connections += 1; return socket as unknown as SmtpSocket; },
      upgrade: () => { throw new Error("STARTTLS не ожидался"); }
    };
    const transport = new NodeSmtpTransport(testSmtpConfiguration, connectionFactory);

    await assert.rejects(
      transport.send(testMessage("victim@example.test\r\nRCPT TO:<attacker@example.test>")),
      (error: unknown) => error instanceof ChannelDeliveryError && error.diagnosticCode === "smtp_invalid_address"
    );
    assert.equal(connections, 0);
    assert.deepEqual(socket.commands, [], "в сокет не записано ни одной SMTP-команды");
  });

  it("reports an unknown delivery outcome when the connection drops after DATA", async () => {
    const socket = new ScriptedSmtpSocket(true);
    const connectionFactory: SmtpConnectionFactory = {
      connect: () => socket as unknown as SmtpSocket,
      upgrade: () => { throw new Error("STARTTLS не ожидался"); }
    };
    const transport = new NodeSmtpTransport(testSmtpConfiguration, connectionFactory);

    await assert.rejects(
      transport.send(testMessage()),
      (error: unknown) => error instanceof ChannelDeliveryError
        && error.diagnosticCode === "smtp_delivery_outcome_unknown"
        && error.retryAllowed === false
    );
    assert.equal(socket.commands.at(-1), "DATA");
  });
});

/** Поддельный SMTP-сервер: сокет создаётся при подключении, как настоящий, а не заранее. */
function scriptedServer(): { readonly sockets: ScriptedSmtpSocket[]; readonly factory: SmtpConnectionFactory } {
  const sockets: ScriptedSmtpSocket[] = [];
  return {
    sockets,
    factory: {
      connect: () => {
        const socket = new ScriptedSmtpSocket();
        sockets.push(socket);
        return socket as unknown as SmtpSocket;
      },
      upgrade: () => { throw new Error("STARTTLS не ожидался"); }
    }
  };
}

/** Разбор multipart/alternative вручную: заголовки письма, граница и части с их заголовками. */
function multipartParts(data: string): { readonly head: string; readonly parts: ReadonlyArray<{ readonly headers: readonly string[]; readonly body: string }> } {
  const headEnd = data.indexOf("\r\n\r\n");
  const head = data.slice(0, headEnd);
  const boundary = /^Content-Type: multipart\/alternative; boundary="([^"]+)"$/mu.exec(head)?.[1];
  assert.ok(boundary, "в заголовках есть граница частей");
  const chunks = data.slice(headEnd + 4).split(`--${boundary}`);
  assert.equal(chunks[0], "", "письмо начинается с границы");
  assert.equal(chunks.at(-1), "--", "письмо заканчивается закрывающей границей");
  const parts = chunks.slice(1, -1).map((chunk) => {
    assert.ok(chunk.startsWith("\r\n") && chunk.endsWith("\r\n"), "граница на отдельной строке");
    const inner = chunk.slice(2, -2);
    const split = inner.indexOf("\r\n\r\n");
    return { headers: inner.slice(0, split).split("\r\n"), body: inner.slice(split + 4) };
  });
  return { head, parts };
}

function base64Text(body: string): string {
  assert.ok(body.split("\r\n").every((line) => /^[A-Za-z0-9+/=]{1,76}$/u.test(line)), "base64 строками до 76 символов");
  return Buffer.from(body.replace(/\r\n/gu, ""), "base64").toString("utf8");
}

const html = "<!DOCTYPE html>\n<html lang=\"ru\"><body><p>Привет</p>\n.\n<p>Карточка задачи</p></body></html>";

describe("HTML-письма", () => {
  it("собирает multipart/alternative: текст из шаблона и HTML, обе части в UTF-8 и base64", async () => {
    const data = smtpMessageData({ ...testMessage(), body: "Первая строка\nвторая", html });
    const { head, parts } = multipartParts(data);
    assert.match(head, /^MIME-Version: 1\.0$/mu);
    assert.match(head, /^Subject: =\?UTF-8\?B\?/mu);
    // У самого multipart нет Content-Transfer-Encoding: base64 только у частей.
    assert.doesNotMatch(head, /Content-Transfer-Encoding/u);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0]?.headers, ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"]);
    assert.deepEqual(parts[1]?.headers, ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"]);
    assert.equal(base64Text(parts[0]?.body ?? ""), "Первая строка\r\nвторая");
    assert.equal(base64Text(parts[1]?.body ?? ""), html.replace(/\n/gu, "\r\n"));

    // Независимая проверка: письмо разбирает почтовая библиотека.
    const parsed = await simpleParser(data);
    assert.equal(parsed.subject, "Задача завершена");
    assert.equal(parsed.text, "Первая строка\nвторая");
    assert.equal(parsed.html, html);
  });

  it("без HTML письмо прежнее: одна часть text/plain", () => {
    const data = smtpMessageData(testMessage());
    assert.match(data, /^Content-Type: text\/plain; charset=UTF-8$/mu);
    assert.doesNotMatch(data, /multipart|text\/html/u);
  });

  it("строки не длиннее 998 символов даже с длинной темой; ни одна строка не начинается с точки", async () => {
    const subject = "Очень длинная тема письма о задаче ".repeat(20).trim();
    const message = testRedirectedMessage({ ...testMessage("client@hospital.example.test"), subject, html: `${"<p>Текст</p>".repeat(2_000)}\n.\n` }, "tester@example.test");
    const data = smtpMessageData(message);
    const lines = data.split("\r\n");
    assert.ok(lines.every((line) => line.length <= 998), "строки до 998 символов");
    assert.ok(lines.every((line) => !line.startsWith(".")), "точки в начале строк нет");
    // RFC 2047: слово не длиннее 75 символов, строка заголовка со словами — не длиннее 76.
    const words = data.match(/=\?UTF-8\?B\?[^?]*\?=/gu) ?? [];
    assert.ok(words.length > 2 && words.every((word) => word.length <= 75));
    const subjectLines = /^Subject: .*(?:\r\n .*)*/mu.exec(data)?.[0].split("\r\n") ?? [];
    assert.ok(subjectLines.length > 2 && subjectLines.every((line) => line.length <= 76), "строки темы до 76 символов");
    const parsed = await simpleParser(data);
    assert.equal(parsed.subject, `[Тест, для client@hospital.example.test] ${subject}`);
    assert.equal(parsed.html, message.html);
  });

  it("dot-stuffing: строке с точкой в начале добавляется вторая точка", () => {
    assert.equal(dotStuffed(".начало\r\nтекст\r\n.\r\n..две"), "..начало\r\nтекст\r\n..\r\n...две");
    assert.equal(dotStuffed("без точек\r\nв начале. строк"), "без точек\r\nв начале. строк");
  });

  it("тестовый режим перенаправляет и HTML-письмо: адрес, тема и обе части", async () => {
    const server = scriptedServer();
    const transport = new NodeSmtpTransport({ ...testSmtpConfiguration, testRedirectTo: "tester@example.test" }, server.factory);
    await transport.send({ ...testMessage("client@hospital.example.test"), html });
    const socket = server.sockets[0];
    assert.ok(socket);
    assert.ok(socket.commands.includes("RCPT TO:<tester@example.test>"));
    assert.ok(!socket.commands.some((command) => command.startsWith("RCPT") && command.includes("client@hospital.example.test")));
    assert.equal(socket.messages.length, 1);
    const parsed = await simpleParser(socket.messages[0] ?? "");
    assert.equal(parsed.subject, "[Тест, для client@hospital.example.test] Задача завершена");
    assert.equal(parsed.text, "Результат работ принят");
    assert.equal(parsed.html, html);
  });

  it("внедрение команд в конверт отклоняется и для HTML-писем, до подключения", async () => {
    const server = scriptedServer();
    const transport = new NodeSmtpTransport({ ...testSmtpConfiguration, testRedirectTo: "tester@example.test" }, server.factory);
    await assert.rejects(
      transport.send({ ...testMessage("victim@example.test\r\nRCPT TO:<attacker@example.test>"), html }),
      (error: unknown) => error instanceof ChannelDeliveryError && error.diagnosticCode === "smtp_invalid_address"
    );
    await assert.rejects(
      transport.send({ ...testMessage(), subject: "Тема\r\nBcc: attacker@example.test", html }),
      (error: unknown) => error instanceof ChannelDeliveryError && error.diagnosticCode === "smtp_invalid_message"
    );
    assert.equal(server.sockets.length, 0, "к серверу не подключались, в сокет ничего не записано");
  });
});

describe("письмо о задаче в канале e-mail", () => {
  const card: TaskCardData = {
    eventCode: "task_rework_requested",
    recipientName: "Пётр Андреевич",
    taskNumber: "З-000007",
    taskTitle: "Замена датчика давления",
    siteName: "ГКБ №1, КДЛ",
    engineerName: "Иванов П. А.",
    reworkComment: "Нет фото акта"
  };
  const delivery: ChannelDeliveryCommand = {
    idempotencyKey: "task_rework_requested:t1:1:email:u1",
    eventCode: "task_rework_requested",
    channel: "email",
    recipientAddress: "Engineer@Clinic.example.test",
    subject: "Задача З-000007 возвращена на доработку",
    body: "Здравствуйте, Пётр Андреевич!\n\nКарточка задачи: https://crm.example.test/tasks/t%201",
    taskId: "t 1",
    outboxEventId: "00000000-0000-4000-8000-000000000001"
  };
  const sender = { fromAddress: "service@example.test", fromName: "МедТехСервис" };

  it("собирает HTML по исходному адресу доставки, текст письма — из шаблона", async () => {
    const asked: string[] = [];
    const transport = new MemorySmtpTransport();
    const channel = new SmtpDeliveryChannel(sender, transport, {
      publicAppUrl: "https://crm.example.test/",
      cards: { load: async (command) => { asked.push(command.recipientAddress); return card; } }
    });
    await channel.deliver(delivery);
    assert.deepEqual(asked, ["Engineer@Clinic.example.test"]);
    const message = transport.messages[0];
    assert.equal(message?.body, delivery.body);
    assert.equal(message?.subject, delivery.subject);
    assert.match(message?.html ?? "", /<a href="https:\/\/crm\.example\.test\/tasks\/t%201" target="_blank" [^>]*>Открыть задачу<\/a>/u);
    assert.match(message?.html ?? "", /Здравствуйте, Пётр Андреевич!/u);
  });

  it("без данных карточки, при сбое или долгом ответе базы письмо уходит только текстом", async () => {
    const sources: ReadonlyArray<EmailTaskCardSource | undefined> = [
      undefined,
      { load: async () => undefined },
      { load: async () => { throw new Error("база недоступна"); } },
      { load: () => { throw new Error("сбой до запроса"); } },
      { load: () => new Promise<never>(() => undefined) }
    ];
    for (const cards of sources) {
      const transport = new MemorySmtpTransport();
      const channel = new SmtpDeliveryChannel(sender, transport, { publicAppUrl: "https://crm.example.test", cardTimeoutMs: 20, ...(cards ? { cards } : {}) });
      const receipt = await channel.deliver(delivery);
      assert.equal(transport.messages.length, 1);
      assert.equal(transport.messages[0]?.messageId, receipt.providerMessageId);
      assert.equal(transport.messages[0]?.html, undefined);
      const data = smtpMessageData(transport.messages[0] as SmtpMessage);
      assert.match(data, /^Content-Type: text\/plain; charset=UTF-8$/mu);
      assert.doesNotMatch(data, /multipart|text\/html/u);
    }
  });

  it("в тестовом режиме данные ищутся по исходному адресу, а письмо с HTML уходит на тестовый", async () => {
    const asked: string[] = [];
    const server = scriptedServer();
    const transport = new NodeSmtpTransport({ ...testSmtpConfiguration, testRedirectTo: "tester@example.test" }, server.factory);
    const channel = new SmtpDeliveryChannel(sender, transport, {
      publicAppUrl: "https://crm.example.test",
      cards: { load: async (command) => { asked.push(command.recipientAddress); return card; } }
    });
    await channel.deliver({ ...delivery, recipientAddress: "client@hospital.example.test" });
    assert.deepEqual(asked, ["client@hospital.example.test"]);
    const socket = server.sockets[0];
    assert.ok(socket);
    assert.ok(socket.commands.includes("RCPT TO:<tester@example.test>"));
    const parsed = await simpleParser(socket.messages[0] ?? "");
    assert.equal(parsed.subject, "[Тест, для client@hospital.example.test] Задача З-000007 возвращена на доработку");
    assert.equal(parsed.text, delivery.body);
    assert.match(String(parsed.html), /Что доработать/u);
    assert.match(String(parsed.html), /Открыть задачу/u);
  });
});


it("autoreplies can point replies to the request address", async () => {
  const { smtpMessageData } = await import("./smtp.js");
  const base = { messageId: "a@b.example", fromAddress: "crm@b.example", fromName: "CRM", toAddress: "client@clinic.example", subject: "Заявка принята", body: "Текст" };
  const data = smtpMessageData({ ...base, replyTo: "crm+zayavki@b.example", autoSubmitted: true });
  assert.match(data, /^Reply-To: <crm\+zayavki@b\.example>$/mu);
  assert.doesNotMatch(smtpMessageData(base), /^Reply-To:/mu);
  assert.throws(() => smtpMessageData({ ...base, replyTo: "bad address\r\nBcc: x@y.z" }));
});

describe("акт во вложении письма «Работы завершены»", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0x00, 0x2e, 0x0d, 0x0a, 0x2e]);
  const act: SmtpAttachment = { fileName: "Акт З-000123.pdf", contentType: "application/pdf", data: pdf };
  const delivery: ChannelDeliveryCommand = {
    idempotencyKey: "task_work_completed:t1:1:email:c1",
    eventCode: "task_work_completed",
    channel: "email",
    recipientAddress: "client@hospital.example.test",
    subject: "Работы по задаче З-000123 завершены",
    body: "Здравствуйте!\n\nРаботы по задаче З-000123 завершены.\n",
    taskId: "t1",
    outboxEventId: "00000000-0000-4000-8000-000000000123"
  };
  const sender = { fromAddress: "service@example.test", fromName: "МедТехСервис" };

  it("письмо с актом — multipart/mixed: текст и HTML, затем файл; почтовая библиотека читает имя и содержимое", async () => {
    const data = smtpMessageData({ ...testMessage(), html, attachments: [act] });
    const head = data.slice(0, data.indexOf("\r\n\r\n"));
    assert.match(head, /^Content-Type: multipart\/mixed; boundary="=_mts_[0-9a-f]{32}"$/mu);
    const lines = data.split("\r\n");
    assert.ok(lines.every((line) => line.length <= 998), "строки до 998 символов");
    assert.ok(lines.every((line) => !line.startsWith(".")), "точки в начале строк нет");
    const parsed = await simpleParser(data);
    assert.equal(parsed.subject, "Задача завершена");
    assert.equal(parsed.html, html);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0]?.filename, "Акт З-000123.pdf");
    assert.equal(parsed.attachments[0]?.contentType, "application/pdf");
    assert.equal(parsed.attachments[0]?.contentDisposition, "attachment");
    assert.deepEqual(new Uint8Array(parsed.attachments[0]?.content ?? []), pdf);
  });

  it("акт прикладывается и к письму только текстом; ASCII-имя идёт как есть", async () => {
    const data = smtpMessageData({ ...testMessage(), attachments: [{ fileName: "act-123.jpg", contentType: "image/jpeg", data: pdf }] });
    assert.match(data, /^Content-Disposition: attachment; filename="act-123\.jpg"$/mu);
    const parsed = await simpleParser(data);
    assert.equal(parsed.text, testMessage().body);
    assert.equal(parsed.attachments[0]?.filename, "act-123.jpg");
    assert.equal(parsed.attachments[0]?.contentType, "image/jpeg");
  });

  it("тип и имя файла из базы не могут добавить заголовок письму", () => {
    assert.equal(attachmentContentType("application/pdf"), "application/pdf");
    assert.equal(attachmentContentType("Image/JPEG "), "image/jpeg");
    assert.equal(attachmentContentType("text/html\r\nBcc: x@y.z"), "application/octet-stream");
    assert.equal(attachmentContentType("application/pdf; name=x"), "application/octet-stream");
    assert.equal(attachmentContentType(""), "application/octet-stream");
    assert.equal(attachmentFileName("Акт\r\nBcc: x@y.z.pdf"), "Акт Bcc x@y.z.pdf");
    assert.equal(attachmentFileName("../../\"акт\".pdf"), ".. .. акт .pdf");
    assert.equal(attachmentFileName("   "), "Вложение");
    const long = attachmentFileName(`${"очень длинное имя ".repeat(10)}.jpeg`);
    assert.equal([...long].length, 80);
    assert.ok(long.endsWith(".jpeg"));
    const data = smtpMessageData({ ...testMessage(), attachments: [{ fileName: "a\r\nBcc: x@y.z", contentType: "text/plain\r\nBcc: x@y.z", data: pdf }] });
    assert.doesNotMatch(data, /^Bcc:/mu);
  });

  it("имя акта у клиента: номер задачи и расширение исходного файла", () => {
    assert.equal(actFileName("З-000123", "IMG_2041.JPG"), "Акт З-000123.jpg");
    assert.equal(actFileName("З-000123", "скан акта"), "Акт З-000123");
    assert.equal(actFileName(undefined, "act.pdf"), "Акт.pdf");
  });

  it("канал прикладывает акт к «Работы завершены», в тексте и в карточке — что акт во вложении", async () => {
    const asked: string[] = [];
    const transport = new MemorySmtpTransport();
    const channel = new SmtpDeliveryChannel(sender, transport, {
      cards: { load: async () => ({ eventCode: "task_work_completed", taskNumber: "З-000123", taskTitle: "Замена лампы" }) },
      acts: { load: async (command) => { asked.push(command.outboxEventId ?? ""); return act; } }
    });
    await channel.deliver(delivery);
    assert.deepEqual(asked, [delivery.outboxEventId]);
    const message = transport.messages[0];
    assert.deepEqual(message?.attachments, [act]);
    assert.equal(message?.body, "Здравствуйте!\n\nРаботы по задаче З-000123 завершены.\n\nАкт выполненных работ — во вложении к письму.");
    assert.match(message?.html ?? "", />Акт<\/td>/u);
    assert.match(message?.html ?? "", /во вложении к письму/u);
  });

  it("нет акта, сбой хранилища или долгий ответ — письмо уходит без вложения и без строки про акт", async () => {
    const sources = [
      { load: async () => undefined },
      { load: async () => { throw new Error("storage_download_404"); } },
      { load: () => new Promise<never>(() => undefined) }
    ];
    for (const acts of sources) {
      const transport = new MemorySmtpTransport();
      const channel = new SmtpDeliveryChannel(sender, transport, { acts, actTimeoutMs: 20 });
      await channel.deliver(delivery);
      assert.equal(transport.messages.length, 1);
      assert.equal(transport.messages[0]?.attachments, undefined);
      assert.equal(transport.messages[0]?.body, delivery.body);
    }
  });

  it("к другим письмам акт не ищется", async () => {
    let calls = 0;
    const transport = new MemorySmtpTransport();
    const channel = new SmtpDeliveryChannel(sender, transport, { acts: { load: async () => { calls += 1; return act; } } });
    await channel.deliver({ ...delivery, eventCode: "task_engineer_assigned" });
    assert.equal(calls, 0);
    assert.equal(transport.messages[0]?.attachments, undefined);
  });

  it("источник акта: спрашивает базу по событию, берёт файл из хранилища, большой файл не прикладывает", async () => {
    const queries: unknown[][] = [];
    const row = { task_number: "З-000123", storage_key: "tasks/t1/a.pdf", original_name: "скан.PDF", content_type: "application/pdf", byte_size: "15" };
    const database = { executeSql: async (_text: string, values?: readonly unknown[]) => { queries.push([...(values ?? [])]); return { rows: [row] }; } };
    const keys: string[] = [];
    const files = { get: async (key: string) => { keys.push(key); return pdf; } };
    const source = new PostgresEmailActSource(database, files);
    assert.deepEqual(await source.load(delivery), { fileName: "Акт З-000123.pdf", contentType: "application/pdf", data: pdf });
    assert.deepEqual(queries, [[delivery.outboxEventId]]);
    assert.deepEqual(keys, ["tasks/t1/a.pdf"]);

    assert.equal(await source.load({ ...delivery, eventCode: "task_engineer_assigned" }), undefined);
    const { outboxEventId: _skip, ...withoutEvent } = delivery;
    assert.equal(await source.load(withoutEvent), undefined);
    assert.equal(queries.length, 1, "для других писем база не спрашивается");

    const small = new PostgresEmailActSource(database, files, 10);
    assert.equal(await small.load(delivery), undefined, "файл больше предела не скачивается");
    assert.deepEqual(keys, ["tasks/t1/a.pdf"]);

    const empty = new PostgresEmailActSource({ executeSql: async () => ({ rows: [] }) }, files);
    assert.equal(await empty.load(delivery), undefined);
  });

  it("чтение из хранилища: ключ сервиса, путь по частям, «..» и ответ не 200 не проходят", async () => {
    assert.equal(supabaseFileReader({}), undefined);
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let status = 200;
    const fetchImpl: DownloadFetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      return { status, headers: { get: () => null }, arrayBuffer: async () => pdf.buffer.slice(0) };
    };
    const reader = supabaseFileReader({ SUPABASE_URL: "http://kong:8000/", SUPABASE_SERVICE_ROLE_KEY: "service-key" }, fetchImpl);
    assert.ok(reader);
    assert.deepEqual(await reader.get("tasks/t 1/акт.pdf", 1_000), pdf);
    assert.equal(requests[0]?.url, "http://kong:8000/storage/v1/object/authenticated/medtech-files/tasks/t%201/%D0%B0%D0%BA%D1%82.pdf");
    assert.equal(requests[0]?.headers.Authorization, "Bearer service-key");
    assert.equal(await reader.get("tasks/../secret", 1_000), undefined);
    assert.equal(await reader.get("", 1_000), undefined);
    assert.equal(requests.length, 1);
    assert.equal(await reader.get("tasks/t1/a.pdf", 5), undefined, "больше предела — не прикладываем");
    status = 404;
    await assert.rejects(reader.get("tasks/t1/a.pdf", 1_000), /storage_download_404/u);
  });
});
