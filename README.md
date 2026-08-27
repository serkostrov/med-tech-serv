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

### 2. Переменные на этапе сборки

Vite вшивает `VITE_*` в бандл, поэтому они нужны **на build**, не только в runtime:

| Переменная | Где |
|---|---|
| `VITE_SUPABASE_URL` | Build args / Environment (Available at build time) |
| `VITE_SUPABASE_ANON_KEY` | Build args / Environment (Available at build time) |

В Dockerfile они принимаются как `ARG` и попадают в `ENV` перед `npm run build`.

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
docker build \
  --build-arg VITE_SUPABASE_URL="https://your-supabase.example" \
  --build-arg VITE_SUPABASE_ANON_KEY="your-anon-key" \
  -t medtechservice-web .
docker run --rm -p 8080:80 medtechservice-web
```

Откройте `http://127.0.0.1:8080` и `http://127.0.0.1:8080/healthz`.
