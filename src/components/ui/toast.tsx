import { Check, Info, X } from "lucide-react";
import React, { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ToastTone = "info" | "warning" | "error" | "success";

/** Кнопка в уведомлении, например «Открыть задачу». */
export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastInput {
  readonly title?: string;
  readonly message: string;
  readonly tone?: ToastTone;
  readonly durationMs?: number;
  readonly action?: ToastAction;
}

interface ToastItem extends Required<Pick<ToastInput, "message" | "tone" | "durationMs">> {
  readonly id: number;
  readonly title?: string;
  readonly action?: ToastAction;
}

type Listener = (items: readonly ToastItem[]) => void;

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function publish() {
  for (const listener of listeners) listener(items);
}

function dismiss(id: number) {
  items = items.filter((item) => item.id !== id);
  publish();
}

export function toast(message: string, options: Omit<ToastInput, "message"> = {}): number {
  const id = nextId++;
  const tone = options.tone ?? "warning";
  const durationMs = options.durationMs ?? (tone === "error" ? 7000 : 5000);
  const item: ToastItem = {
    id,
    message,
    tone,
    durationMs,
    ...(options.title ? { title: options.title } : {}),
    ...(options.action ? { action: options.action } : {})
  };
  items = [...items, item].slice(-5);
  publish();
  if (durationMs > 0) window.setTimeout(() => dismiss(id), durationMs);
  return id;
}

toast.info = (message: string, options: Omit<ToastInput, "message" | "tone"> = {}) => toast(message, { ...options, tone: "info" });
toast.warning = (message: string, options: Omit<ToastInput, "message" | "tone"> = {}) => toast(message, { ...options, tone: "warning" });
toast.error = (message: string, options: Omit<ToastInput, "message" | "tone"> = {}) => toast(message, { ...options, tone: "error" });
toast.success = (message: string, options: Omit<ToastInput, "message" | "tone"> = {}) => toast(message, { ...options, tone: "success" });

function toneIcon(tone: ToastTone): ReactNode {
  if (tone === "success") return <Check aria-hidden="true" size={16} />;
  return <Info aria-hidden="true" size={16} />;
}

export function ToastHost() {
  const [toasts, setToasts] = useState<readonly ToastItem[]>(items);
  useEffect(() => {
    const listener: Listener = (next) => setToasts(next);
    listeners.add(listener);
    setToasts(items);
    return () => { listeners.delete(listener); };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div aria-live="polite" className="toast-host" role="region">
      {toasts.map((item) => (
        <article className={`toast toast--${item.tone}`} key={item.id} role={item.tone === "error" || item.tone === "warning" ? "alert" : "status"}>
          <span className="toast__icon">{toneIcon(item.tone)}</span>
          <div className="toast__copy">
            {item.title ? <strong>{item.title}</strong> : null}
            <p>{item.message}</p>
            {item.action ? <button className="toast__action" onClick={() => { dismiss(item.id); item.action?.onClick(); }} type="button">{item.action.label}</button> : null}
          </div>
          <button aria-label="Закрыть уведомление" className="toast__close" onClick={() => dismiss(item.id)} type="button">
            <X aria-hidden="true" size={14} />
          </button>
        </article>
      ))}
    </div>,
    document.body
  );
}
