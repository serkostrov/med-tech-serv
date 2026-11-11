import React, {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Ban,
  BarChart3,
  Bell,
  Bookmark,
  BookOpen,
  Building2,
  CalendarClock,
  Check,
  ChevronRight,
  CircleOff,
  ClipboardList,
  Clock,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  ListFilter,
  LoaderCircle,
  LogOut,
  Mail,
  MapPin,
  Monitor,
  Package,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Search,
  Shield,
  Trash2,
  Users,
  Wallet,
  Warehouse,
  Wrench,
  X,
  type LucideIcon
} from "lucide-react";
import { Alert } from "./components/ui/alert.js";
import { Badge } from "./components/ui/badge.js";
import { Button as UiButton } from "./components/ui/button.js";
import {
  Dialog as UiDialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "./components/ui/dialog.js";
import { Input } from "./components/ui/input.js";
import { Sheet as UiSheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./components/ui/sheet.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { Textarea } from "./components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";
import { cn } from "./lib/utils.js";
import { DatePicker, DateTimePicker, isDatePickerSurface } from "./components/ui/date-picker.js";
import { Select, isSelectSurface } from "./components/ui/select.js";
import { ToastHost, toast } from "./components/ui/toast.js";

export type IconName =
  | "tasks" | "maintenance" | "equipment" | "engineers" | "warehouse" | "customers" | "notifications"
  | "reports" | "references" | "finance" | "reservations" | "inventory" | "handoff"
  | "plus" | "bell" | "check" | "search" | "filter" | "arrow" | "back" | "clock"
  | "info" | "close" | "users" | "shield" | "mail" | "logout"
  | "edit" | "hide" | "show" | "disable" | "enable" | "open" | "relocate" | "ignore" | "restore"
  | "moveUp" | "moveDown" | "trash";

const icons: Readonly<Record<IconName, LucideIcon>> = {
  tasks: ClipboardList,
  maintenance: CalendarClock,
  equipment: Monitor,
  engineers: Wrench,
  warehouse: Warehouse,
  customers: Building2,
  notifications: Bell,
  reports: BarChart3,
  references: BookOpen,
  finance: Wallet,
  reservations: Bookmark,
  inventory: Package,
  handoff: ArrowLeftRight,
  plus: Plus,
  bell: Bell,
  check: Check,
  search: Search,
  filter: ListFilter,
  arrow: ArrowRight,
  back: ArrowLeft,
  clock: Clock,
  info: Info,
  close: X,
  users: Users,
  shield: Shield,
  mail: Mail,
  logout: LogOut,
  edit: Pencil,
  hide: EyeOff,
  show: Eye,
  disable: CircleOff,
  enable: Power,
  open: FolderOpen,
  relocate: MapPin,
  ignore: Ban,
  restore: RotateCcw,
  moveUp: ArrowUp,
  moveDown: ArrowDown,
  trash: Trash2
};

export function Icon({ name, size = 16 }: { readonly name: IconName; readonly size?: number }) {
  const LucideIcon = icons[name];
  return <LucideIcon aria-hidden="true" size={size} strokeWidth={1.75} />;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  optional = false,
  className,
  children
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly optional?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className={cn("field grid gap-1.5 text-sm font-medium leading-5 text-foreground", className)}>
      <span className="flex flex-wrap items-baseline gap-2">
        <span>
          {label}
          {required ? <span aria-hidden="true" className="text-destructive"> *</span> : null}
        </span>
        {optional ? <span className="text-xs font-normal text-muted-foreground">необязательно</span> : null}
      </span>
      {children}
      {hint ? <span className="field-note text-xs font-normal leading-5 text-muted-foreground">{hint}</span> : null}
      {error ? <span className="form-error" role="alert">{error}</span> : null}
    </label>
  );
}

export type StatusTone = "danger" | "info" | "neutral" | "success" | "warning" | "purple" | "orange";
export type ButtonVariant = "danger" | "ghost" | "primary" | "secondary" | "success";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly icon?: IconName;
  readonly busy?: boolean;
  readonly busyLabel?: string;
}

