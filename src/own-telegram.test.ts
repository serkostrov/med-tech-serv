import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2ApiClient } from "./m2-api.js";

/** Поддельный клиент Supabase только с вызовом функций базы. */
function rpcClient(response: { data?: unknown; error?: { message: string; code?: string } | null }) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: null, error: null, ...response });
    }
  };
  return { client: client as never, calls };
}

describe("свой номер чата Telegram в профиле", () => {
  it("сохраняет номер без пробелов через функцию базы", async () => {
    const { client, calls } = rpcClient({ data: "123456789" });
    assert.equal(await new M2ApiClient(client).setMyTelegramChatId(" 123456789 "), "123456789");
    assert.deepEqual(calls, [{ fn: "set_my_telegram_chat_id", args: { p_chat_id: "123456789" } }]);
  });

  it("пустое поле убирает Telegram", async () => {
    const { client, calls } = rpcClient({ data: null });
    assert.equal(await new M2ApiClient(client).setMyTelegramChatId("  "), undefined);
    assert.deepEqual(calls[0]?.args, { p_chat_id: "" });
  });

  it("пробелы внутри номера убирает, номер группы с минусом сам себе не вписать", async () => {
    const { client, calls } = rpcClient({ data: "123456789" });
    await new M2ApiClient(client).setMyTelegramChatId(" 123 456 789 ");
    assert.deepEqual(calls[0]?.args, { p_chat_id: "123456789" });
    const group = rpcClient({ data: null });
    await assert.rejects(new M2ApiClient(group.client).setMyTelegramChatId("-1001234567890"), /личного чата/u);
    assert.equal(group.calls.length, 0);
  });

  it("буквы не отправляет в базу", async () => {
    const { client, calls } = rpcClient({ data: null });
    await assert.rejects(new M2ApiClient(client).setMyTelegramChatId("abc"), /из цифр/u);
    assert.equal(calls.length, 0);
  });

  it("пока базу не обновили, объясняет, что номер вписывает администратор", async () => {
    const { client } = rpcClient({ error: { message: "Could not find the function public.set_my_telegram_chat_id(p_chat_id)", code: "PGRST202" } });
    await assert.rejects(new M2ApiClient(client).setMyTelegramChatId("123"), /администратор/u);
  });
});
