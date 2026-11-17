#!/usr/bin/env bash
# Ночной бэкап МедТехСервиса и проверка восстановления (ТЗ 6.2).
#
# Запускается на сервере по расписанию Dokploy (Schedules, 00:00 UTC = 03:00 Москвы).
# 1. Копия базы: pg_dump из контейнера базы Supabase.
# 2. Копия файлов: каталог хранилища Supabase (фото актов, вложения).
# 3. Проверка восстановления: копия базы разворачивается во временную базу restore_check
#    в том же контейнере, и число строк в главных таблицах сверяется с рабочей базой.
#    Не сошлось — скрипт падает, и Dokploy показывает ошибку в журнале расписания.
# 4. Копии старше 14 дней удаляются.
#
# Расписание Dokploy выполняется внутри контейнера Dokploy: его собственный /root пропадает
# при обновлении. Каталог /etc/dokploy подключён к контейнеру с самого сервера, поэтому копии
# лежат в /etc/dokploy/medtech-backups и переживают перезапуск.
# Копии лежат на этом же сервере. От потери сервера они не спасают: для этого нужна копия
# в другом месте — S3 или сервер заказчика, когда он появится.
set -euo pipefail

DIR=/etc/dokploy/medtech-backups
# Первый запуск 17.11 положил копии в /root контейнера Dokploy — переносить их не нужно.
rm -rf /root/medtech-backups
KEEP_DAYS=14
STAMP=$(date -u +%Y-%m-%d_%H%M)
mkdir -p "$DIR"
chmod 700 "$DIR"

DB=$(docker ps --format '{{.Names}}' | grep -E '^medtechservice-supabase-.*-db-1$' | head -1)
STORAGE=$(docker ps --format '{{.Names}}' | grep -E '^medtechservice-supabase-.*-storage-1$' | head -1)
[ -n "$DB" ] || { echo "Контейнер базы не найден"; exit 1; }

echo "1. Копия базы из $DB"
docker exec "$DB" pg_dump -U postgres -d postgres -Fc > "$DIR/db-$STAMP.dump"
echo "   $(du -h "$DIR/db-$STAMP.dump" | cut -f1)"

if [ -n "$STORAGE" ]; then
  FILES=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/storage"}}{{.Source}}{{end}}{{end}}' "$STORAGE")
  if [ -n "$FILES" ] && [ -d "$FILES" ]; then
    echo "2. Копия файлов из $FILES"
    tar -czf "$DIR/files-$STAMP.tgz" -C "$FILES" .
    echo "   $(du -h "$DIR/files-$STAMP.tgz" | cut -f1)"
  else
    echo "2. Каталог файлов хранилища не найден — файлы не скопированы"
  fi
else
  echo "2. Контейнер хранилища не найден — файлы не скопированы"
fi

echo "3. Проверка восстановления"
docker exec "$DB" psql -U postgres -q -c "DROP DATABASE IF EXISTS restore_check" -c "CREATE DATABASE restore_check"
# Триггеры при разворачивании выключены: данные кладутся как есть, без очередей писем.
# Служебные схемы Supabase (расширения, хранилище ключей) могут дать предупреждения:
# их не считаем ошибкой, решает сверка данных ниже.
docker exec -i "$DB" pg_restore -U postgres -d restore_check --no-owner --no-privileges --disable-triggers < "$DIR/db-$STAMP.dump" > /dev/null 2>&1 || true
COUNTS="select (select count(*) from public.tasks) || '/' || (select count(*) from public.equipment) || '/' || (select count(*) from public.users) || '/' || (select count(*) from public.stock_movements) || '/' || (select count(*) from public.invoices)"
LIVE=$(docker exec "$DB" psql -U postgres -d postgres -Atc "$COUNTS")
COPY=$(docker exec "$DB" psql -U postgres -d restore_check -Atc "$COUNTS" 2>/dev/null || echo "не развернулась")
docker exec "$DB" psql -U postgres -q -c "DROP DATABASE IF EXISTS restore_check"
echo "$(date -u +%FT%TZ) задачи/приборы/сотрудники/движения/счета: база $LIVE, копия $COPY" | tee -a "$DIR/restore-check.log"

echo "4. Убираем копии старше $KEEP_DAYS дней"
find "$DIR" -maxdepth 1 \( -name 'db-*.dump' -o -name 'files-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
ls -lh "$DIR" | tail -n +2
df -h "$DIR" | tail -1

if [ "$LIVE" != "$COPY" ]; then
  echo "ВОССТАНОВЛЕНИЕ НЕ СОШЛОСЬ: копия базы отличается от рабочей"
  exit 1
fi
echo "Готово: копия развернулась и совпала с рабочей базой"
