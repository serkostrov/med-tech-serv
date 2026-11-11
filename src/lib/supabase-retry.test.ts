import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithReadRetry } from "./supabase.js";

function scripted(statuses: number[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
    return new Response("тело", { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const delays: number[] = [];
const recordSleep = async (ms: number) => { delays.push(ms); };
const AUTH = "https://x/auth/v1/user";
const STORAGE = "https://x/storage/v1/object/medtech-files/a.jpg";

describe("повтор чтения при сбоях шлюза", () => {
  it("повторяет GET и HEAD входа и файлов после 502/503 с паузами 400 и 1200 мс", async () => {
    delays.length = 0;
    const get = scripted([503, 502, 200]);
    const r = await fetchWithReadRetry(AUTH, undefined, get.fetchImpl, recordSleep);
    assert.equal(r.status, 200);
    assert.equal(get.calls.length, 3);
    assert.deepEqual(delays, [400, 1200]);
    const head = scripted([503, 200]);
    assert.equal((await fetchWithReadRetry(STORAGE, { method: "head" }, head.fetchImpl, recordSleep)).status, 200);
    assert.equal(head.calls.length, 2);
  });

  it("метод берётся и из объекта Request", async () => {
    const s = scripted([503, 200]);
    const r = await fetchWithReadRetry(new Request(AUTH, { method: "GET" }), undefined, s.fetchImpl, recordSleep);
    assert.equal(r.status, 200);
    assert.equal(s.calls.length, 2);
    const post = scripted([503, 200]);
    await fetchWithReadRetry(new Request(AUTH, { method: "POST", body: "x" }), undefined, post.fetchImpl, recordSleep);
    assert.equal(post.calls.length, 1);
  });

  it("не больше двух повторов", async () => {
    const s = scripted([503, 503, 503, 200]);
    assert.equal((await fetchWithReadRetry(AUTH, { method: "GET" }, s.fetchImpl, recordSleep)).status, 503);
    assert.equal(s.calls.length, 3);
  });

  it("запросы к данным оставляет встроенному повтору postgrest-js", async () => {
    const s = scripted([503, 200]);
    assert.equal((await fetchWithReadRetry("https://x/rest/v1/tasks", { method: "HEAD" }, s.fetchImpl, recordSleep)).status, 503);
    assert.equal(s.calls.length, 1);
  });

  it("запись, 504 и обычные ошибки не повторяет", async () => {
    const post = scripted([503, 200]);
    assert.equal((await fetchWithReadRetry(STORAGE, { method: "POST" }, post.fetchImpl, recordSleep)).status, 503);
    assert.equal(post.calls.length, 1);
    const timeout = scripted([504, 200]);
    assert.equal((await fetchWithReadRetry(AUTH, { method: "GET" }, timeout.fetchImpl, recordSleep)).status, 504);
    assert.equal(timeout.calls.length, 1);
    const denied = scripted([401, 200]);
    assert.equal((await fetchWithReadRetry(AUTH, { method: "GET" }, denied.fetchImpl, recordSleep)).status, 401);
    assert.equal(denied.calls.length, 1);
  });

  it("после отмены запроса больше не повторяет", async () => {
    const controller = new AbortController();
    controller.abort();
    const s = scripted([503, 200]);
    assert.equal((await fetchWithReadRetry(AUTH, { method: "GET", signal: controller.signal }, s.fetchImpl, recordSleep)).status, 503);
    assert.equal(s.calls.length, 1);
  });
});
