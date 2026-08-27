# МедТехСервис

Приложение на Supabase: React SPA ходит напрямую в Auth, PostgREST и Storage.

```bash
npm install
cp .env.example .env
npm start
```

`npm start` и `npm run dev` поднимают UI на `http://127.0.0.1:5173`. Нужны `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`.

Схема лежит в `supabase/migrations/`. Локальный стек Supabase (не на общей рабочей ВМ с запретом Docker):

```bash
npx supabase start
npx supabase db reset
```

Пользователи входят через GoTrue (`auth.users`); рабочий профиль и роли — `public.users` с тем же `id`. Файлы пишутся в bucket `medtech-files`. Доменные ограничения остаются в PostgreSQL (триггеры, RPC вроде `change_equipment_site` и `accept_task_closure`).

## Деплой на Dokploy

SPA собирается в статику и отдаётся через nginx. В репозитории есть `Dockerfile` и `docker/nginx.conf`.

### 1. Application в Dokploy

- **Provider:** Git (этот репозиторий)
- **Build Type:** `Dockerfile`
- **Dockerfile path:** `Dockerfile`
- **Docker context:** `.`
- **Port:** `80`
- **Healthcheck path (если есть в UI):** `/healthz`

### 2. Переменные окружения (Dokploy Environment)

Задайте в **Environment** приложения (обычный runtime контейнера):

| Переменная | Назначение |
|---|---|
| `VITE_SUPABASE_URL` | URL Supabase API |
| `VITE_SUPABASE_ANON_KEY` | Публичный anon-ключ (RLS) |

При старте `entrypoint` вшивает значения в `index.html`. Отдельного `/config.js` нет (будет 404).

После смены env достаточно **Redeploy/Restart**. Build Arguments не обязательны.

### 3. Домен и Supabase Auth

После выдачи домена приложения (свой или `*.sslip.io`):

1. В Supabase Auth → URL Configuration добавьте Site URL и Redirect URLs на этот домен.
2. Убедитесь, что CORS/домен API уже разрешает запросы с этого origin (обычно через URL проекта Supabase).
3. Примените миграции к production-БД до или вместе с выкладкой UI.

### 4. Альтернатива без своего Dockerfile

Можно использовать **Nixpacks** + **Static**, но тогда `VITE_*` нужны на этапе сборки. Для Dokploy Environment удобнее `Dockerfile` из репозитория.

### 5. Локальная проверка образа (не на общей рабочей ВМ)

```bash
docker build -t medtechservice-web .
docker run --rm -p 8080:80 \
  -e VITE_SUPABASE_URL="https://your-supabase.example" \
  -e VITE_SUPABASE_ANON_KEY="your-anon-key" \
  medtechservice-web
```

Проверка: `http://127.0.0.1:8080/config.js` → 404; вход на `http://127.0.0.1:8080` должен открываться без ошибки env.
