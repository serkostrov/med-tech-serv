import { readFile } from "node:fs/promises";

/**
 * Образец заказчика «история прибора» лежит рядом с репозиторием, в папке входящих
 * материалов, и в репозиторий не копируется: это настоящие данные клиники.
 * Путь можно задать переменной окружения MEDTECH_IMPORT_SAMPLE.
 */
export const CUSTOMER_SAMPLE_PATH = new URL(
  "../../incoming/tz/МедТехСервис ТЗ/МЕДТЕХСЕРВИС_—_пакет_разработки_zip_·_Образец_—_история_прибора.xlsx",
  import.meta.url
);

/** Книга образца или undefined, если файла нет (тогда проверка на нём пропускается). */
export async function customerSampleWorkbook(): Promise<Uint8Array | undefined> {
  const configured = process.env.MEDTECH_IMPORT_SAMPLE;
  const source = configured ? new URL(configured, "file:///") : CUSTOMER_SAMPLE_PATH;
  try {
    return new Uint8Array(await readFile(source));
  } catch {
    return undefined;
  }
}
