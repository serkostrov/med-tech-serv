/**
 * Счётчик запросов к серверу для полосы загрузки сверху экрана.
 * Каждый запрос увеличивает счётчик, по завершении уменьшает; экран подписывается на изменения.
 */
type Listener = (active: number) => void;

let active = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(active);
}

export function trackRequest<T>(request: Promise<T>): Promise<T> {
  active += 1;
  emit();
  return request.finally(() => {
    active = Math.max(0, active - 1);
    emit();
  });
}

export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  listener(active);
  return () => { listeners.delete(listener); };
}
