-- Встреча 18.11.2026: «на странице прибора — запчасти, которые к нему подходят, на странице
-- запчасти — к каким приборам она подходит». До сих пор связь была видна только из того,
-- что реально ставили по задачам. Теперь склад отмечает её сам: запчасть подходит к модели
-- прибора (например, лампа — к Beckman Coulter AU 480 и AU 680). Новая запчасть без истории
-- установок тоже найдётся в карточке прибора.
--
-- Видят связь все, кому виден склад или приборы (инженеру в карточке прибора полезно знать,
-- какие запчасти подходят), меняет — тот, кто ведёт склад (warehouse.write).
-- Миграция повторяемая.

CREATE TABLE IF NOT EXISTS public.part_equipment_models (
  part_id uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.equipment_models(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (part_id, model_id)
);

CREATE INDEX IF NOT EXISTS part_equipment_models_model_idx ON public.part_equipment_models (model_id);

COMMENT ON TABLE public.part_equipment_models IS
  'Запчасть подходит к модели прибора (0073): видно на странице запчасти и в карточке прибора';

ALTER TABLE public.part_equipment_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS part_equipment_models_read ON public.part_equipment_models;
CREATE POLICY part_equipment_models_read ON public.part_equipment_models FOR SELECT TO authenticated
  USING ((SELECT public.app_has_any_permission(ARRAY['warehouse.read', 'warehouse.write', 'equipment.read', 'tasks.read_all'])));

DROP POLICY IF EXISTS part_equipment_models_insert ON public.part_equipment_models;
CREATE POLICY part_equipment_models_insert ON public.part_equipment_models FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.app_has_permission('warehouse.write')));

DROP POLICY IF EXISTS part_equipment_models_delete ON public.part_equipment_models;
CREATE POLICY part_equipment_models_delete ON public.part_equipment_models FOR DELETE TO authenticated
  USING ((SELECT public.app_has_permission('warehouse.write')));

REVOKE ALL ON TABLE public.part_equipment_models FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.part_equipment_models TO authenticated;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['medtech_api', 'medtech_backup'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT ON TABLE public.part_equipment_models TO %I', r);
    END IF;
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
