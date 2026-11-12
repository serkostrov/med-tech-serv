import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

/**
 * В Dokploy (тип Compose) переменная из вкладки Environment попадает в контейнер,
 * только если она перечислена в docker-compose.yml. Пропущенная переменная молча
 * не действует: например, тестовый режим почты не включился бы, и письма ушли бы клиентам.
 */
describe("переменные службы в docker-compose.yml", () => {
  it("передаёт в контейнер все настройки почты и Telegram, которые читает служба", async () => {
    const [compose, smtp, telegram, main, intake] = await Promise.all([
      readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
      readFile(new URL("./smtp.ts", import.meta.url), "utf8"),
      readFile(new URL("./telegram.ts", import.meta.url), "utf8"),
      readFile(new URL("./main.ts", import.meta.url), "utf8"),
      readFile(new URL("./mail-intake.ts", import.meta.url), "utf8")
    ]);
    const used = new Set(
      [...`${smtp}\n${telegram}\n${main}\n${intake}`.matchAll(/\b((?:SMTP|TELEGRAM|EMAIL|IMAP|MAIL_INTAKE)_[A-Z0-9_]+)\b/gu)]
        .map((match) => match[1] ?? "")
    );
    assert.ok(used.has("EMAIL_TEST_REDIRECT_TO"));
    assert.ok(used.has("MAIL_INTAKE_ONLY_TO"));
    for (const name of used) {
      assert.match(compose, new RegExp(`^\\s+${name}: \\$\\{${name}`, "mu"), `${name} нет в docker-compose.yml`);
    }
  });
});
