import React, { useEffect, useState } from "react";
import { m2Api } from "./m2-api.js";
import { MultiSelect } from "./MultiSelect.js";
import { EntityLink, type EntityTarget } from "./entity-links.js";
import { filterValues, joinFilterValues } from "./filter-values.js";
import {
  FilterBar,
  Notice,
  PageIntro,
  PageTabs,
  ResourceState,
  StatusBadge,
  Select,
  DatePicker,
  toast
} from "./ui.js";
import { RegistryPagination, registryPageOffset, usePageSize } from "./RegistryPagination.js";
import { formatDisplayDate } from "./date-format.js";
import {
  auditActionLabel,
  auditActorLabel,
  auditChangeLines,
  canReadLoginJournal,
  auditEntityTitle,
  auditChangeSummary,
  auditEntityLabel,
  auditPlaceLabel,
  loginOutcomeText,
  loginWhoHint,
  loginWhoText,
  type AuditJournalEvent,
  type LoginJournalEntry
} from "./audit-journal.js";

/** Объекты, по которым пишется журнал: контуры сущностей из audit_entity_type_for_table. */
const ENTITY_FILTER_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "task", label: "Задачи" },
  { value: "equipment", label: "Приборы" },
  { value: "invoice", label: "Счета" },
  { value: "warehouse", label: "Склад" },
  { value: "reference", label: "Справочники" },
  { value: "user", label: "Сотрудники и права" },
  { value: "integration", label: "Уведомления и обмен" }
];

interface JournalPerson {
  readonly id: string;
  readonly fullName: string;
}

const EMPTY_CHANGE_FILTERS = { actorId: "", entityType: "", search: "", from: "", to: "" };
const EMPTY_LOGIN_FILTERS = { userId: "", outcome: "", search: "", from: "", to: "" };

/** Кто и когда: общая первая пара столбцов обоих журналов. */
function whenText(value: string): string {
  return formatDisplayDate(value, true) || value;
}

/**
 * Журнал изменений. С entityType — только этот объект и без фильтра «Объект»: так устроена вкладка
 * «Доступ и права» (встреча 19.11): новые сотрудники, их роли и отключение, роли и галочки прав (0076).
 */
