import { defineField } from './define-entity';
import {
  computeFormulas,
  evaluateFormula,
  formulaDependencies,
  orderFormulas,
  parseFormula,
} from './formula';

function calc(source: string, values: Record<string, number | null> = {}, scale = 2) {
  const parsed = parseFormula(source);
  if (!parsed.ok) throw new Error(parsed.message);
  return evaluateFormula(parsed.ast, (k) => values[k] ?? null, scale);
}
const message = (source: string) => {
  const parsed = parseFormula(source);
  return parsed.ok ? null : parsed.message;
};

describe('formula: aritmética exacta (sem vírgula flutuante)', () => {
  it('0,1 + 0,2 é exactamente 0,3', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // o problema que a aritmética decimal resolve
    expect(calc('a + b', { a: 0.1, b: 0.2 }, 2)).toBe(0.3);
    expect(calc('a + b', { a: 0.1, b: 0.2 }, 10)).toBe(0.3);
  });

  it('arredonda meio afastado de zero em decimal exacto (2,675 → 2,68)', () => {
    expect(Number((2.675).toFixed(2))).toBe(2.67); // o erro típico do float
    expect(calc('a', { a: 2.675 }, 2)).toBe(2.68);
    expect(calc('a', { a: -2.675 }, 2)).toBe(-2.68);
  });

  it('respeita a precedência e os parêntesis', () => {
    expect(calc('2 + 3 * 4')).toBe(14);
    expect(calc('(2 + 3) * 4')).toBe(20);
    expect(calc('10 - 2 - 3')).toBe(5);
    expect(calc('100 / 10 / 2')).toBe(5);
    expect(calc('-a + 5', { a: 2 })).toBe(3);
    expect(calc('--a', { a: 2 })).toBe(2);
  });

  it('calcula preço × quantidade − desconto sem perder cêntimos', () => {
    const v = { quantidade: 3, precoUnitario: 19.99, desconto: 0.07 };
    expect(calc('quantidade * precoUnitario - desconto', v, 2)).toBe(59.9);
    expect(calc('quantidade * precoUnitario * 1.23', v, 2)).toBe(73.76);
  });

  it('divide com arredondamento e devolve vazio na divisão por zero', () => {
    expect(calc('1 / 3', {}, 4)).toBe(0.3333);
    expect(calc('2 / 3', {}, 4)).toBe(0.6667);
    expect(calc('a / b', { a: 5, b: 0 })).toBeNull();
    expect(calc('a / (b - b)', { a: 5, b: 2 })).toBeNull();
  });

  it('suporta round, min, max e abs', () => {
    expect(calc('round(a, 1)', { a: 1.25 }, 4)).toBe(1.3);
    expect(calc('round(a, 0)', { a: -0.5 }, 0)).toBe(-1);
    expect(calc('min(a, b, 3)', { a: 5, b: 4 })).toBe(3);
    expect(calc('max(a, b)', { a: -1, b: -7 })).toBe(-1);
    expect(calc('abs(a - b)', { a: 2, b: 9 })).toBe(7);
  });

  it('um valor em falta torna o resultado vazio (nunca assume zero)', () => {
    expect(calc('a + b', { a: 1, b: null })).toBeNull();
    expect(calc('min(a, b)', { a: 1 })).toBeNull();
  });

  it('não devolve -0 nem números fora do intervalo seguro', () => {
    expect(Object.is(calc('a * 0', { a: -5 }), 0)).toBe(true);
    expect(calc('a * a', { a: 9_007_199_254 }, 0)).toBeNull();
  });

  it('lida com números de notação científica e muito pequenos', () => {
    expect(calc('a * 2', { a: 1e-7 }, 10)).toBe(0.0000002);
    expect(calc('a', { a: 1e21 }, 0)).toBeNull();
  });
});

describe('formula: análise', () => {
  it('recolhe os campos referidos, sem repetir', () => {
    const parsed = parseFormula('a * b + round(a, 2) - min(c, 1)');
    expect(parsed.ok && parsed.refs).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['', 'Indique a fórmula'],
    ['a +', 'incompleta'],
    ['a $ b', 'não permitido'],
    ['a + * b', 'inesperado'],
    ['(a + b', 'parêntese'],
    ['a + b)', 'inesperado'],
    ['foo(a)', 'Função desconhecida'],
    ['round(a)', 'round()'],
    ['round(a, b)', 'round()'],
    ['round(a, 11)', 'no máximo'],
    ['min(a)', 'pelo menos dois'],
    ['abs(a, b)', 'único valor'],
    ['2x', 'mal formado'],
    ['eval(a)', 'Função desconhecida'],
    ['a.b', 'não permitido'],
    ['a; b', 'não permitido'],
  ])('rejeita %j', (source, expected) => {
    expect(message(source)).toContain(expected);
  });

  it('limita o tamanho, a profundidade e o número de elementos', () => {
    expect(message('1' + '+1'.repeat(300))).toContain('mais de 500');
    expect(message('('.repeat(30) + '1' + ')'.repeat(30))).toContain('aninhados');
    expect(message(Array.from({ length: 60 }, () => 'a').join(' + '))).toContain('complexa');
  });

  it('não interpreta nada além da gramática (sem acesso a objectos nem código)', () => {
    for (const s of ['a.constructor', '__proto__', 'a["b"]', 'a[0]'])
      expect(message(s), s).not.toBeNull();
    // Nomes que existem em qualquer objecto JS são só referências a campos sem valor.
    for (const s of ['constructor', 'process', 'this', 'toString', 'hasOwnProperty'])
      expect(calc(s, {}), s).toBeNull();
    expect(
      computeFormulas(
        [
          defineField({
            type: 'formula',
            key: 'f',
            label: 'f',
            formula: { source: 'constructor + 1' },
            scale: 0,
          }),
        ],
        {},
      ),
    ).toEqual({ f: null });
  });
});

describe('formula: dependências e ciclos', () => {
  const f = (key: string, source: string) =>
    defineField({ type: 'formula', key, label: key, formula: { source }, scale: 2 });
  const n = (key: string) => defineField({ type: 'number', key, label: key });

  it('ordena as fórmulas pelas suas dependências', () => {
    const fields = [f('total', 'subtotal * 1.23'), f('subtotal', 'a * b'), n('a'), n('b')];
    expect(formulaDependencies(fields).get('total')).toEqual(['subtotal']);
    expect(orderFormulas(fields)).toEqual({ order: ['subtotal', 'total'], cyclic: new Set() });
  });

  it('detecta ciclos directos e indirectos', () => {
    expect(orderFormulas([f('x', 'x + 1')]).cyclic).toEqual(new Set(['x']));
    const result = orderFormulas([f('a', 'b + 1'), f('b', 'c + 1'), f('c', 'a + 1'), f('ok', '1')]);
    expect(result.cyclic).toEqual(new Set(['a', 'b', 'c']));
    expect(result.order).toEqual(['ok']);
  });

  it('calcula em cadeia e deixa as fórmulas em ciclo vazias', () => {
    const fields = [f('total', 'subtotal * 2'), f('subtotal', 'a * b'), n('a'), n('b')];
    expect(computeFormulas(fields, { a: 2, b: 3.5 })).toEqual({ subtotal: 7, total: 14 });
    expect(computeFormulas(fields, { a: 2 })).toEqual({ subtotal: null, total: null });
    expect(computeFormulas([f('x', 'y'), f('y', 'x')], {})).toEqual({ x: null, y: null });
  });
});
