const RUSSIAN_LETTERS: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

/** Служебный код справочника или роли: латиница, без показа оператору. */
export function toTechnicalCode(name: string, existing: readonly string[] = [], fallback = "item"): string {
  const transliterated = [...name.trim().toLowerCase()].map((character) => RUSSIAN_LETTERS[character] ?? character).join("");
  let slug = transliterated.replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").replace(/_+/gu, "_");
  if (!/^[a-z]/u.test(slug)) slug = `${fallback}${slug ? `_${slug}` : ""}`.replace(/_+/gu, "_");
  slug = slug.slice(0, 64);
  if (slug.length < 2) slug = fallback.slice(0, 64);
  if (slug.length < 2) slug = "item";
  const taken = new Set(existing);
  let candidate = slug;
  let index = 2;
  while (taken.has(candidate)) {
    const suffix = `_${index}`;
    candidate = `${slug.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    index += 1;
  }
  return candidate;
}
