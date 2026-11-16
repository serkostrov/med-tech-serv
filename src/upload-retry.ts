import { formatRussianCount } from "./equipment-changes.js";

/**
 * Повтор загрузки файлов.
 *
 * Инженер сдаёт работу с выезда: текст результата уходит отдельно и сохраняется,
 * а файлы идут следом и на плохой связи обрываются на полпути. Раньше про них
 * говорили «догрузите недостающие» и оставляли человека разбираться самому: какие
 * именно не дошли, он не знал. Теперь недошедшие держатся в памяти страницы,
 * названы поимённо, и их можно отправить снова одной кнопкой.
 *
 * В памяти, а не в браузерном хранилище: файл туда не положить, и притворяться,
 * что он переживёт перезагрузку, нельзя. Поэтому рядом всегда сказано, что при
 * обновлении страницы файлы придётся выбрать заново.
 */

export type UploadKind = "act" | "photo" | "video";

export interface PendingUpload {
  readonly kind: UploadKind;
  readonly file: File;
}

const KIND_WORDS: Readonly<Record<UploadKind, readonly [string, string, string]>> = {
  act: ["фото акта", "фото акта", "фото акта"],
  photo: ["фотография", "фотографии", "фотографий"],
  video: ["видео", "видео", "видео"]
};

/** Порядок разбора: сначала акт, он нужен для передачи на проверку. */
const KIND_ORDER: readonly UploadKind[] = ["act", "photo", "video"];

/** «Не загрузились 2 фотографии и 1 видео»: человеку важно, чего именно не хватает. */
export function pendingUploadsText(items: readonly { readonly kind: UploadKind }[]): string {
  if (items.length === 0) return "";
  const parts = KIND_ORDER
    .map((kind) => ({ kind, count: items.filter((item) => item.kind === kind).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => entry.kind === "act"
      ? `${entry.count === 1 ? "фото акта" : `${entry.count} фото акта`}`
      : formatRussianCount(entry.count, KIND_WORDS[entry.kind]));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}` : parts[0] ?? "";
  return `${items.length === 1 ? "Не загрузился" : "Не загрузились"} ${list}`;
}

/** Имена файлов через запятую: по ним человек понимает, что именно переотправится. */
export function pendingUploadNames(items: readonly { readonly file: { readonly name: string } }[]): string {
  return items.map((item) => item.file.name).join(", ");
}

/**
 * Что осталось после повтора: уже дошедшие убираем, остальные держим дальше.
 * Сравниваем по самому файлу, а не по имени: два снимка с одинаковым именем
 * с разных телефонов — обычное дело, и терять один из них нельзя.
 */
export function pendingAfterRetry<Item extends { readonly file: unknown }>(
  pending: readonly Item[],
  uploaded: readonly Item[]
): readonly Item[] {
  return pending.filter((item) => !uploaded.some((done) => done.file === item.file));
}
