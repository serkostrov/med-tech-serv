import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { ChannelDeliveryError } from "./outbox.js";
import { NodeSmtpTransport, SmtpDeliveryChannel, smtpConfiguration, smtpMessageData, testRedirectedMessage, type SmtpConfiguration, type SmtpConnectionFactory, type SmtpMessage, type SmtpSocket, type SmtpTransport } from "./smtp.js";

class MemorySmtpTransport implements SmtpTransport {
  public readonly messages: SmtpMessage[] = [];
  public async send(message: SmtpMessage): Promise<void> { this.messages.push(message); }
}

class ScriptedSmtpSocket extends Duplex {
  public readonly commands: string[] = [];
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
