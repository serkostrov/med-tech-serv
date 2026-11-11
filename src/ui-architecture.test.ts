import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("shared UI architecture", () => {
  it("keeps CRUD out of browser-native prompts and uses shared dialogs", async () => {
    const [app, customerReferences, operations] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./CustomerReferencesPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("./OperationsPages.tsx", import.meta.url), "utf8")
    ]);
    const source = `${app}\n${customerReferences}\n${operations}`;
    assert.doesNotMatch(source, /window\.(?:alert|confirm|prompt)\s*\(/u);
    assert.match(customerReferences, /DialogForm/u);
    assert.match(customerReferences, /ConfirmationDialog/u);
    assert.match(operations, /inventoryPartPage/u);
    assert.match(operations, /Пополнить/u);
    assert.match(operations, /receiveInventoryPart/u);
    assert.match(app, /className="table-actions equipment-registry-actions"[^>]*>[\s\S]*Сменить место/u);
    assert.doesNotMatch(app, /label="Открыть паспорт"/u);
    assert.match(app, /className="data-table__selectable"[^>]*onClick=\{\(\) => void openCard\(record\.id\)\}/u);
  });

  it("defines compact login, responsive dialogs and full-width work area", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    assert.match(css, /\.main-content\s*\{[^}]*width:\s*100%/su);
    assert.match(css, /\.login-card\s*\{[^}]*width:\s*min\(100%,\s*380px\)/su);
    assert.match(css, /--font-sans:\s*system-ui,/u);
    assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-sans\)[^}]*line-height:\s*1\.4/su);
    assert.match(css, /font-synthesis:\s*weight style/u);
    assert.doesNotMatch(css, /font-synthesis:\s*none/u);
    assert.match(css, /@media \(max-width:\s*620px\)/u);
    assert.doesNotMatch(css, /\.metric-card::after/u);
    assert.match(css, /\.customer-references\s*\{/u);
  });

  it("opens directories on the service catalogs tab", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    assert.match(app, /case "customers": return <CustomersPage \/>/u);
    assert.match(app, /useState<"catalogs" \| "equipment" \| "notifications">\("catalogs"\)/u);
    assert.match(app, /value: "equipment" as const, label: "Дерево приборов"/u);
    assert.doesNotMatch(app, /notificationTemplates \? "notifications"/u);
    assert.doesNotMatch(app, /value: "customers", label: "Площадки и плательщики"/u);
  });

  it("lets reference rows grow without sticky headers covering their content", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    assert.doesNotMatch(css, /\.data-table th\s*\{[^}]*position:\s*sticky/su);
    assert.match(css, /\.data-table td\s*\{[^}]*line-height:\s*1\.4[^}]*white-space:\s*normal/su);
    assert.match(css, /\.reference-admin-table td\s*\{[^}]*vertical-align:\s*top/su);
    assert.match(css, /\.reference-admin-actions\s*\{[^}]*flex-wrap:\s*wrap[^}]*white-space:\s*normal/su);
  });

  it("keeps the task workspace compact with a shared shell, mobile filter sheet and internally paged kanban", async () => {
    const [app, shell, ui, board, css] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./components/app-shell.tsx", import.meta.url), "utf8"),
      readFile(new URL("./ui.tsx", import.meta.url), "utf8"),
      readFile(new URL("./TaskBoard.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.doesNotMatch(app, /<header className="topbar"/u);
    assert.match(app, /<AppShell/u);
    assert.match(shell, /className="sidebar-user"/u);
    assert.doesNotMatch(shell, /tone="success"/u);
    assert.doesNotMatch(app, /создан на сервере/u);
    assert.doesNotMatch(app, /setNotice/u);
    assert.doesNotMatch(app, /событий требуют внимания/u);
    assert.match(app, /<ViewSwitch/u);
    assert.match(app, /Закрытые и отменённые/u);
    assert.match(app, /showCompleted=\{showCompletedBoard\}/u);
    assert.match(board, /showCompleted/u);
    assert.match(board, /isCompletedBoardStatus/u);
    assert.match(css, /\.view-switch\s*\{/u);
    assert.match(app, /label="Разделы карточки задачи"/u);
    assert.match(app, /registryView === "list" && selectedTaskIds\.size > 0/u);
    assert.match(app, /setSelectedTaskIds\(new Set\(\)\)/u);
    assert.match(app, /title="Основные параметры задачи"/u);
    assert.match(ui, /export function Sheet/u);
    assert.match(ui, /filter-bar__mobile-trigger/u);
    assert.match(board, /COLUMN_PAGE_SIZE\s*=\s*12/u);
    assert.match(board, /onDragStart/u);
    assert.match(board, /onDrop/u);
    assert.match(board, /onScroll/u);
    assert.match(css, /\.task-board\s*\{[^}]*height:\s*clamp\([^}]*overflow-y:\s*hidden/su);
    assert.match(css, /\.task-board__cards\s*\{[^}]*overflow-y:\s*auto/su);
    assert.match(css, /\.task-bulk-actions\s*\{[^}]*margin-bottom:\s*16px/su);
    assert.doesNotMatch(css, /input:focus-visible,\s*select:focus-visible/su);
  });

  it("does not nest a second window inside dialogs", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(app, /className="card equipment-passport"/u);
    assert.doesNotMatch(app, /equipment-change-form__heading/u);
    assert.match(app, /submitLabel=\{record \? "Сохранить изменения" : "Создать паспорт"\}/u);
    assert.match(app, /footer=\{<Button onClick=\{\(\) => setActRowsEditing\(false\)\}>Готово/u);
    assert.match(app, /form="task-parts-editor-form"/u);
  });

  it("keeps the invoice dialog fields stacked in one column", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    assert.match(app, /className="invoice-form"/u);
    assert.match(app, /invoice-form__empty/u);
    assert.match(app, /submitDisabled=\{!canCreateInvoice\}/u);
    assert.doesNotMatch(app, /fieldset className="workflow-task-picker"/u);
  });

  it("uses shared entity navigation and tabs for multi-section cards", async () => {
    const [app, workAct, ui] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./WorkAct.tsx", import.meta.url), "utf8"),
      readFile(new URL("./ui.tsx", import.meta.url), "utf8")
    ]);
    assert.match(ui, /export function BackButton/u);
    assert.match(ui, /export function EntityDetailToolbar/u);
    assert.match(ui, /export function EntityDetailHeader/u);
    assert.match(app, /label="Разделы карточки прибора"/u);
    for (const tab of ["history", "meters", "files", "movements"]) {
      assert.match(app, new RegExp(`value: "${tab}"`, "u"));
    }
    assert.match(app, /<EntityDetailToolbar[\s\S]{0,300}backLabel="К списку задач"/u);
    assert.match(app, /<EntityDetailToolbar[\s\S]{0,400}backLabel="К приборам"/u);
    assert.ok(!app.includes("title={`${record.model} · S/N"));
    // Паспорт прибора устроен как карточка задачи: свойства справа, открытые задачи сверху.
    assert.match(app, /aria-label="Паспорт прибора"/u);
    assert.match(app, /Открытые задачи/u);
    assert.match(workAct, /<EntityDetailToolbar[\s\S]{0,300}backLabel="К задаче"/u);
    assert.doesNotMatch(`${app}\n${workAct}`, /←\s*(?:Назад|К карточке|К реестру)/u);
  });

  it("renders custom selects instead of native browser dropdowns", async () => {
    const [select, app, access, css] = await Promise.all([
      readFile(new URL("./components/ui/select.tsx", import.meta.url), "utf8"),
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./AccessAdminPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.match(select, /@radix-ui\/react-select/u);
    assert.match(select, /ui-select__trigger/u);
    assert.match(select, /isSelectSurface/u);
    assert.doesNotMatch(app, /<select[\s>]/u);
    assert.doesNotMatch(access, /<select[\s>]/u);
    assert.match(css, /\.ui-select__content/u);
    assert.match(css, /\.date-picker-popover\s*\{[^}]*pointer-events:\s*auto/su);
    assert.match(css, /\.date-picker-popover\s*\{[^}]*z-index:\s*100/su);
    assert.match(css, /\.ui-select__item/u);
  });

  it("shows operational alerts as toasts instead of page banners", async () => {
    const [toast, access, app, css] = await Promise.all([
      readFile(new URL("./components/ui/toast.tsx", import.meta.url), "utf8"),
      readFile(new URL("./AccessAdminPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.match(toast, /export function ToastHost/u);
    assert.match(toast, /toast\.error/u);
    assert.match(css, /\.toast-host/u);
    assert.doesNotMatch(access, /status="error"/u);
    assert.doesNotMatch(access, /<Notice/u);
    assert.doesNotMatch(app, /<Notice/u);
    assert.match(access, /toast\.error/u);
  });

  it("uses a searchable equipment combobox when creating a task", async () => {
    const [app, picker, css] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./EquipmentFolderPicker.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.match(app, /EquipmentFolderPicker/u);
    assert.match(app, /Сменить/u);
    assert.match(picker, /equipment-combobox/u);
    assert.match(picker, /equipment-folder/u);
    assert.match(picker, /Новый/u);
    assert.match(picker, /AddEquipmentDialog/u);
  });

  it("lets coordinators attach warehouse parts when creating a task", async () => {
    const [app, picker, css] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./PartsMultiPicker.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.match(app, /PartsMultiPicker/u);
    assert.match(app, /replaceTaskParts/u);
    assert.match(picker, /parts-multi-picker/u);
    assert.match(picker, /не списываем/u);
    assert.match(picker, /Гарантийный/u);
    assert.match(picker, /Для продажи/u);
    assert.match(css, /\.parts-multi-picker__chip/u);
    assert.match(css, /\.parts-multi-picker__flags/u);
    assert.doesNotMatch(app, /searchEquipmentBySerial/u);
    assert.doesNotMatch(app, />Найти</u);
    assert.match(css, /\.equipment-combobox__list/u);
    assert.match(css, /\.equipment-folder__row/u);
    assert.match(css, /\.equipment-picker__selected/u);
  });
});
