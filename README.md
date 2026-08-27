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

### Application

- **Build Type:** `Dockerfile`
- **Dockerfile path:** `Dockerfile`
- **Docker context:** `.`
- **Port:** `80`

### Build Arguments (обязательно)

Vite вшивает переменные **только при сборке**. В Dokploy задайте их как **Build Arguments** (или Environment с галочкой *Available at build time*):

| Имя | Значение |
|---|---|
| `VITE_SUPABASE_URL` | URL вашего Supabase |
| `VITE_SUPABASE_ANON_KEY` | anon key |

Без них сборка упадёт с явной ошибкой в логах Dokploy.

После смены URL/ключа нужен **полный Redeploy (rebuild)**, не только Restart.

### После деплоя

1. Supabase Auth → Site URL и Redirect URLs = домен фронта.
2. Миграции применить к production-БД.
3. `/config.js` не используется (404).

### Локальная проверка образа

```bash
docker build \
  --build-arg VITE_SUPABASE_URL="https://your-supabase.example" \
  --build-arg VITE_SUPABASE_ANON_KEY="your-anon-key" \
  -t medtechservice-web .
docker run --rm -p 8080:80 medtechservice-web
```
