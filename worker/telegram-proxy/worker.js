// Пересылка запросов бота МедТехСервиса в Telegram через Cloudflare Worker.
// Зачем: сервер стенда (Россия) не достаёт до api.telegram.org, а Cloudflare доступен.
// Как подключить: создать Worker в Cloudflare, вставить этот код, нажать Deploy,
// адрес Worker (https://….workers.dev) указать в настройке службы TELEGRAM_API_BASE_URL.
//
// Пропускаем только методы своего бота: номер бота — первая часть токена до двоеточия.
// Для бота заказчика поменяйте номер ниже.
const BOT_ID = "9234439901";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const allowed = new RegExp(`^/bot${BOT_ID}:[A-Za-z0-9_-]{20,}/[A-Za-z]+$`);
    if (!allowed.test(url.pathname)) return new Response("Not found", { status: 404 });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return fetch(`https://api.telegram.org${url.pathname}${url.search}`, {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
      ...(hasBody ? { body: await request.arrayBuffer() } : {})
    });
  }
};
