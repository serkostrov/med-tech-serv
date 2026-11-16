/**
 * Реквизиты плательщика: ИНН и КПП.
 *
 * Проверку держит база (миграция 0036), здесь то же правило, чтобы человек увидел отказ
 * в форме, а не после запроса. ИНН — 10 цифр у организации или 12 у предпринимателя,
 * с контрольными цифрами. КПП — 9 знаков: четыре цифры инспекции, два знака причины
 * постановки (цифры или заглавные латинские буквы у иностранных организаций), три цифры
 * номера. Пустое значение значит «реквизитов нет» и проверку проходит.
 */

const INN_WEIGHTS_10: readonly number[] = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_WEIGHTS_11: readonly number[] = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_WEIGHTS_12: readonly number[] = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function controlDigit(digits: string, weights: readonly number[]): number {
  const total = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0);
  return (total % 11) % 10;
}

/** Верен ли ИНН: длина и контрольные цифры. Пустая строка верной не считается. */
export function isValidInn(value: string): boolean {
  const digits = value.trim();
  if (!/^\d+$/u.test(digits)) return false;
  if (digits.length === 10) return controlDigit(digits, INN_WEIGHTS_10) === Number(digits[9]);
  if (digits.length === 12) {
    return controlDigit(digits, INN_WEIGHTS_11) === Number(digits[10])
      && controlDigit(digits, INN_WEIGHTS_12) === Number(digits[11]);
  }
  return false;
}

/** Верен ли КПП: 9 знаков в принятом формате. Пустая строка верной не считается. */
export function isValidKpp(value: string): boolean {
  return /^\d{4}[0-9A-Z]{2}\d{3}$/u.test(value.trim());
}

/** Отказ по реквизитам словами или пусто, если всё в порядке. */
export function requisitesRefusal(input: { readonly inn?: string; readonly kpp?: string }): string | null {
  const inn = (input.inn ?? "").trim();
  const kpp = (input.kpp ?? "").trim();
  if (inn && !isValidInn(inn)) {
    return `ИНН «${inn}» не похож на настоящий: у организации 10 цифр, у предпринимателя 12, и номер должен сойтись с собственной контрольной суммой`;
  }
  if (kpp && !isValidKpp(kpp)) {
    return `КПП «${kpp}» не похож на настоящий: нужно 9 знаков, например 773601001`;
  }
  if (kpp && !inn) return "КПП без ИНН не бывает: укажите ИНН или уберите КПП";
  return null;
}

/** Тот же отказ исключением: для места, где нечего показать рядом с полем. */
export function assertRequisites(input: { readonly inn?: string; readonly kpp?: string }): void {
  const refusal = requisitesRefusal(input);
  if (refusal) throw new Error(refusal);
}
