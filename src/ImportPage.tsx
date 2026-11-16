import React, { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { m2Api } from "./m2-api.js";
import {
  Button,
  ConfirmationDialog,
  DataTableShell,
  Icon,
  MetricCard,
  PageIntro,
  ResourceState,
  Select,
  StatusBadge,
  toast,
  type StatusTone
} from "./ui.js";
import { formatRussianCount } from "./equipment-changes.js";
import {
  buildImportPlan,
  issueSeverity,
  type ImportPlan,
  type ImportReading,
  type ImportSnapshot,
  type ImportWriteResult,
  readImportFile
} from "./import-1c.js";

/**
 * Экран «Импорт»: человек загружает выгрузку 1С, видит пробный импорт и только
 * потом подтверждает запись. До подтверждения база не меняется: разбор файла и
 * сверка идут в браузере, запись — одной транзакцией (функция 0054).
 */

const ROWS = ["строка", "строки", "строк"] as const;
/** Замечаний на плохом файле бывают тысячи: столько в таблице, остальные числом. */
const MAX_SHOWN_ISSUES = 200;
const DEVICES = ["прибор", "прибора", "приборов"] as const;
const EVENTS = ["событие", "события", "событий"] as const;

function message(error: unknown, fallback: string): string {
  // У отказа распаковщика браузера текст бывает пустым: тогда говорим своими словами.
  return error instanceof Error && error.message ? error.message : fallback;
}

const ACTION_LABELS: Readonly<Record<ImportPlan["equipment"][number]["action"], string>> = {
  create: "Создадим",
  exists: "Уже в реестре",
  blocked: "Не хватает данных"
};

const ACTION_TONES: Readonly<Record<ImportPlan["equipment"][number]["action"], StatusTone>> = {
  create: "success",
  exists: "info",
  blocked: "danger"
};

/** Что импорт берёт из какого столбца: показываем, чтобы человек проверил сам. */
const COLUMN_LABELS: Readonly<Record<string, string>> = {
  device: "Прибор",
  serial: "Серийный номер",
  date: "Дата",
  client: "Клиент",
  workType: "Вид работ",
  description: "Описание работ",
  manufacturer: "Производитель",
  model: "Модель",
  site: "Площадка",
  payer: "Плательщик",
  notes: "Примечание",
  meter: "Показание счётчика"
};

export function ImportPage() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [canWrite, setCanWrite] = useState<boolean | undefined>(undefined);
  const [canWriteReferences, setCanWriteReferences] = useState(true);
  const [fileName, setFileName] = useState("");
  const [reading, setReading] = useState<ImportReading | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<ImportSnapshot | undefined>(undefined);
  const [manufacturer, setManufacturer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [written, setWritten] = useState<ImportWriteResult | undefined>(undefined);

  useEffect(() => {
    void m2Api.hasPermission("equipment.write").then(setCanWrite).catch(() => setCanWrite(false));
    void m2Api.hasPermission("references.write").then(setCanWriteReferences).catch(() => setCanWriteReferences(true));
  }, []);

  const plan = useMemo(
    () => reading && snapshot
      ? buildImportPlan(reading, snapshot, manufacturer ? { defaultManufacturer: manufacturer } : {})
      : undefined,
    [reading, snapshot, manufacturer]
  );
  // Тот же разбор без выбора производителя: по нему видно, нужен ли выбор вообще.
  // Иначе селектор исчезал бы сразу после выбора и снять его было бы нечем.
  const planWithoutChoice = useMemo(
    () => reading && snapshot ? buildImportPlan(reading, snapshot) : undefined,
    [reading, snapshot]
  );

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setWritten(undefined);
    setReading(undefined);
    setSnapshot(undefined);
    setManufacturer("");
    setFileName(file.name);
    try {
      if (/\.(xls|csv|ods)$/iu.test(file.name)) {
        throw new Error("Нужен файл .xlsx. Откройте выгрузку в Excel и сохраните как «Книга Excel (.xlsx)»");
      }
      const parsed = await readImportFile(new Uint8Array(await file.arrayBuffer()));
      // Сверяем с базой только по приборам из файла: весь реестр читать не нужно.
      const base = await m2Api.importSnapshot(parsed.equipment.map((item) => item.serialNumber));
      setReading(parsed);
      setSnapshot(base);
    } catch (readError) {
      setError(message(readError, "Файл не удалось прочитать"));
      setFileName("");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const apply = async () => {
    if (!plan) return;
    const result = await m2Api.applyEquipmentImport(fileName.slice(0, 200), plan.write);
    setWritten(result);
    // Снимок устарел: перечитываем, чтобы повторное подтверждение показало «уже есть».
    if (reading) {
      try {
        setSnapshot(await m2Api.importSnapshot(reading.equipment.map((item) => item.serialNumber)));
      } catch {
        // Пробный импорт перечитаем при следующей загрузке файла: запись уже прошла.
      }
    }
    toast.success(
      `${formatRussianCount(result.equipmentCreated, DEVICES)} и ${formatRussianCount(result.eventsCreated, EVENTS)}`,
      { title: "Импорт записан" }
    );
  };

  if (canWrite === undefined) {
    return <ResourceState description="Проверяем, можно ли вам заводить приборы." status="loading" title="Открываем импорт" />;
  }
  if (!canWrite) {
    return <ResourceState
      description="Переносить данные в реестр может тот, кто заводит приборы: координатор, руководитель или администратор."
      icon="shield"
      status="empty"
      title="Импорт вам не доступен"
    />;
  }

  const summary = plan?.summary;
  const needsManufacturer = planWithoutChoice?.issues.some(
    (issue) => issue.code === "model_not_in_catalog" || issue.code === "model_ambiguous"
  ) === true;
  const sheetIssues = plan?.issues.filter((issue) => issue.row === 0) ?? [];
  const blockingSheetIssue = sheetIssues.find(
    (issue) => issue.code === "layout_unknown" || issue.code === "sheet_empty"
  );
  const overLimit = sheetIssues.some((issue) => issue.code === "too_many_rows");
  const shownIssues = plan?.issues.slice(0, MAX_SHOWN_ISSUES) ?? [];
  const writeCount = (plan?.write.equipment.length ?? 0) + (plan?.write.events.length ?? 0);
  // Новая модель или производитель — это запись в справочник, и база спросит своё право.
  const needsReferences = (plan?.summary.modelsCreate ?? 0) + (plan?.summary.manufacturersCreate ?? 0) > 0;
  const referencesRefusal = needsReferences && !canWriteReferences;

  return (
    <>
      <PageIntro
        actions={<label className="button button--primary import-file-button">
          <Icon name="handoff" />
          <span>{fileName ? "Выбрать другой файл" : "Выбрать файл .xlsx"}</span>
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="Файл выгрузки .xlsx"
            className="sr-only"
            disabled={busy}
            onChange={(event) => void chooseFile(event)}
            ref={fileRef}
            type="file"
          />
        </label>}
        description="Пробный импорт показывает, что появится в базе. Записывается только после подтверждения."
        eyebrow="Перенос данных"
        title="Импорт приборов и истории"
      />

      {busy ? <ResourceState description="Читаем файл и сверяем его с реестром." status="loading" title="Считаем пробный импорт" /> : null}
      {error ? <ResourceState description={error} onRetry={() => fileRef.current?.click()} status="error" title="Файл не прочитан" /> : null}

      {!busy && !error && !plan ? <ResourceState
        description="Подойдёт выгрузка «история прибора» (строка с названием и S/N, под ней события) или таблица приборов с заголовком «Серийный номер» и «Модель»."
        icon="handoff"
        status="empty"
        title="Выберите файл выгрузки"
      /> : null}

      {blockingSheetIssue ? <ResourceState
        description={`${blockingSheetIssue.problem}. ${blockingSheetIssue.fix}`}
        icon="info"
        status="empty"
        title="Файл не разобран"
      /> : null}

      {plan && summary && !blockingSheetIssue ? <>
        <div className="metric-grid metric-grid--four">
          <MetricCard
            detail={`Лист «${plan.sheet}», служебных строк ${summary.serviceRows}`}
            icon="tasks"
            label="Строк с данными"
            tone="blue"
            value={String(summary.dataRows)}
          />
          <MetricCard
            detail={`События: ${summary.eventsCreate} новых, ${summary.eventsExisting} уже есть`}
            icon="equipment"
            label="Приборы в файле"
            tone="purple"
            value={String(plan.equipment.length)}
          />
          <MetricCard
            detail={summary.errorRows === 0 ? "Все строки читаются" : "Эти строки перенесены не будут"}
            icon="info"
            label="Строк с ошибками"
            tone={summary.errorRows === 0 ? "green" : "red"}
            value={String(summary.errorRows)}
          />
          <MetricCard
            detail={summary.warningRows === 0 ? "Оговорок нет" : "Перенесём, но прочитайте замечания"}
            icon="notifications"
            label="Предупреждений"
            tone={summary.warningRows === 0 ? "green" : "yellow"}
            value={String(summary.warningRows)}
          />
        </div>

        <section className="card import-plan">
          <h2>Что изменится в базе</h2>
          <ul className="import-plan__list">
            <li>Новых приборов: <b>{summary.equipmentCreate}</b>. Уже в реестре: {summary.equipmentExists}.</li>
            <li>Новых событий истории: <b>{summary.eventsCreate}</b>. Уже записано раньше: {summary.eventsExisting}.</li>
            <li>Пополним справочник: производителей {summary.manufacturersCreate}, моделей {summary.modelsCreate}.</li>
            {summary.equipmentBlocked > 0
              ? <li>Ждут решения: {formatRussianCount(summary.equipmentBlocked, DEVICES)} и {formatRussianCount(summary.eventsBlocked, EVENTS)}.</li>
              : null}
            <li className="muted">Данные приборов, которые уже есть в реестре, импорт не переписывает.</li>
          </ul>
          <p className="muted">
            Столбцы файла: {Object.entries(plan.columns)
              .map(([role, letter]) => `${COLUMN_LABELS[role] ?? role} — ${letter}`)
              .join(", ") || "не распознаны"}
          </p>
          {needsManufacturer ? <label className="import-plan__manufacturer">
            Производитель для моделей, которых нет в справочнике
            <Select
              onChange={(event) => { setManufacturer(event.target.value); setWritten(undefined); }}
              value={manufacturer}
            >
              <option value="">Не выбран: такие приборы перенесены не будут</option>
              {(snapshot?.manufacturers ?? []).filter((item) => item.isActive)
                .map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </Select>
            <span className="form-hint">
              {plan.layout === "history-blocks"
                ? "В выгрузке «история прибора» производителя нет. Выберите его, и модель заведётся в справочнике."
                : "В файле производитель не указан или модель есть у нескольких. Выберите производителя, и модель заведётся в справочнике."}
            </span>
          </label> : null}
          <div className="import-plan__actions">
            <Button
              disabled={writeCount === 0 || busy || referencesRefusal || overLimit}
              icon="check"
              onClick={() => setConfirming(true)}
            >
              {writeCount === 0
                ? "Записывать нечего"
                : `Записать ${formatRussianCount(plan.write.equipment.length, DEVICES)} и ${formatRussianCount(plan.write.events.length, EVENTS)}`}
            </Button>
            {overLimit ? <span className="import-plan__done">
              Файл слишком большой для одной записи: разделите выгрузку на части
            </span> : null}
            {referencesRefusal ? <span className="import-plan__done">
              Импорт заведёт новую модель в справочнике, а на это у вас нет прав: попросите добавить модель того, кто ведёт справочники
            </span> : null}
            {written ? <span className="import-plan__done">
              Записано: {formatRussianCount(written.equipmentCreated, DEVICES)}, {formatRussianCount(written.eventsCreated, EVENTS)}
              {written.eventsWithoutEquipment > 0
                ? `; без прибора в базе осталось ${written.eventsWithoutEquipment}`
                : ""}
            </span> : null}
          </div>
        </section>

        {plan.issues.length > 0 ? <DataTableShell
          meta={formatRussianCount(plan.issues.length, ["замечание", "замечания", "замечаний"])}
          title="Что не так в строках файла"
        >
          <div className="table-scroll"><table className="data-table">
            <thead><tr>
              <th scope="col">Строка</th>
              <th scope="col">Что не так</th>
              <th scope="col">Что делать</th>
            </tr></thead>
            <tbody>
              {shownIssues.map((issue, index) => <tr key={`${issue.row}-${issue.code}-${index}`}>
                <td>
                  <StatusBadge tone={issueSeverity(issue.code) === "error" ? "danger" : "warning"}>
                    {issue.row > 0 ? `${issue.row}${issue.column ? ` · ${issue.column}` : ""}` : "Весь лист"}
                  </StatusBadge>
                </td>
                <td>{issue.problem}</td>
                <td className="muted">{issue.fix}</td>
              </tr>)}
            </tbody>
          </table></div>
          {plan.issues.length > shownIssues.length ? <p className="muted import-plan__done">
            Показаны первые {shownIssues.length}; всего {formatRussianCount(plan.issues.length, ["замечание", "замечания", "замечаний"])}
          </p> : null}
        </DataTableShell> : null}

        {plan.equipment.length > 0 ? <DataTableShell
          meta={formatRussianCount(plan.equipment.length, DEVICES)}
          title="Приборы из файла"
        >
          <div className="table-scroll"><table className="data-table">
            <thead><tr>
              <th scope="col">Строка</th>
              <th scope="col">Серийный номер</th>
              <th scope="col">Модель</th>
              <th scope="col">Производитель</th>
              <th scope="col">Что будет</th>
              <th scope="col">История</th>
            </tr></thead>
            <tbody>
              {plan.equipment.map((item) => <tr key={item.serialKey}>
                <td>{item.row}</td>
                <td>{item.serialNumber}</td>
                <td>{item.modelName}{item.modelAction === "create" ? <span className="muted"> · заведём в справочнике</span> : null}</td>
                <td>{item.manufacturerName || <span className="muted">не определён</span>}</td>
                <td>
                  <StatusBadge tone={ACTION_TONES[item.action]}>{ACTION_LABELS[item.action]}</StatusBadge>
                  {item.differences.map((difference) => <div className="muted" key={difference.field}>
                    {difference.field}: в файле «{difference.inFile}», в базе «{difference.inBase}» — оставим как в базе
                  </div>)}
                </td>
                <td>
                  {item.action === "blocked"
                    ? `${formatRussianCount(item.eventsBlocked, EVENTS)} ждут`
                    : `+${item.eventsCreate}${item.eventsExisting > 0 ? ` · уже ${item.eventsExisting}` : ""}`}
                </td>
              </tr>)}
            </tbody>
          </table></div>
        </DataTableShell> : null}
      </> : null}

      <ConfirmationDialog
        confirmLabel="Записать"
        description={plan
          ? <>
            В базу уйдёт {formatRussianCount(plan.write.equipment.length, DEVICES)} и {formatRussianCount(plan.write.events.length, EVENTS)} из файла «{fileName}».
            {plan.summary.errorRows > 0
              ? ` ${formatRussianCount(plan.summary.errorRows, ROWS)} с ошибками останутся непере­несёнными.`
              : ""}
            {" "}Повторная загрузка того же файла ничего не удвоит.
          </>
          : ""}
        onConfirm={apply}
        onOpenChange={setConfirming}
        open={confirming}
        title="Записать импорт в базу?"
        tone="primary"
      />
    </>
  );
}
