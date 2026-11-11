/**
 * Разбор письма-заявки по форме заказчика (Блок 4 ТЗ):
 * клиент, ФИО и телефон для связи, оборудование, заводской номер, описание.
 * Письма приходят в свободной форме, поэтому ищем поля по меткам в любом порядке.
 * Этот разбор работает без нейросети; нейросеть (если подключена) дополняет его.
 */

export interface MailRequestDraft {
  readonly client?: string;
  readonly contactName?: string;
  readonly contactPhone?: string;
  readonly equipmentName?: string;
  readonly serialNumber?: string;
  readonly description?: string;
  readonly engineerName?: string;
  readonly partNumbers?: readonly string[];
}

export interface ParsedMailRequest {
  readonly draft: MailRequestDraft;
  /** 0..1: насколько уверенно заполнен черновик. */
  readonly confidence: number;
  readonly source: "rules" | "ai" | "rules+ai";
}

const LABELS: ReadonlyArray<{ readonly field: keyof MailRequestDraft; readonly patterns: readonly RegExp[] }> = [
  { field: "client", patterns: [/^(?:наименование\s+)?(?:клиент[а-я]*|заказчик[а-я]*|организаци[а-я]*|учреждени[а-я]*|больниц[а-я]*|лпу)\s*[:\-–—]\s*(.+)$/iu] },
  { field: "contactName", patterns: [/^(?:ф\.?\s*и\.?\s*о\.?|контактное\s+лицо|контакт|ответственный)(?:\s+и\s+телефон)?(?:\s+для\s+обратной\s+связи)?\s*[:\-–—]\s*(.+)$/iu] },
  { field: "contactPhone", patterns: [/^(?:тел(?:ефон)?\.?|моб(?:ильный)?\.?)\s*[:\-–—]?\s*(.+)$/iu] },
  { field: "equipmentName", patterns: [/^(?:наименование\s+)?(?:оборудовани[а-я]*|прибор[а-я]*|аппарат[а-я]*|анализатор[а-я]*|модель)\s*[:\-–—]\s*(.+)$/iu] },
  { field: "serialNumber", patterns: [
    /^(?:s\s*\/\s*n|sn|с\s*\/\s*н|серийный\s+(?:номер|№)|заводской\s+(?:номер|№)|зав\.?\s*(?:номер|№)|зав\s*№)\s*[:\-–—№#]?\s*([A-Za-zА-Яа-я0-9].{2,60})$/iu
  ] },
  { field: "description", patterns: [/^(?:описание(?:\s+неисправности)?(?:\s+или\s+описание\s+работ.*?)?|неисправность|проблема|что\s+случилось|работы|причина(?:\s+обращения)?)\s*[:\-–—]\s*(.+)$/iu] },
  { field: "engineerName", patterns: [/^инженер\s*[:\-–—]\s*(.+)$/iu] }
];

const PHONE = /(?:\+7|8)[\s(\-]*\d{3}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/u;
const PART_NUMBER = /^(?:запчасть|з\/ч|деталь|артикул)\s*[:\-–—]?\s*([A-Za-z0-9][A-Za-z0-9\-\.]{3,30})/iu;
// Строки цитаты и подписи отбрасываем.
const QUOTE_START = /^(?:>|-{2,}\s*$|-----\s*original message|\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}.*(?:пишет|wrote):$|с уважением|best regards)/iu;

function clean(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/[\s.,;—–-]+$/u, "").trim();
}

function textLines(body: string): string[] {
  const lines: string[] = [];
  for (const raw of body.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.trim();
    if (QUOTE_START.test(line)) break;
    if (line) lines.push(line);
  }
  return lines;
}

