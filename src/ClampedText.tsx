import { useLayoutEffect, useRef, useState } from "react";

/**
 * Длинный текст в строке таблицы: видны первые строки, остальное открывает «Показать полностью».
 * Ничего не теряется, а строка списка не растягивается на пол-экрана.
 */
export function ClampedText({ text, className = "" }: { readonly text: string; readonly className?: string }) {
  const node = useRef<HTMLSpanElement | null>(null);
  // Раскрыт именно этот текст: если строка получила другой текст, она снова свёрнута.
  const [openText, setOpenText] = useState<string | null>(null);
  const open = openText === text;
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = node.current;
    if (!element || open) return undefined;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <>
      <span className={open ? className : `${className} clamped-text`.trim()} ref={node}>{text}</span>
      {overflows || open ? (
        <button aria-expanded={open} className="clamped-text__toggle" onClick={() => setOpenText(open ? null : text)} type="button">
          {open ? "Свернуть" : "Показать полностью"}
        </button>
      ) : null}
    </>
  );
}
