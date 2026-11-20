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
    // Снизу оставляем ровно нижний отступ страницы. Раньше вычитали 20 px при отступе 28 px: страница
    // выходила на 8 px длиннее окна, справа стояла полоса прокрутки и всё сдвигалось на пару пикселей (20.11).
    const fit = () => {
      if (window.innerWidth <= 760) { board.style.height = ""; return; }
      const shell = document.querySelector<HTMLElement>(".main-shell");
      const top = board.getBoundingClientRect().top + (shell?.scrollTop ?? window.scrollY);
      const content = board.closest(".main-content");
      const gap = content ? Number.parseFloat(window.getComputedStyle(content).paddingBottom) || 0 : 20;
      const height = Math.max(360, Math.floor(window.innerHeight - top - gap));
      board.style.height = `${height}px`;
      // Если под доской есть ещё отступы обёрток — убираем и их, чтобы страница не прокручивалась.
      const extra = shell ? shell.scrollHeight - shell.clientHeight : 0;
      if (extra > 0 && extra < 60 && height - extra >= 360) board.style.height = `${height - extra}px`;
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
    // Полоса прокрутки колонки видна, только пока листают карточки, и гаснет через секунду
    // (20.11: «должен появляться только в момент, когда я скроллю, а не просто по умолчанию стоять»).
    const fading = new Map<HTMLElement, number>();
    const showColumnBar = (event: Event) => {
      const cards = event.target;
      if (!(cards instanceof HTMLElement) || !cards.classList.contains("task-board__cards")) return;
      cards.dataset.scrolling = "";
      window.clearTimeout(fading.get(cards));
      fading.set(cards, window.setTimeout(() => { delete cards.dataset.scrolling; fading.delete(cards); }, 1000));
    };
    board.addEventListener("scroll", showColumnBar, { capture: true, passive: true });
    board.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("resize", fit);
    // Колонки появляются и пропадают («Закрытые и отменённые»), карточки догружаются.
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(board);
    const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(update);
    mutations?.observe(board, { childList: true });
    return () => {
      board.removeEventListener("scroll", showColumnBar, { capture: true });
      fading.forEach((timer) => window.clearTimeout(timer));
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