const buttonVariantMap = {
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
  danger: "destructive",
  success: "success"
} as const;

export function Button({
  children,
  variant = "primary",
  icon,
  className = "",
  busy = false,
  busyLabel = "Сохранение…",
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  const compact = className.includes("button--compact");
  return (
    <UiButton
      className={cn("button", `button--${variant}`, className)}
      disabled={disabled || busy}
      size={compact ? "sm" : "default"}
      type={type}
      variant={buttonVariantMap[variant]}
      {...props}
    >
      {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : icon ? <Icon name={icon} size={14} /> : null}
      <span>{busy ? busyLabel : children}</span>
    </UiButton>
  );
}

export function IconButton({
  icon,
  label,
  variant = "ghost",
  className = "",
  type = "button",
  ...props
}: Omit<ButtonProps, "children" | "icon" | "busy" | "busyLabel"> & { readonly icon: IconName; readonly label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UiButton
          aria-label={label}
          className={cn("button", "button--icon", `button--${variant}`, className)}
          size="icon"
          type={type}
          variant={buttonVariantMap[variant]}
          {...props}
        >
          <Icon name={icon} size={15} />
          <span className="sr-only">{label}</span>
        </UiButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function CloseControl({
  onClick,
  label = "Закрыть"
}: {
  readonly onClick: () => void;
  readonly label?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClick}
          type="button"
        >
          <Icon name="close" size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function BackButton({ children = "Назад", className = "", ...props }: Omit<ButtonProps, "children" | "icon" | "variant"> & { readonly children?: ReactNode }) {
  return <Button className={cn("entity-back-button", className)} icon="back" variant="ghost" {...props}>{children}</Button>;
}

export interface PageCrumb {
  readonly label: string;
  readonly onSelect?: () => void;
}

export function PageBreadcrumbs({ items }: { readonly items: readonly PageCrumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Путь по разделам" className="page-breadcrumb text-sm text-muted-foreground">
      <ol className="m-0 flex list-none flex-wrap items-center gap-0.5 p-0">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li className="inline-flex items-center gap-0.5" key={`${item.label}-${index}`}>
              {index > 0 ? <ChevronRight aria-hidden="true" className="page-breadcrumb__sep opacity-60" size={14} /> : null}
              {last || !item.onSelect
                ? <span aria-current={last ? "page" : undefined} className="text-foreground/80">{item.label}</span>
                : <button className="bg-transparent p-0 font-inherit text-primary underline-offset-2 hover:underline" onClick={item.onSelect} type="button">{item.label}</button>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function EntityDetailToolbar({
  onBack,
  backLabel = "Назад",
  actions,
  parentLabel,
  currentLabel
}: {
  readonly onBack: () => void;
  readonly backLabel?: string;
  readonly actions?: ReactNode;
  readonly parentLabel?: string;
  readonly currentLabel?: string;
}) {
  return (
    <div className="entity-detail-toolbar">
      <div className="entity-detail-toolbar__nav">
        {parentLabel && currentLabel
          ? <PageBreadcrumbs items={[{ label: parentLabel, onSelect: onBack }, { label: currentLabel }]} />
          : <BackButton onClick={onBack}>{backLabel}</BackButton>}
      </div>
      {actions ? <div className="entity-detail-toolbar__actions">{actions}</div> : null}
    </div>
  );
}

export function EntityDetailHeader({ title, description, meta, aside }: { readonly title: string; readonly description?: ReactNode; readonly meta?: ReactNode; readonly aside?: ReactNode }) {
  return (
    <header className="entity-detail-heading flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {meta ? <div className="entity-detail-heading__meta mb-2 flex flex-wrap gap-1.5 text-xs font-medium text-muted-foreground">{meta}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-[15px] leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {aside ? <div className="entity-detail-heading__aside">{aside}</div> : null}
    </header>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
  breadcrumbs,
  titleAside
}: {
  readonly eyebrow?: string;
  readonly title: string;
  /** Пояснение не выводится: заголовок и кнопки говорят сами за себя. Остаётся подсказкой при наведении. */
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly breadcrumbs?: readonly PageCrumb[];
  /** Переключатель вида (Доска / Список) рядом с заголовком. */
  readonly titleAside?: ReactNode;
}) {
  return (
    <header className={cn("page-intro")}>
      {breadcrumbs ? <PageBreadcrumbs items={breadcrumbs} /> : null}
      {eyebrow ? <p className="page-intro__eyebrow">{eyebrow}</p> : null}
      <div className="page-intro__row">
        <div className="page-intro__title">
          <h1 {...(description ? { title: description } : {})}>{title}</h1>
          {titleAside}
        </div>
        {actions ? <div className="page-intro__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Маленький переключатель вида: «Доска / Список». */
export function ViewSwitch<Value extends string>({ label, items, value, onValueChange }: {
  readonly label: string;
  readonly items: readonly { readonly value: Value; readonly label: string; readonly badge?: number }[];
  readonly value: Value;
  readonly onValueChange: (value: Value) => void;
}) {
  return (
    <div aria-label={label} className="view-switch" role="group">
      {items.map((item) => (
        <button aria-pressed={item.value === value} className={item.value === value ? "view-switch__on" : undefined} key={item.value} onClick={() => onValueChange(item.value)} type="button">
          {item.label}{item.badge ? <small>{item.badge}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function CardHeader({ title, meta, action, headingId }: { readonly title: string; readonly meta?: string; readonly action?: ReactNode; readonly headingId?: string }) {
  return (
    <header className="card-header">
      <div>
        <h2 id={headingId}>{title}</h2>
        {meta ? <p>{meta}</p> : null}
      </div>
      {action ? <div className="card-header__action">{action}</div> : null}
    </header>
  );
}

const statusVariant = {
  danger: "danger",
  info: "info",
  neutral: "outline",
  success: "success",
  warning: "warning",
  purple: "purple",
  orange: "warning"
} as const;

export function StatusBadge({ children, tone }: { readonly children: ReactNode; readonly tone: StatusTone }) {
  return <Badge className={`status-badge status-badge--${tone}`} variant={statusVariant[tone]}>{children}</Badge>;
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "blue",
  icon,
  onClick
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone?: "blue" | "green" | "orange" | "purple" | "red" | "yellow";
  readonly icon?: IconName;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      {icon ? <span className="metric-card__icon"><Icon name={icon} size={15} /></span> : null}
      <span className="metric-card__text">
        <span className="metric-card__label">{label}</span>
        {detail ? <small title={detail}>{detail}</small> : null}
      </span>
      <strong>{value}</strong>
    </>
  );
  const className = cn("metric-card", `metric-card--${tone}`, icon ? "metric-card--icon" : "");
  return onClick
    ? <button className={cn(className, "metric-card--action")} onClick={onClick} type="button">{content}</button>
    : <article className={className}>{content}</article>;
}

export function Notice({ children, tone = "info", icon = "info", action }: { readonly children: ReactNode; readonly tone?: "info" | "warning" | "success"; readonly icon?: IconName; readonly action?: ReactNode }) {
  return (
    <Alert className={`notice notice--${tone}`} variant={tone}>
      <span className="notice__icon"><Icon name={icon} size={17} /></span>
      <div>{children}</div>
      {action ? <div className="notice__action">{action}</div> : null}
    </Alert>
  );
}

export interface TabItem<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly badge?: number;
  readonly disabled?: boolean;
  readonly panelId?: string;
}

export function PageTabs<Value extends string>({ label, items, value, onValueChange }: { readonly label: string; readonly items: readonly TabItem<Value>[]; readonly value: Value; readonly onValueChange: (value: Value) => void }) {
  const rootId = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    const enabledIndex = enabled.findIndex(({ index }) => index === currentIndex);
    let target = -1;
    if (event.key === "ArrowRight") target = enabled[(enabledIndex + 1) % enabled.length]?.index ?? -1;
    if (event.key === "ArrowLeft") target = enabled[(enabledIndex - 1 + enabled.length) % enabled.length]?.index ?? -1;
    if (event.key === "Home") target = enabled[0]?.index ?? -1;
    if (event.key === "End") target = enabled.at(-1)?.index ?? -1;
    if (target >= 0) { event.preventDefault(); tabs.current[target]?.focus(); }
  };
  return (
    <div aria-label={label} className="page-tabs" role="tablist">
      {items.map((item, index) => (
        <button
          {...(item.panelId ? { "aria-controls": item.panelId } : {})}
          aria-selected={item.value === value}
          className={item.value === value ? "page-tabs__active" : undefined}
          disabled={item.disabled}
          id={`${rootId}-tab-${item.value}`}
          key={item.value}
          onClick={() => onValueChange(item.value)}
          onKeyDown={(event) => moveFocus(event, index)}
          ref={(node) => { tabs.current[index] = node; }}
          role="tab"
          tabIndex={item.value === value ? 0 : -1}
          type="button"
        >
          <span>{item.label}</span>
          {item.badge ? <small>{item.badge}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ value, activeValue, children, id, labelledBy }: { readonly value: string; readonly activeValue: string; readonly children: ReactNode; readonly id?: string; readonly labelledBy?: string }) {
  if (value !== activeValue) return null;
  return <div {...(id ? { id } : {})} {...(labelledBy ? { "aria-labelledby": labelledBy } : {})} className="tab-panel" role="tabpanel">{children}</div>;
}

export function FilterBar({
  children,
  onSubmit,
  onReset,
  loading = false,
  submitLabel = "Показать",
  resetLabel = "Сбросить"
}: {
  readonly children: ReactNode;
  readonly onSubmit: () => void | Promise<void>;
  readonly onReset?: () => void;
  readonly loading?: boolean;
  readonly submitLabel?: string;
  readonly resetLabel?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const [searchFilled, setSearchFilled] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  // Поле поиска (класс filter-field--search) стоит в строке; остальные поля при большом
  // количестве прячутся в панель «Фильтры», чтобы не занимать пол-экрана.
  const all = Children.toArray(children);
  const search = all.find((node) => isValidElement<{ className?: string }>(node) && typeof node.props.className === "string" && node.props.className.includes("filter-field--search"));
  const rest = all.filter((node) => node !== search);
  const collapsed = rest.length > 3;
  // Сколько условий выбрано: поле считается выбранным, если в нём текст или значение
  // отличается от первого пункта списка («Все», «Сначала обновлённые»).
  useEffect(() => {
    const fieldsInForm = [...(formRef.current?.querySelectorAll<HTMLElement>(".filter-bar__field") ?? [])];
    const count = fieldsInForm.filter((field) => [...field.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input:not([type=hidden]), select")].some((control) => {
      if (control instanceof HTMLSelectElement) return control.options.length > 0 && control.value !== (control.options[0]?.value ?? "");
      return control.value.trim() !== "";
    })).length;
    setActiveCount(count);
    setSearchFilled(Boolean(formRef.current?.querySelector<HTMLInputElement>(".filter-bar__search input")?.value.trim()));
  });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setPanelOpen(false); void onSubmit(); };
  const submitMobile = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void Promise.resolve(onSubmit()).then(() => setMobileOpen(false)); };
  const fields = rest.map((node, index) => <div className="filter-bar__field" key={index}>{node}</div>);
  const actions = (
    <div className="filter-bar__actions">
      {onReset ? <Button type="reset" variant="ghost">{resetLabel}</Button> : null}
      <Button busy={loading} busyLabel="Ищем…" icon="filter" type="submit">{submitLabel}</Button>
    </div>
  );
  return (
    <section aria-busy={loading} aria-label="Фильтры" className={cn("filter-bar", "filter-bar--v2", collapsed ? "filter-bar--collapsible" : "")}>
      <form className="filter-bar__desktop" onReset={() => { onReset?.(); setPanelOpen(false); }} onSubmit={submit} ref={formRef}>
        <div className="filter-bar__row">
          {search ? <div className="filter-bar__search">{search}</div> : null}
          {collapsed
            ? <Button aria-expanded={panelOpen} className={cn("filter-bar__toggle", activeCount ? "filter-bar__toggle--active" : "")} icon="filter" onClick={() => setPanelOpen((open) => !open)} variant="secondary">
                {activeCount ? `Фильтры · ${activeCount}` : "Фильтры"}
              </Button>
            : <div className="filter-bar__inline">{fields}</div>}
          {collapsed ? <>{onReset && (activeCount || searchFilled) ? <Button type="reset" variant="ghost">{resetLabel}</Button> : null}{search ? <Button busy={loading} busyLabel="Ищем…" type="submit" variant="secondary">Найти</Button> : null}</> : actions}
        </div>
        {collapsed ? <div className="filter-bar__panel" hidden={!panelOpen}>
          <div className="filter-bar__fields">{fields}</div>
          {actions}
        </div> : null}
      </form>
      <Button className="filter-bar__mobile-trigger" icon="filter" onClick={() => setMobileOpen(true)} variant="secondary">Фильтры</Button>
      <Sheet description={`Укажите, что показать в списке, и нажмите «${submitLabel}».`} onOpenChange={setMobileOpen} open={mobileOpen} title="Фильтры">
        <form className="filter-bar__mobile-form" onReset={() => onReset?.()} onSubmit={submitMobile}>
          <div className="filter-bar__fields">{search}{rest}</div>
          {actions}
        </form>
      </Sheet>
    </section>
  );
}

export type ResourceStatus = "loading" | "empty" | "filtered-empty" | "error";

export function ResourceState({
  status,
  title,
  description,
  onRetry,
  action,
  icon
}: {
  readonly status: ResourceStatus;
  readonly title?: string;
  readonly description?: string;
  readonly onRetry?: () => void;
  readonly action?: ReactNode;
  readonly icon?: IconName;
}) {
  const labels: Readonly<Record<ResourceStatus, string>> = {
    loading: "Загрузка…",
    empty: "Пока пусто",
    "filtered-empty": "Ничего не найдено",
    error: "Не получилось загрузить"
  };
  const details: Readonly<Record<ResourceStatus, string>> = {
    loading: "Подождите, сейчас появится.",
    empty: "Когда появятся записи, они отобразятся здесь.",
    "filtered-empty": "Измените поиск или сбросьте фильтры.",
    error: "Попробуйте ещё раз. Если не поможет, обновите страницу."
  };
  const iconName = icon ?? (status === "error" ? "info" : status === "empty" ? "open" : "search");
  // Загрузка: серые строки по форме будущего списка вместо надписи, экран не прыгает.
  if (status === "loading") {
    return (
      <div aria-busy="true" className="resource-state resource-state--loading resource-state--skeleton" role="status">
        <span className="sr-only">{title ?? labels.loading}</span>
        {[0, 1, 2, 3, 4].map((row) => <div className="skeleton-row" key={row}><Skeleton className="skeleton-row__a" /><Skeleton className="skeleton-row__b" /><Skeleton className="skeleton-row__c" /></div>)}
      </div>
    );
  }
  return (
    <div className={"resource-state resource-state--" + status} role={status === "error" ? "alert" : "status"}>
      <span className="resource-state__icon"><Icon name={iconName} size={16} /></span>
      <strong>{title ?? labels[status]}</strong>
      <p>{description ?? details[status]}</p>
      {status === "error" && onRetry ? <Button onClick={onRetry} variant="secondary">Повторить</Button> : action}
    </div>
  );
}

export function DataTableShell({ title, meta, children, action }: { readonly title: string; readonly meta?: string; readonly children: ReactNode; readonly action?: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="card card--table data-table-shell overflow-hidden">
      <CardHeader {...(action ? { action } : {})} headingId={headingId} {...(meta ? { meta } : {})} title={title} />
      {children}
    </section>
  );
}

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: "sm" | "md" | "lg";
  readonly busy?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

const dialogSizeClass = {
  sm: "w-[min(100%-1.5rem,27.5rem)]",
  md: "w-[min(100%-1.5rem,40rem)]",
  lg: "w-[min(100%-1.5rem,56rem)]"
} as const;

export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md", busy = false, initialFocusRef }: DialogProps) {
  return (
    <UiDialog onOpenChange={(next) => { if (!busy) onOpenChange(next); }} open={open}>
      <DialogContent
        className={cn("dialog-content", `dialog-content--${size}`, dialogSizeClass[size])}
        hideClose={busy}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onFocusOutside={(event) => { if (busy || isDatePickerSurface(event.target) || isSelectSurface(event.target)) event.preventDefault(); }}
        onInteractOutside={(event) => { if (busy || isDatePickerSurface(event.target) || isSelectSurface(event.target)) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy || isDatePickerSurface(event.target) || isSelectSurface(event.target)) event.preventDefault(); }}
        onOpenAutoFocus={(event) => {
          if (!initialFocusRef?.current) return;
          event.preventDefault();
          initialFocusRef.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="dialog-body">{children}</div>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </UiDialog>
  );
}

export function Sheet({ open, onOpenChange, title, description, children }: Pick<DialogProps, "open" | "onOpenChange" | "title" | "description" | "children">) {
  return (
    <UiSheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="sheet-content"
        onFocusOutside={(event) => { if (isDatePickerSurface(event.target) || isSelectSurface(event.target)) event.preventDefault(); }}
        onInteractOutside={(event) => { if (isDatePickerSurface(event.target) || isSelectSurface(event.target)) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (isDatePickerSurface(event.target) || isSelectSurface(event.target)) event.preventDefault(); }}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <SheetBody>{children}</SheetBody>
      </SheetContent>
    </UiSheet>
  );
}

export function DialogForm({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  submitLabel = "Сохранить изменения",
  busy = false,
  error,
  size = "md",
  danger = false,
  submitDisabled = false
}: Omit<DialogProps, "children" | "footer"> & {
  readonly children: ReactNode;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  readonly submitLabel?: string;
  readonly error?: string | null;
  readonly danger?: boolean;
  readonly submitDisabled?: boolean;
}) {
  const formId = useId();
  return (
    <Dialog
      busy={busy}
      {...(description ? { description } : {})}
      footer={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)} variant="secondary">Отмена</Button>
          <Button busy={busy} disabled={submitDisabled} form={formId} type="submit" variant={danger ? "danger" : "primary"}>{submitLabel}</Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      size={size}
      title={title}
    >
      <form
        className="dialog-form"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onSubmit(event);
        }}
      >
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        {children}
      </form>
    </Dialog>
  );
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  tone = "danger"
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void | Promise<void>;
  readonly tone?: "danger" | "primary";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(); onOpenChange(false); }
    catch (confirmationError) { setError(confirmationError instanceof Error ? confirmationError.message : "Не получилось подтвердить"); }
    finally { setBusy(false); }
  };
  return (
    <Dialog
      busy={busy}
      {...(description ? { description } : {})}
      footer={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)} variant="secondary">Отмена</Button>
          <Button busy={busy} busyLabel="Подождите…" onClick={() => void confirm()} variant={tone}>{confirmLabel}</Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      size="sm"
      title={title}
    >
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}

export { DatePicker, DateTimePicker, Input, Select, Textarea, ToastHost, toast };
