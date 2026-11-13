import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { aiMailParserOrRules, type FetchLike } from "./ai-parser.js";

const neverCalled: FetchLike = async () => { throw new Error("сеть в тесте не нужна"); };

describe("нейросеть для разбора писем при запуске службы", () => {
  it("ошибка в настройках AI_* не роняет службу: предупреждение и разбор по правилам", () => {
    for (const environment of [
      { AI_PROVIDER: "yandex" },
      { AI_PROVIDER: "yandex", YANDEX_API_KEY: "k" },
      { AI_PROVIDER: "openai", AI_API_KEY: "k" },
      { AI_PROVIDER: "gigachat" }
    ]) {
      const warnings: string[] = [];
      assert.equal(aiMailParserOrRules(environment, (message) => warnings.push(message), neverCalled), undefined, environment.AI_PROVIDER);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /Разбор писем нейросетью выключен/u);
      assert.match(warnings[0] ?? "", /по правилам, уведомления работают/u);
    }
  });

  it("называет, что именно не так в настройках", () => {
    const warnings: string[] = [];
    aiMailParserOrRules({ AI_PROVIDER: "yandex" }, (message) => warnings.push(message), neverCalled);
    assert.match(warnings[0] ?? "", /YANDEX_API_KEY и YANDEX_FOLDER_ID/u);
  });

  it("без нейросети и с верными настройками предупреждений нет", () => {
    const warnings: string[] = [];
    assert.equal(aiMailParserOrRules({}, (message) => warnings.push(message), neverCalled), undefined);
    assert.equal(aiMailParserOrRules({ AI_PROVIDER: "none" }, (message) => warnings.push(message), neverCalled), undefined);
    assert.ok(aiMailParserOrRules({ AI_PROVIDER: "yandex", YANDEX_API_KEY: "k", YANDEX_FOLDER_ID: "f" }, (message) => warnings.push(message), neverCalled));
    assert.ok(aiMailParserOrRules({ AI_PROVIDER: "openai", AI_API_KEY: "k", AI_MODEL: "m" }, (message) => warnings.push(message), neverCalled));
    assert.deepEqual(warnings, []);
  });

  it("служба запускается с ошибкой в AI_PROVIDER и без настроек автоответа и продолжает работу", async () => {
    // Настоящий запуск main.ts. База и почта — закрытый порт на этом компьютере:
    // наружу служба не ходит, нужна только проверка, что запуск не упал.
    // Автоответ включён по умолчанию, а SMTP_* не заданы: выключаются только автоответы.
    const directory = await mkdtemp(join(tmpdir(), "medtech-worker-ai-"));
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", main], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: "postgres://worker:worker@127.0.0.1:1/medtech",
        PUBLIC_APP_URL: "http://localhost:5173",
        EMAIL_NOTIFICATIONS_ENABLED: "false",
        TELEGRAM_NOTIFICATIONS_ENABLED: "false",
        MAIL_INTAKE_ENABLED: "true",
        IMAP_HOST: "127.0.0.1",
        IMAP_PORT: "1",
        IMAP_SECURE: "false",
        IMAP_USER: "intake@example.test",
        IMAP_PASSWORD: "test-only",
        AI_PROVIDER: "yandex",
        WORKER_HEALTH_FILE: join(directory, "ready")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const started = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 20_000);
        const watch = () => {
          if (output.includes("Служба уведомлений запущена")) { clearTimeout(timer); resolve(true); }
        };
        child.stdout.on("data", watch);
        child.stderr.on("data", watch);
        void exited.then(() => { clearTimeout(timer); resolve(output.includes("Служба уведомлений запущена")); });
      });
      assert.ok(started, `служба не запустилась:\n${output}`);
      // Первый проход очереди и забор писем падают на закрытом порту: служба должна их пережить.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      assert.equal(child.exitCode, null, `служба не должна завершаться сама:\n${output}`);
      assert.match(output, /Разбор писем нейросетью выключен, ошибка в настройках AI: Для AI_PROVIDER=yandex нужны YANDEX_API_KEY и YANDEX_FOLDER_ID/u);
      assert.match(output, /Автоответы на заявки выключены, ошибка в настройках почты: SMTP_[A-Z_]+ is required/u);
      assert.match(output, /Служба уведомлений запущена: каналы нет, заявки из почты/u);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      const stop = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(stop);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