/** Серийный номер: убираем хвост вида «— это поле обязательно». */
function cleanSerial(value: string): string {
  const head = value.split(/\s+[—–-]\s+|\s+это\s+|[,;(]/u)[0]!.replace(/[.,;]+$/u, "").trim();
  // Номер с пробелами («5412 HB 77») оставляем, длинный хвост слов отрезаем.
  const tokens = head.split(/\s+/u);
  return (tokens.length > 3 ? tokens[0]! : head).trim();
}

export function parseMailByRules(subject: string, body: string): ParsedMailRequest {
  const draft: Record<string, string | string[]> = {};
  const unlabeled: string[] = [];
  const parts: string[] = [];
  const lines = textLines(body);
  for (const line of lines) {
    let matched = false;
    for (const { field, patterns } of LABELS) {
      for (const pattern of patterns) {
        const match = pattern.exec(line);
        if (!match?.[1]) continue;
        const value = field === "serialNumber" ? cleanSerial(match[1]) : clean(match[1]);
        if (value && !draft[field]) draft[field] = value;
        matched = true;
        break;
      }
      if (matched) break;
    }
    const part = PART_NUMBER.exec(line);
    if (part?.[1]) { parts.push(part[1]); matched = true; }
    if (!matched) unlabeled.push(line);
  }
  // Телефон часто в строке с ФИО: «Иванов Иван, +7 921 000-00-00».
  const contact = typeof draft.contactName === "string" ? draft.contactName : undefined;
  const phoneInContact = contact ? PHONE.exec(contact)?.[0] : undefined;
  if (phoneInContact) {
    draft.contactPhone ??= clean(phoneInContact);
    draft.contactName = clean(contact!.replace(phoneInContact, "").replace(/[,;]\s*$/u, ""));
  }
  if (!draft.contactPhone) {
    const anyPhone = PHONE.exec(lines.join("\n"))?.[0];
    if (anyPhone) draft.contactPhone = clean(anyPhone);
  }
  if (typeof draft.contactPhone === "string") {
    const phone = PHONE.exec(draft.contactPhone)?.[0];
    if (phone) draft.contactPhone = clean(phone);
  }
  if (!draft.serialNumber) {
    // «S/N BJ1-58000885» внутри строки или в теме письма.
    // Только в теме и в самом письме, без цитаты прошлых писем.
    const inline = /(?:s\s*\/\s*n|sn|серийный\s+номер|заводской\s+номер|зав\.?\s*№)\s*[:№#]?\s*([A-Za-z0-9][A-Za-z0-9\-\/\.]{2,40})/iu.exec(`${subject}\n${lines.join("\n")}`);
    if (inline?.[1]) draft.serialNumber = cleanSerial(inline[1]);
  }
  if (parts.length) draft.partNumbers = parts;
  if (!draft.description) {
    const rest = unlabeled.filter((line) => !/^(?:информация\s+по\s+вашему\s+запросу|здравствуйте|добрый\s+(?:день|вечер)|доброе\s+утро|форма\s+истории)/iu.test(line));
    if (rest.length) draft.description = clean(rest.join(" ")).slice(0, 2000);
    else if (subject.trim()) draft.description = clean(subject);
  }
  let confidence = 0;
  if (draft.serialNumber) confidence += 0.4;
  if (draft.client) confidence += 0.2;
  if (draft.equipmentName) confidence += 0.15;
  if (draft.description) confidence += 0.15;
  if (draft.contactName || draft.contactPhone) confidence += 0.1;
  return { draft: draft as MailRequestDraft, confidence: Math.round(confidence * 100) / 100, source: "rules" };
}

/** Объединение: поля нейросети дополняют правила, уверенность — наибольшая обоснованная. */
export function mergeDrafts(rules: ParsedMailRequest, ai: ParsedMailRequest | undefined): ParsedMailRequest {
  if (!ai) return rules;
  const draft: Record<string, unknown> = { ...rules.draft };
  for (const [key, value] of Object.entries(ai.draft)) {
    if (value === undefined || value === null || value === "") continue;
    // Заводской номер из правил надёжнее (точная метка в письме), остальное берём у нейросети, если пусто.
    if (draft[key] === undefined || (key !== "serialNumber" && key !== "partNumbers" && String(draft[key]).length < 3)) draft[key] = value;
  }
  return { draft: draft as MailRequestDraft, confidence: Math.max(rules.confidence, ai.confidence), source: "rules+ai" };
}
