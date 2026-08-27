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

## Деплой на Dokploy

### Application

- **Build Type:** `Dockerfile`
- **Dockerfile path:** `Dockerfile`
- **Docker context:** `.`
- **Port:** `80`

### Environment (runtime)

Dokploy **не** передаёт обычный Environment в Docker `ARG` при сборке (в логах было `[ -z "" ]`).  
Поэтому переменные читаются **при старте контейнера** и вшиваются в `index.html`. Отдельного `/config.js` нет (404).

В **Environment** приложения задайте:

| Имя | Значение |
|---|---|
| `VITE_SUPABASE_URL` | URL Supabase |
| `VITE_SUPABASE_ANON_KEY` | anon key |

После смены env достаточно Redeploy/Restart.

### После деплоя

1. Supabase Auth → Site URL / Redirect URLs = домен фронта.
2. Применить миграции к production-БД.

### Локальная проверка

```bash
docker build -t medtechservice-web .
docker run --rm -p 8080:80 \
  -e VITE_SUPABASE_URL="https://your-supabase.example" \
  -e VITE_SUPABASE_ANON_KEY="your-anon-key" \
  medtechservice-web
```
