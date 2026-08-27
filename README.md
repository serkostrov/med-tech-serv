# МедТехСервис

Приложение на Supabase: React SPA ходит напрямую в Auth, PostgREST и Storage.

```bash
npm install
cp .env.example .env
npm start
```

`npm start` и `npm run dev` поднимают UI на `http://127.0.0.1:5173`. Нужны `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`.

Схема лежит в одном файле `supabase/migrations/0001_init.sql`. Локальный стек Supabase (не на общей рабочей ВМ с запретом Docker):

```bash
npx supabase start
npx supabase db reset
```

Пользователи входят через GoTrue (`auth.users`); рабочий профиль и роли — `public.users` с тем же `id`. Файлы пишутся в bucket `medtech-files`. Доменные ограничения остаются в PostgreSQL (триггеры, RPC вроде `change_equipment_site` и `accept_task_closure`).
