/** Подмножество ОКЕИ для парного поля measure/measureCode: /docs/dictionary/okei/ */
const UNITS: ReadonlyArray<{ code: string; measure: string }> = [
  { code: '796', measure: 'шт' },
  { code: '006', measure: 'м' },
  { code: '003', measure: 'мм' },
  { code: '004', measure: 'см' },
  { code: '008', measure: 'км' },
  { code: '018', measure: 'пог. м' },
  { code: '055', measure: 'м2' },
  { code: '113', measure: 'м3' },
  { code: '112', measure: 'л' },
  { code: '163', measure: 'г' },
  { code: '166', measure: 'кг' },
  { code: '168', measure: 'т' },
  { code: '356', measure: 'ч' },
  { code: '359', measure: 'сут' },
  { code: '362', measure: 'мес' },
  { code: '366', measure: 'год' },
  { code: '704', measure: 'компл' },
  { code: '736', measure: 'рул' },
  { code: '778', measure: 'упак' },
  { code: '839', measure: 'компл' },
];

const BY_CODE = new Map(UNITS.map((unit) => [unit.code, unit.measure]));
const BY_MEASURE = new Map(UNITS.map((unit) => [normalize(unit.measure), unit.code]));

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
}

export function measureByCode(code: string): string | undefined {
  return BY_CODE.get(code.padStart(3, '0'));
}

export function codeByMeasure(measure: string): string | undefined {
  return BY_MEASURE.get(normalize(measure));
}

export interface UnitPair {
  measure: string;
  measureCode: string;
}

/** Достаточно одного поля: парное сервер заполняет сам по справочнику. */
export function resolveUnit(input: { measure?: string; measureCode?: string }): UnitPair | { problem: string } {
  const { measure, measureCode } = input;

  if (measure && measureCode) {
    const expected = codeByMeasure(measure);
    if (expected && expected !== measureCode.padStart(3, '0')) {
      return {
        problem: `единица «${measure}» по ОКЕИ имеет код ${expected}, а передан ${measureCode}`,
      };
    }
    return { measure, measureCode: measureCode.padStart(3, '0') };
  }

  if (measureCode) {
    const known = measureByCode(measureCode);
    if (!known) return { problem: `код единицы измерения ${measureCode} не из справочника ОКЕИ` };
    return { measure: known, measureCode: measureCode.padStart(3, '0') };
  }

  if (measure) {
    const code = codeByMeasure(measure);
    if (!code) {
      return {
        problem: `единица «${measure}» не найдена в справочнике — передайте measureCode по ОКЕИ`,
      };
    }
    return { measure, measureCode: code };
  }

  return { problem: 'не указана единица измерения: нужно measure или measureCode' };
}
