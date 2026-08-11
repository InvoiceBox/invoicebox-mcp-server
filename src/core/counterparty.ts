export type CustomerType = 'legal' | 'private';

const LEGAL_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const PERSON_WEIGHTS_11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const PERSON_WEIGHTS_12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

function digitsOf(value: string): number[] | null {
  return /^\d+$/.test(value) ? [...value].map(Number) : null;
}

function checksum(digits: readonly number[], weights: readonly number[]): number {
  const sum = weights.reduce((acc, weight, index) => acc + weight * (digits[index] ?? 0), 0);
  return (sum % 11) % 10;
}

export function isValidInn(value: string): boolean {
  const digits = digitsOf(value);
  if (!digits) return false;

  if (digits.length === 10) {
    return checksum(digits, LEGAL_WEIGHTS) === digits[9];
  }
  if (digits.length === 12) {
    return checksum(digits, PERSON_WEIGHTS_11) === digits[10] && checksum(digits, PERSON_WEIGHTS_12) === digits[11];
  }
  return false;
}

export function isValidKpp(value: string): boolean {
  return /^\d{4}[\dA-Z]{2}\d{3}$/.test(value);
}

export interface CustomerDraft {
  type?: CustomerType;
  name?: string;
  vatNumber?: string;
  taxRegistrationReasonCode?: string;
  registrationAddress?: string;
  email?: string;
  phone?: string;
}

export interface CustomerReview {
  problems: string[];
  warnings: string[];
}

/**
 * Поля покупателя необязательны в контракте, поэтому расхождения делятся на две
 * группы: противоречия (отказ) и нехватку данных для документов (предупреждение).
 * Значения type — только legal и private: /docs/merchant/order/create/#customer
 */
export function reviewCustomer(customer: CustomerDraft): CustomerReview {
  const problems: string[] = [];
  const warnings: string[] = [];
  const type = customer.type ?? 'legal';

  if (customer.vatNumber !== undefined && !isValidInn(customer.vatNumber)) {
    problems.push(`ИНН ${customer.vatNumber} не проходит проверку контрольной суммы`);
  }
  if (customer.taxRegistrationReasonCode !== undefined && !isValidKpp(customer.taxRegistrationReasonCode)) {
    problems.push(`КПП ${customer.taxRegistrationReasonCode} не похож на КПП: девять знаков, первые четыре — цифры`);
  }

  if (type === 'private') {
    if (customer.taxRegistrationReasonCode !== undefined) {
      problems.push('у физлица КПП не бывает: уберите taxRegistrationReasonCode или укажите type = legal');
    }
    if (!customer.name && !customer.email && !customer.phone) {
      warnings.push('у физлица нет ни имени, ни почты, ни телефона — чек будет некуда отправить');
    }
    return { problems, warnings };
  }

  const isEntrepreneur = customer.vatNumber !== undefined && customer.vatNumber.length === 12;
  if (isEntrepreneur && customer.taxRegistrationReasonCode !== undefined) {
    problems.push('ИНН из двенадцати цифр принадлежит ИП, а у ИП нет КПП');
  }

  if (!customer.name) warnings.push('без наименования покупателя документы придётся исправлять');
  if (!customer.vatNumber) warnings.push('без ИНН закрывающие документы не сформируются — уйдёт только чек');
  if (!isEntrepreneur && !customer.taxRegistrationReasonCode) {
    warnings.push('у юрлица без КПП счёт-фактура и УПД неполные');
  }
  if (!customer.registrationAddress) warnings.push('без юридического адреса комплект документов неполный');

  return { problems, warnings };
}
