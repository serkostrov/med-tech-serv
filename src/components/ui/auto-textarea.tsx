import * as React from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export interface TextareaBox {
  readonly scrollHeight: number;
  readonly borders: number;
  readonly paddings: number;
  readonly borderBox: boolean;
  readonly viewportHeight: number;
}

/**
 * Высота поля под весь текст. Выше 60% экрана поле не растёт: дальше внутри появляется прокрутка,
 * чтобы длинное письмо не растягивало окно на несколько экранов.
 */
export function textareaHeight(box: TextareaBox): { readonly height: number; readonly scroll: boolean } {
  const limit = Math.max(160, Math.round(box.viewportHeight * 0.6));
  const outer = box.scrollHeight + box.borders;
  const scroll = outer > limit;
  const fitted = Math.min(outer, limit);
  return { height: box.borderBox ? fitted : Math.max(0, fitted - box.borders - box.paddings), scroll };
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fitTextareaHeight(node: HTMLTextAreaElement): void {
  // Скрытое поле (неактивная вкладка) измерить нельзя: подгоним, когда появится ширина.
  if (!node.isConnected || node.clientWidth === 0) return;
  const scrolled: Array<readonly [Element, number]> = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.scrollTop > 0) scrolled.push([parent, parent.scrollTop]);
  }
  const page = document.scrollingElement;
  const pageTop = page ? page.scrollTop : 0;
  const style = window.getComputedStyle(node);
  node.style.height = "auto";
  const next = textareaHeight({
    scrollHeight: node.scrollHeight,
    borders: px(style.borderTopWidth) + px(style.borderBottomWidth),
    paddings: px(style.paddingTop) + px(style.paddingBottom),
    borderBox: style.boxSizing === "border-box",
    viewportHeight: window.innerHeight
  });
  node.style.height = `${next.height}px`;
  node.style.overflowY = next.scroll ? "auto" : "hidden";
  // Пока высота была «auto», прокрученное окно могло съехать: возвращаем, где было.
  for (const [element, top] of scrolled) element.scrollTop = top;
  if (page && page.scrollTop !== pageTop) page.scrollTop = pageTop;
}

/** Обычный textarea, который растёт под текст: всё написанное видно без прокрутки внутри поля. */
export const AutoTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<"textarea">>(
  function AutoTextarea({ onInput, style, ...props }, forwardedRef) {
    const node = React.useRef<HTMLTextAreaElement | null>(null);
    const setNode = React.useCallback((element: HTMLTextAreaElement | null) => {
      node.current = element;
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    }, [forwardedRef]);

    useIsoLayoutEffect(() => {
      if (node.current) fitTextareaHeight(node.current);
    }, [props.value, props.defaultValue]);

    React.useEffect(() => {
      const element = node.current;
      if (!element) return undefined;
      let cancelled = false;
      void document.fonts?.ready.then(() => {
        if (!cancelled) fitTextareaHeight(element);
      });
      if (typeof ResizeObserver === "undefined") return () => { cancelled = true; };
      let width = element.clientWidth;
      let frame = 0;
      // Высоту меняем на следующем кадре, а не внутри колбэка: иначе браузер пишет в консоль «ResizeObserver loop».
      const observer = new ResizeObserver(() => {
        if (element.clientWidth === width) return;
        width = element.clientWidth;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => fitTextareaHeight(element));
      });
      observer.observe(element);
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }, []);

    return (
      <textarea
        {...props}
        onInput={(event) => {
          fitTextareaHeight(event.currentTarget);
          onInput?.(event);
        }}
        ref={setNode}
        // Высота и так под текст: ручное уменьшение только прятало бы строки.
        style={{ resize: "none", ...style }}
      />
    );
  }
);
