import { Menu } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { subscribeActivity } from "../lib/activity.js";
import type { NavigationId, NavigationItem } from "../navigation.js";
import { Button, Icon, Sheet } from "../ui.js";

export interface AppShellNavGroup {
  readonly label: string;
  readonly items: readonly NavigationItem[];
}

export function AppShell({
  groups,
  activeId,
  currentPageLabel,
  onNavigate,
  userName,
  userMeta,
  onLogout,
  children
}: {
  readonly groups: readonly AppShellNavGroup[];
  readonly activeId?: NavigationId;
  readonly currentPageLabel?: string;
  readonly onNavigate: (id: NavigationId) => void;
  readonly userName: string;
  readonly userMeta: string;
  readonly onLogout: () => void;
  readonly children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const initials = userName.split(" ").map((part) => part[0]).join("").slice(0, 2);
  const navigate = (id: NavigationId) => {
    onNavigate(id);
    setMobileOpen(false);
  };

  const navigation = (
    <nav aria-label="Разделы" className="sidebar-nav">
      {groups.map((group) => (
        <div className="nav-group" key={group.label}>
          <p className="nav-group__label">{group.label}</p>
          {group.items.map((item) => {
            const active = activeId === item.id;
            return (
              <button
                aria-current={active ? "page" : undefined}
                className={`nav-item ${active ? "nav-item--active" : ""}`.trim()}
                key={item.id}
                onClick={() => navigate(item.id)}
                title={item.description}
                type="button"
              >
                <span className="nav-item__icon"><Icon name={item.icon} size={16} /></span>
                <span className="nav-item__copy">
                  <strong>{item.label}</strong>
                </span>
                {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const userBlock = (
    <div className="sidebar-user">
      <div className="sidebar-user__identity">
        <span className="avatar">{initials}</span>
        <span className="profile-button__copy">
          <strong>{userName}</strong>
          <small>{userMeta}</small>
        </span>
      </div>
      <Button className="sidebar-user__logout button--compact" icon="logout" onClick={onLogout} variant="ghost" children={null} />
    </div>
  );

  return (
    <div className="app-shell">
      <TopProgress />
      <a className="skip-link" href="#main-content">К содержимому</a>
      <aside aria-label="Основная навигация" className="sidebar">
        <div className="sidebar-brand">
          <div aria-hidden="true" className="brand-mark">МТ</div>
          <div className="brand-copy">
            <strong>МедТехСервис</strong>
            <span>сервис техники</span>
          </div>
        </div>
        {navigation}
        {userBlock}
      </aside>

      <div className="main-shell">
        <header className="app-mobile-bar">
          <Button aria-label="Открыть меню разделов" onClick={() => setMobileOpen(true)} variant="secondary">
            <Menu aria-hidden="true" size={16} />
            Меню
          </Button>
          <strong>{currentPageLabel ?? "МедТехСервис"}</strong>
        </header>
        <Sheet description="Выберите раздел, чтобы продолжить работу." onOpenChange={setMobileOpen} open={mobileOpen} title="Разделы">
          <div className="sidebar sidebar--sheet">
            {navigation}
            {userBlock}
          </div>
        </Sheet>
        <main className="main-content" id="main-content" tabIndex={-1}>
          <div className="page-container">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Тонкая полоса сверху, пока идут запросы к серверу. Короткие (до 200 мс) не показываем, чтобы не мигала. */
function TopProgress() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeActivity((active) => {
      if (active > 0) {
        if (!timer) timer = setTimeout(() => { setVisible(true); }, 200);
      } else {
        if (timer) { clearTimeout(timer); timer = undefined; }
        setVisible(false);
      }
    });
    return () => { if (timer) clearTimeout(timer); unsubscribe(); };
  }, []);
  return <div aria-hidden="true" className={visible ? "top-progress top-progress--on" : "top-progress"} />;
}
