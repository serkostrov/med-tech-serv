-- Порядок карточек на доске задач, как в Trello: карточку можно поставить выше или ниже
-- другой, наверх или вниз колонки, и этот порядок видят все.
--
-- Порядок хранится отдельно от задачи. Перестановка не меняет саму задачу: не сдвигает
-- дату изменения, не пишет журнал и не запускает проверки задачи. Переставить карточку
-- может тот, кто может менять задачу (те же правила, что для акта и фото).
--
-- Место действует только в том этапе (колонке), где его задали. Если задача перешла
-- в другой этап из карточки, а не перетаскиванием, в новой колонке она встаёт после
-- расставленных вручную, по обычной сортировке доски.

CREATE TABLE IF NOT EXISTS public.task_board_positions (
  task_id uuid PRIMARY KEY REFERENCES public.tasks(id) ON DELETE CASCADE,
  status_code text NOT NULL,
  -- Дробное число: карточку между двумя другими ставим посередине, соседей не трогаем.
  position double precision NOT NULL
    CHECK (position > '-Infinity'::double precision AND position < 'Infinity'::double precision)
);

ALTER TABLE public.task_board_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_read ON public.task_board_positions;
DROP POLICY IF EXISTS role_insert ON public.task_board_positions;
DROP POLICY IF EXISTS role_update ON public.task_board_positions;
DROP POLICY IF EXISTS role_delete ON public.task_board_positions;
CREATE POLICY role_read ON public.task_board_positions FOR SELECT TO authenticated
  USING (public.app_can_read_task(task_id));
CREATE POLICY role_insert ON public.task_board_positions FOR INSERT TO authenticated
  WITH CHECK (public.app_can_write_task(task_id));
CREATE POLICY role_update ON public.task_board_positions FOR UPDATE TO authenticated
  USING (public.app_can_write_task(task_id))
  WITH CHECK (public.app_can_write_task(task_id));
CREATE POLICY role_delete ON public.task_board_positions FOR DELETE TO authenticated
  USING (public.app_can_write_task(task_id));

REVOKE ALL ON TABLE public.task_board_positions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.task_board_positions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.task_board_positions TO medtech_api;
GRANT SELECT ON TABLE public.task_board_positions TO medtech_backup;

-- Место задачи для сортировки доски. PostgREST сортирует по нему как по полю задачи:
-- order=board_position.asc.nullslast. Место, заданное в другом этапе, не считается.
-- Функция работает с правами вызывающего, под правилами строк таблицы выше.
CREATE OR REPLACE FUNCTION public.board_position(p_task public.tasks)
RETURNS double precision
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p.position
    FROM public.task_board_positions AS p
   WHERE p.task_id = p_task.id AND p.status_code = p_task.status_code
$$;

REVOKE ALL ON FUNCTION public.board_position(public.tasks) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.board_position(public.tasks) TO authenticated;
GRANT EXECUTE ON FUNCTION public.board_position(public.tasks) TO medtech_api;

-- PostgREST должен увидеть новую таблицу и поле сразу, без перезапуска.
NOTIFY pgrst, 'reload schema';
