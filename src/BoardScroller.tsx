import React, { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Обёртка доски: стрелки «‹ ›» по краям, когда колонки не помещаются (просьба 17.11:
 * «скролла внизу нет, не понимаю, как листать»). На Mac полоса прокрутки прячется,
 * а мышью без тачпада вбок не пролистать — стрелки работают везде.
 */
export function BoardScroller({ children }: { readonly children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const board = wrap.current?.querySelector<HTMLElement>(".task-board");
    if (!board) return undefined;
    // Доска тянется до низа окна (17.11: «надо вниз продлить»): на высоком экране под ней не остаётся пустоты.
    const fit = () => {
      if (window.innerWidth <= 760) { board.style.height = ""; return; }
      const top = board.getBoundingClientRect().top + (document.querySelector(".main-shell")?.scrollTop ?? window.scrollY);
      board.style.height = `${Math.max(360, Math.round(window.innerHeight - top - 20))}px`;
    };
    fit();
    // Над доской могут появиться плашки (счётчики, отбор из отчёта): верх доски сдвинется — пересчитываем высоту.
    const page = document.querySelector(".main-shell") ?? document.body;
    let fitting = false;
    const refit = () => { if (fitting) return; fitting = true; window.requestAnimationFrame(() => { fit(); fitting = false; }); };
    const layout = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(refit);
    // Панель «Фильтры» открывается и закрывается атрибутом hidden, без новых элементов: без attributeFilter
    // доска оставалась низкой после закрытия панели и обрывалась на середине экрана (встреча 19.11).
    layout?.observe(page, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });
    const update = () => {
      const left = board.scrollLeft > 4;
      const right = board.scrollLeft + board.clientWidth < board.scrollWidth - 4;
      setEdges((current) => current.left === left && current.right === right ? current : { left, right });
    };
    update();
    board.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("resize", fit);
    // Колонки появляются и пропадают («Закрытые и отменённые»), карточки догружаются.
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(board);
    const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(update);
    mutations?.observe(board, { childList: true });
    return () => {
      board.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("resize", fit);
      resize?.disconnect();
      layout?.disconnect();
      mutations?.disconnect();
    };
  }, []);

  const scroll = (direction: -1 | 1) => {
    const board = wrap.current?.querySelector<HTMLElement>(".task-board");
    if (!board) return;
    board.scrollBy({ left: direction * Math.max(260, Math.round(board.clientWidth * 0.75)), behavior: "smooth" });
  };

  return <div className="board-scroller" ref={wrap}>
    {children}
    {edges.left ? <button aria-label="Пролистать доску влево" className="board-scroller__button board-scroller__button--left" onClick={() => scroll(-1)} title="Пролистать влево" type="button">‹</button> : null}
    {edges.right ? <button aria-label="Пролистать доску вправо" className="board-scroller__button board-scroller__button--right" onClick={() => scroll(1)} title="Пролистать вправо" type="button">›</button> : null}
  </div>;
}
