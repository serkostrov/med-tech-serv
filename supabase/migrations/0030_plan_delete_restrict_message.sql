-- Понятный отказ при удалении периода ТО с задачей на PostgreSQL 18 и новее.
--
-- Что было не так. В 0026 отказ ловился как `WHEN foreign_key_violation`. Ограничение
-- task_maintenance_plan_equipment_fk объявлено как ON DELETE RESTRICT, и с PostgreSQL 18
-- такое нарушение приходит кодом restrict_violation (23001), а не foreign_key_violation
-- (23503): обработчик не срабатывал, и вместо «по периоду уже создана задача» пользователь
-- видел сырой текст ограничения. На стенде (PostgreSQL 17) этого не видно, но при обновлении
-- сервера сломалось бы молча, да и автотесты базы идут на PGlite с PostgreSQL 18.
--
-- 0026 не трогаем: она уже применена на стенде. Здесь только заново создаём функцию.
-- Расширять до integrity_constraint_violation нельзя: тогда этот же обработчик проглотит
-- нарушения уникальности и CHECK того же DELETE и сообщит о них неправду.

CREATE OR REPLACE FUNCTION public.replace_maintenance_plan(p_equipment_id uuid, p_year integer, p_periods jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  kept record;
BEGIN
  IF NOT public.app_has_any_permission(ARRAY['tasks.write', 'tasks.assign']) THEN
    RAISE EXCEPTION 'Недостаточно прав: план ТО меняет координатор' USING ERRCODE = '42501';
  END IF;
  IF p_year IS NULL THEN
    RAISE EXCEPTION 'Укажите год плана ТО' USING ERRCODE = '22004';
  END IF;
  IF jsonb_typeof(p_periods) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Периоды ТО передаются списком' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_periods) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'На прибор можно задать от 1 до 5 периодов ТО в год' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_periods) AS period
     WHERE jsonb_typeof(period) IS DISTINCT FROM 'object'
        OR coalesce(period ->> 'periodFrom', '') !~ '^\d{4}-\d{2}-\d{2}$'
        OR coalesce(period ->> 'periodTo', '') !~ '^\d{4}-\d{2}-\d{2}$'
        OR (nullif(period ->> 'assignedEngineerId', '') IS NOT NULL
            AND (period ->> 'assignedEngineerId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'Укажите даты начала и окончания каждого периода ТО' USING ERRCODE = '23514';
  END IF;
  -- Дата по формату верная, но такого дня нет (например, 30 февраля).
  BEGIN
    PERFORM (period ->> 'periodFrom')::date, (period ->> 'periodTo')::date FROM jsonb_array_elements(p_periods) AS period;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'В периоде ТО указан несуществующий день' USING ERRCODE = '22008';
  END;
  IF NOT EXISTS (SELECT 1 FROM public.equipment WHERE id = p_equipment_id) THEN
    RAISE EXCEPTION 'Прибор не найден' USING ERRCODE = 'P0002';
  END IF;
  -- Два одновременных сохранения плана прибора идут по очереди: второе не падает на номерах ТО.
  PERFORM pg_advisory_xact_lock(hashtextextended('maintenance_plan:' || p_equipment_id::text || ':' || p_year::text, 0));

  -- Период с задачей и закрытый период (не «Запланировано») остаются как есть: их даты должны
  -- прийти без изменений. Инженер и комментарий такого периода тоже не меняются: их меняют в задаче.
  FOR kept IN
    SELECT plan.period_from, plan.period_to, plan.status,
           EXISTS (SELECT 1 FROM public.tasks AS task WHERE task.maintenance_plan_id = plan.id) AS has_task
      FROM public.maintenance_plans AS plan
     WHERE plan.equipment_id = p_equipment_id AND plan.plan_year = p_year
       AND (plan.status <> 'planned' OR EXISTS (SELECT 1 FROM public.tasks AS task WHERE task.maintenance_plan_id = plan.id))
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_periods) AS period
       WHERE (period ->> 'periodFrom')::date = kept.period_from AND (period ->> 'periodTo')::date = kept.period_to
    ) THEN
      IF kept.has_task THEN
        RAISE EXCEPTION 'По периоду ТО % — % уже создана задача: период нельзя убрать или изменить, сроки переносите в самой задаче',
          to_char(kept.period_from, 'DD.MM.YYYY'), to_char(kept.period_to, 'DD.MM.YYYY')
          USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'Период ТО % — % закрыт (%): его нельзя убрать или изменить',
        to_char(kept.period_from, 'DD.MM.YYYY'), to_char(kept.period_to, 'DD.MM.YYYY'),
        CASE kept.status WHEN 'generated' THEN 'задача создана' WHEN 'completed' THEN 'выполнено' WHEN 'cancelled' THEN 'отменено' ELSE kept.status END
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- Свободный период, пришедший с теми же датами, остаётся той же строкой: меняются только
  -- инженер и комментарий. «Свободный» — по тому, что видит вызывающий: если задача периода
  -- ему не видна, а отметка «задача создана» не записалась, инженер и комментарий периода
  -- тоже поменяются (задачу это не затрагивает).
  UPDATE public.maintenance_plans AS plan
     SET assigned_engineer_id = incoming.engineer_id,
         comment = incoming.comment
    FROM (
      SELECT (period ->> 'periodFrom')::date AS period_from,
             (period ->> 'periodTo')::date AS period_to,
             nullif(period ->> 'assignedEngineerId', '')::uuid AS engineer_id,
             nullif(btrim(coalesce(period ->> 'comment', '')), '') AS comment
        FROM jsonb_array_elements(p_periods) AS period
    ) AS incoming
   WHERE plan.equipment_id = p_equipment_id AND plan.plan_year = p_year
     AND plan.status = 'planned'
     AND NOT EXISTS (SELECT 1 FROM public.tasks AS task WHERE task.maintenance_plan_id = plan.id)
     AND plan.period_from = incoming.period_from AND plan.period_to = incoming.period_to
     AND (plan.assigned_engineer_id IS DISTINCT FROM incoming.engineer_id OR plan.comment IS DISTINCT FROM incoming.comment);

  -- Свободные периоды, которых нет в списке, удаляются. Если по такому периоду есть задача,
  -- которую вызывающий не видит, удаление не пройдёт по внешнему ключу задачи.
  -- ON DELETE RESTRICT отдаёт restrict_violation (23001), а не foreign_key_violation (23503):
  -- ловим оба, иначе человеку прилетит текст ограничения вместо объяснения.
  BEGIN
    DELETE FROM public.maintenance_plans AS plan
     WHERE plan.equipment_id = p_equipment_id AND plan.plan_year = p_year
       AND plan.status = 'planned'
       AND NOT EXISTS (SELECT 1 FROM public.tasks AS task WHERE task.maintenance_plan_id = plan.id)
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_periods) AS period
          WHERE (period ->> 'periodFrom')::date = plan.period_from AND (period ->> 'periodTo')::date = plan.period_to
       );
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
    RAISE EXCEPTION 'По этому прибору уже созданы задачи из плана на % год: периоды с задачами нельзя изменить или удалить', p_year
      USING ERRCODE = '23503';
  END;

  -- Новые периоды — всё, что не совпало по датам с оставшимися. period_no — внутренний номер
  -- места (1..5): берутся свободные, по порядку дат; номер ТО на экране считается по датам.
  -- Пересечения, границы года и инженера проверяют ограничения и триггеры таблицы; любая
  -- ошибка откатывает всё выше.
  INSERT INTO public.maintenance_plans (
    equipment_id, plan_year, period_no, period_from, period_to, work_type_code, assigned_engineer_id, comment, created_by
  )
  SELECT p_equipment_id, p_year, slot.period_no, fresh.period_from, fresh.period_to, 'maintenance',
         fresh.engineer_id, fresh.comment, auth.uid()
    FROM (
      SELECT (period ->> 'periodFrom')::date AS period_from,
             (period ->> 'periodTo')::date AS period_to,
             nullif(period ->> 'assignedEngineerId', '')::uuid AS engineer_id,
             nullif(btrim(coalesce(period ->> 'comment', '')), '') AS comment,
             row_number() OVER (ORDER BY (period ->> 'periodFrom')::date, (period ->> 'periodTo')::date) AS position
        FROM jsonb_array_elements(p_periods) AS period
       WHERE NOT EXISTS (
         SELECT 1 FROM public.maintenance_plans AS rest
          WHERE rest.equipment_id = p_equipment_id AND rest.plan_year = p_year
            AND rest.period_from = (period ->> 'periodFrom')::date
            AND rest.period_to = (period ->> 'periodTo')::date
       )
    ) AS fresh
    JOIN (
      SELECT number AS period_no, row_number() OVER (ORDER BY number) AS position
        FROM generate_series(1, 5) AS number
       WHERE number NOT IN (
         SELECT rest.period_no FROM public.maintenance_plans AS rest
          WHERE rest.equipment_id = p_equipment_id AND rest.plan_year = p_year
       )
    ) AS slot USING (position);

  -- Каждый присланный период должен оказаться в плане ровно один раз (повторы не теряются молча).
  IF (SELECT count(*) FROM public.maintenance_plans WHERE equipment_id = p_equipment_id AND plan_year = p_year)
     <> jsonb_array_length(p_periods) THEN
    RAISE EXCEPTION 'Периоды ТО одного годового плана не должны повторяться' USING ERRCODE = '23514';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.replace_maintenance_plan(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_maintenance_plan(uuid, integer, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
