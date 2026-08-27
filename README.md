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

Задайте в **Environment** приложения (обычные runtime-переменные контейнера — достаточно):

| Переменная | Назначение |
|---|---|
| `VITE_SUPABASE_URL` | URL Supabase API |
| `VITE_SUPABASE_ANON_KEY` | Публичный anon-ключ |

При старте контейнера `docker/entrypoint.sh` пишет `/config.js`, и SPA читает значения оттуда. Пересобирать образ из‑за смены URL/ключа не нужно — достаточно Redeploy / Restart.

Публичный anon-ключ допустим на клиенте; service role и другие секреты **не** передавайте во фронт.

### 3. Домен и Supabase Auth

После выдачи домена приложения (свой или `*.sslip.io`):

1. В Supabase Auth → URL Configuration добавьте Site URL и Redirect URLs на этот домен.
2. Убедитесь, что CORS/домен API уже разрешает запросы с этого origin (обычно через URL проекта Supabase).
3. Примените миграции к production-БД до или вместе с выкладкой UI.

### 4. Альтернатива без своего Dockerfile

Можно использовать **Nixpacks** + **Static**:

- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- **Is Static SPA:** включено (чтобы `/tasks/:id` открывались с nginx `try_files`)

Рекомендуемый путь для production — `Dockerfile` из репозитория.

### 5. Локальная проверка образа (не на общей рабочей ВМ)

```bash
docker build -t medtechservice-web .
docker run --rm -p 8080:80 \
  -e VITE_SUPABASE_URL="https://your-supabase.example" \
  -e VITE_SUPABASE_ANON_KEY="your-anon-key" \
  medtechservice-web
```

Откройте `http://127.0.0.1:8080` и `http://127.0.0.1:8080/config.js` — там должны быть ваши значения.
