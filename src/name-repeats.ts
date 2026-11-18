/**
 * Упрощение экранов (встреча 18.11: «дублирующая информация, давайте упростим»).
 * Название организации часто повторяет площадку: «ГБУЗ НО „НОКБ им. Н. А. Семашко“» рядом
 * с «НОКБ им. Н. А. Семашко, КДЛ». Такую вторую строку не показываем.
 */
function normalize(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/[«»"„“”'`]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Главная часть названия: то, что в кавычках, иначе всё название. */
function core(value: string): string {
  const quoted = /[«"„]([^»"“”]+)[»"“”]/u.exec(value)?.[1];
  return normalize(quoted ?? value);
}

/** Вторая строка повторяет первую: совпадает или её главная часть уже есть в первой. */
export function nameRepeats(second: string | undefined | null, first: string | undefined | null): boolean {
  if (!second || !first) return false;
  const a = normalize(second);
  const b = normalize(first);
  if (a === b) return true;
  const main = core(second);
  if (main.length >= 4 && b.includes(main)) return true;
  // «ГКБ № 1 им. Н. И. Пирогова ДЗМ» и «ГКБ № 1 им. Н. И. Пирогова, КДЛ»: почти все слова те же.
  const words = (value: string) => value.split(/[\s,.;:()]+/u).filter((word) => word.length > 0);
  const mainWords = words(main);
  const firstWords = new Set(words(b));
  if (mainWords.length < 2) return false;
  const shared = mainWords.filter((word) => firstWords.has(word)).length;
  return shared / mainWords.length >= 0.75;
}