function ChangesJournal({ people, entityType }: { readonly people: readonly JournalPerson[]; readonly entityType?: string }) {
  const initialFilters = entityType ? { ...EMPTY_CHANGE_FILTERS, entityType } : EMPTY_CHANGE_FILTERS;
  const { pageSize, pageSizeRef, setPageSize } = usePageSize("audit-journal");
  const [items, setItems] = useState<readonly AuditJournalEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [filters, setFilters] = useState(initialFilters);
  const [openId, setOpenId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = async (current = filters, targetPageIndex = pageIndex) => {
    setLoading(true);
    try {
      const page = await m2Api.auditJournal({
        ...(current.actorId ? { actorId: current.actorId } : {}),
        ...(current.entityType ? { entityType: current.entityType } : {}),
        ...(current.search.trim() ? { search: current.search.trim() } : {}),
        ...(current.from ? { from: current.from } : {}),
        ...(current.to ? { to: current.to } : {}),
        limit: pageSizeRef.current,
        offset: registryPageOffset(targetPageIndex, pageSizeRef.current)
      });
      setItems(page.items);
      setTotal(page.total);
      setError(null);
    } catch (loadError) {
      const text = loadError instanceof Error ? loadError.message : "Не получилось загрузить журнал изменений";
      setError(text);
      toast.error(text);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);
  const changePage = (nextPageIndex: number) => {
    setPageIndex(nextPageIndex);
    void reload(filters, nextPageIndex);
  };
  const filtered = Boolean(filters.actorId || (filters.entityType && !entityType) || filters.search.trim() || filters.from || filters.to);
  const change = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const moneyHidden = items.some((event) => event.moneyHidden);
  return <>
    <FilterBar
      loading={loading}
      onReset={() => { setFilters(initialFilters); setPageIndex(0); void reload(initialFilters, 0); }}
      onSubmit={() => { setPageIndex(0); return reload(filters, 0); }}
    >
      <label className="filter-field--search">Поиск<input onChange={(event) => change("search", event.target.value)} placeholder="Номер объекта, действие или автор" type="search" value={filters.search} /></label>
      <MultiSelect emptyLabel="Все сотрудники" label="Кто изменил" onChange={(next) => change("actorId", joinFilterValues(next))} options={people.map((person) => ({ value: person.id, label: person.fullName }))} searchPlaceholder="Фамилия" value={filterValues(filters.actorId)} />
      {entityType ? null : <MultiSelect emptyLabel="Все объекты" label="Объект" onChange={(next) => change("entityType", joinFilterValues(next))} options={ENTITY_FILTER_OPTIONS} value={filterValues(filters.entityType)} />}
      <label>С<DatePicker aria-label="Изменения с даты" onChange={(value) => change("from", value)} value={filters.from} /></label>
      <label>По<DatePicker aria-label="Изменения по дату" onChange={(value) => change("to", value)} value={filters.to} /></label>
    </FilterBar>
    {moneyHidden ? <Notice tone="warning">В событиях счетов показаны не все поля: денежные значения открывает право «Просмотр финансов».</Notice> : null}
    <section className="card card--table" aria-label="Журнал изменений">
      {loading && items.length === 0
        ? <ResourceState description="Подождите, события сейчас появятся." status="loading" title="Загружаем журнал" />
        : error
          ? <ResourceState description={error} status="error" title="Журнал не загрузился" />
          : items.length === 0
            ? <ResourceState
              description={filtered ? "Измените условия или сбросьте фильтры." : "Как только в системе что-то изменят, событие появится здесь."}
              status={filtered ? "filtered-empty" : "empty"}
              title={filtered ? "Событий по этим условиям нет" : "Событий пока нет"} />
            : <div className="table-scroll table-cards"><table className="data-table journal-table">
              <thead><tr>
                <th scope="col">Когда</th>
                <th scope="col">Кто</th>
                <th scope="col">Что сделал</th>
                <th scope="col">Где</th>
                <th scope="col">Что изменилось</th>
              </tr></thead>
              <tbody>
                {items.map((event) => {
                  const open = openId === event.id;
                  const lines = auditChangeLines(event);
                  return <React.Fragment key={event.id}>
                    <tr className="data-table__selectable" onClick={() => setOpenId(open ? null : event.id)}>
                      <td className="journal-table__when" data-label="Когда">{whenText(event.occurredAt)}</td>
                      <td data-label="Кто">{auditActorLabel(event)}</td>
                      <td data-label="Что сделал">
                        <button aria-controls={`journal-event-${event.id}`} aria-expanded={open} className="journal-table__toggle" onClick={(clickEvent) => { clickEvent.stopPropagation(); setOpenId(open ? null : event.id); }} type="button">
                          <strong>{auditActionLabel(event.action)}</strong>
                        </button>
                        <small>{auditEntityLabel(event.entityType)}{event.outcome === "denied" ? " · отказано" : ""}</small>
                      </td>
                      <td data-label="Где">{auditPlaceLabel(event)}{auditEntityTitle(event) ? <small>{auditEntityLink(event) ? <EntityLink target={auditEntityLink(event)}>{auditEntityTitle(event)}</EntityLink> : auditEntityTitle(event)}</small> : null}</td>
                      <td className="cell-wide" data-label="Что изменилось">{auditChangeSummary(event) || "—"}</td>
                    </tr>
                    {open ? <tr className="journal-table__detail" id={`journal-event-${event.id}`}><td colSpan={5}>
                      {lines.length === 0
                        ? <p className="journal-table__empty">В событии нет полей для сравнения: записано только само действие.</p>
                        : <table className="data-table journal-diff">
                          <thead><tr><th scope="col">Поле</th><th scope="col">Было</th><th scope="col">Стало</th></tr></thead>
                          <tbody>{lines.map((line) => <tr key={line.field}><td>{line.label}</td><td>{line.before}</td><td>{line.after}</td></tr>)}</tbody>
                        </table>}
                      {event.moneyHidden ? <p className="journal-table__empty">Денежные поля этого события скрыты: нужно право «Просмотр финансов».</p> : null}
                      {event.ipAddress ? <p className="journal-table__empty">Адрес обращения: {event.ipAddress}</p> : null}
                    </td></tr> : null}
                  </React.Fragment>;
                })}
              </tbody>
            </table></div>}
      <RegistryPagination ariaLabel="Страницы журнала изменений" alwaysShow onPageChange={changePage} onPageSizeChange={(size) => { setPageSize(size); changePage(0); }} pageIndex={pageIndex} pageSize={pageSize} total={total} />
    </section>
  </>;
}

function LoginsJournal({ people }: { readonly people: readonly JournalPerson[] }) {
  const { pageSize, pageSizeRef, setPageSize } = usePageSize("login-journal");
  const [items, setItems] = useState<readonly LoginJournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [filters, setFilters] = useState(EMPTY_LOGIN_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successSourceAvailable, setSuccessSourceAvailable] = useState(true);
  const reload = async (current = filters, targetPageIndex = pageIndex) => {
    setLoading(true);
    try {
      const page = await m2Api.loginJournal({
        ...(current.userId ? { userId: current.userId } : {}),
        ...(current.outcome === "success" || current.outcome === "failure" ? { outcome: current.outcome } : {}),
        ...(current.search.trim() ? { search: current.search.trim() } : {}),
        ...(current.from ? { from: current.from } : {}),
        ...(current.to ? { to: current.to } : {}),
        limit: pageSizeRef.current,
        offset: registryPageOffset(targetPageIndex, pageSizeRef.current)
      });
      setItems(page.items);
      setTotal(page.total);
      setSuccessSourceAvailable(page.successSourceAvailable);
      setError(null);
    } catch (loadError) {
      const text = loadError instanceof Error ? loadError.message : "Не получилось загрузить журнал входов";
      setError(text);
      toast.error(text);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);
  const changePage = (nextPageIndex: number) => {
    setPageIndex(nextPageIndex);
    void reload(filters, nextPageIndex);
  };
  const filtered = Boolean(filters.userId || filters.outcome || filters.search.trim() || filters.from || filters.to);
  const change = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  return <>
    <FilterBar
      loading={loading}
      onReset={() => { setFilters(EMPTY_LOGIN_FILTERS); setPageIndex(0); void reload(EMPTY_LOGIN_FILTERS, 0); }}
      onSubmit={() => { setPageIndex(0); return reload(filters, 0); }}
    >
      <label className="filter-field--search">Поиск<input onChange={(event) => change("search", event.target.value)} placeholder="E-mail, имя или адрес" type="search" value={filters.search} /></label>
      <label>Кто входил<Select onChange={(event) => change("userId", event.target.value)} value={filters.userId}>
        <option value="">Все сотрудники</option>
        {people.map((person) => <option key={person.id} value={person.id}>{person.fullName}</option>)}
      </Select></label>
      <label>Чем закончилось<Select onChange={(event) => change("outcome", event.target.value)} value={filters.outcome}>
        <option value="">Все входы</option>
        <option value="success">Вошёл</option>
        <option value="failure">Не вошёл</option>
      </Select></label>
      <label>С<DatePicker aria-label="Входы с даты" onChange={(value) => change("from", value)} value={filters.from} /></label>
      <label>По<DatePicker aria-label="Входы по дату" onChange={(value) => change("to", value)} value={filters.to} /></label>
    </FilterBar>
    {/* Удачные входы ведёт служба входа Supabase, неудачные попытки пишет сама CRM.
        Если журнала службы нет, об этом надо сказать, а не показывать половину правды. */}
    {successSourceAvailable
      ? null
      : <Notice tone="warning">Удачные входы ведёт служба входа, и её журнал сейчас недоступен: ниже только неудачные попытки.</Notice>}
    <section className="card card--table" aria-label="Журнал входов">
      {loading && items.length === 0
        ? <ResourceState description="Подождите, записи сейчас появятся." status="loading" title="Загружаем журнал входов" />
        : error
          ? <ResourceState description={error} status="error" title="Журнал входов не загрузился" />
          : items.length === 0
            ? <ResourceState
              description={filtered ? "Измените условия или сбросьте фильтры." : "Записи появятся здесь после первого входа в систему."}
              status={filtered ? "filtered-empty" : "empty"}
              title={filtered ? "Входов по этим условиям нет" : "Входов пока нет"} />
            : <div className="table-scroll"><table className="data-table journal-table journal-table--logins">
              <thead><tr>
                <th scope="col">Когда</th>
                <th scope="col">Кто</th>
                <th scope="col">Адрес</th>
                <th scope="col">Чем закончилось</th>
              </tr></thead>
              <tbody>
                {items.map((entry) => {
                  const hint = loginWhoHint(entry);
                  return <tr key={entry.id}>
                    <td className="journal-table__when">{whenText(entry.occurredAt)}</td>
                    <td>{loginWhoText(entry)}{hint ? <small>{hint}</small> : null}</td>
                    <td className="journal-table__ip">{entry.ipAddress ?? "не определён"}</td>
                    <td><StatusBadge tone={entry.success ? "success" : "danger"}>{loginOutcomeText(entry)}</StatusBadge></td>
                  </tr>;
                })}
              </tbody>
            </table></div>}
      <RegistryPagination ariaLabel="Страницы журнала входов" alwaysShow onPageChange={changePage} onPageSizeChange={(size) => { setPageSize(size); changePage(0); }} pageIndex={pageIndex} pageSize={pageSize} total={total} />
    </section>
  </>;
}

/**
 * Экран «Журналы» (ТЗ 6.3): что меняли в системе и кто входил.
 *
 * Права проверяет база: журнал изменений закрыт правилом строк audit_log, журнал
 * входов — функцией login_journal, и то и другое по праву «Просмотр аудита». Раздел
 * не показывается тому, у кого права нет (navigationForSession в App.tsx), но если
 * открыть его в обход меню, база всё равно ничего не отдаст.
 */
export function JournalsPage() {
  const [section, setSection] = useState<"changes" | "access" | "logins">("changes");
  // Вкладка «Входы» — только руководителю и администратору (0074); базовую роль берём из сессии.
  const [loginsAllowed, setLoginsAllowed] = useState(false);
  useEffect(() => {
    void m2Api.session().then((session) => setLoginsAllowed(canReadLoginJournal(session.role))).catch(() => setLoginsAllowed(false));
  }, []);
  const [people, setPeople] = useState<readonly JournalPerson[]>([]);
  useEffect(() => {
    // Список сотрудников нужен фильтру «кто»: без него по человеку отбирать нечем.
    void m2Api.journalPeople()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, []);
  return <>
    <PageIntro title="Журналы" />
    {/* «Доступ и права» — рядом со входами (встреча 19.11): кто завёл сотрудника, выдал или поменял права. */}
    <PageTabs<"changes" | "access" | "logins">
      items={[{ value: "changes", label: "Изменения" }, ...(loginsAllowed ? [{ value: "logins" as const, label: "Входы" }] : []), { value: "access", label: "Доступ и права" }]}
      label="Какой журнал смотреть"
      onValueChange={setSection}
      value={section === "logins" && !loginsAllowed ? "changes" : section}
    />
    {section === "logins" && loginsAllowed ? <LoginsJournal people={people} />
      : section === "access" ? <ChangesJournal entityType="user" key="access" people={people} />
      : <ChangesJournal key="changes" people={people} />}
  </>;
}

/** Объект события ссылкой (18.11: «всё ссылками»): только сама задача или сам прибор, не их строки. */
function auditEntityLink(event: { readonly entityType: string; readonly entityId: string; readonly tableName?: string }): EntityTarget | undefined {
  if (event.entityType === "task" && event.tableName === "tasks") return { kind: "task", id: event.entityId };
  if (event.entityType === "equipment" && event.tableName === "equipment") return { kind: "equipment", id: event.entityId };
  return undefined;
}
