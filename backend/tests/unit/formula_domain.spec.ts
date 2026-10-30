import { test } from '@japa/runner'
import {
  computeFormulaValues,
  evaluateFormula,
  parseFormula,
  scaledOf,
} from '#dynamic/metadata/domain/formula'
import { normalizeFields } from '#dynamic/metadata/domain/field_spec'
import type { Issue } from '#dynamic/metadata/domain/field_types'
import { validateRecordData } from '#dynamic/metadata/domain/record'

const run = (source: string, values: Record<string, unknown> = {}, scale = 2) => {
  const parsed = parseFormula(source)
  if (!parsed.ok) throw new Error(parsed.message)
  return evaluateFormula(parsed.ast, (code) => scaledOf(values[code]), scale)
}

const fieldsOf = (...defs: Record<string, unknown>[]) => {
  const issues: Issue[] = []
  const specs = normalizeFields(defs, issues)
  return { specs, issues }
}
const number = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  label: code,
  type: 'NUMBER',
  ...extra,
})
const decimal = (code: string) => ({
  code,
  label: code,
  type: 'DECIMAL',
  validation: { precision: 12, scale: 2 },
})
const formula = (code: string, expression: string, extra: Record<string, unknown> = {}) => ({
  code,
  label: code,
  type: 'FORMULA',
  validation: { expression, scale: 2 },
  ...extra,
})

test.group('fórmulas | gramática e aritmética exacta', () => {
  test('aritmética em ponto fixo: sem erros de vírgula flutuante e com arredondamento', ({
    assert,
  }) => {
    assert.equal(run('0.1 + 0.2'), '0.30')
    assert.equal(run('a * b', { a: 3, b: '19.99' }), '59.97')
    assert.equal(run('a / b', { a: 1, b: 3 }, 4), '0.3333')
    assert.equal(run('round(a, 1)', { a: '2.25' }, 1), '2.3') // meio afastado de zero
    assert.equal(run('round(a, 0)', { a: '-2.5' }, 0), '-3')
    assert.equal(run('-a + abs(b)', { a: 5, b: -7 }), '2.00')
    assert.equal(run('max(a, b, 3) - min(a, b)', { a: 1, b: 9 }), '8.00')
    assert.equal(run('(1 + 2) * 3'), '9.00')
    assert.equal(run('a - 5', { a: 2 }), '-3.00')
    assert.equal(run('a - 5', { a: 5 }), '0.00') // nunca «-0.00»
  })

  test('nulos e divisão por zero dão vazio, nunca zero', ({ assert }) => {
    assert.isNull(run('a + b', { a: 1 }))
    assert.isNull(run('a / b', { a: 1, b: 0 }))
    assert.isNull(run('a / (b - b)', { a: 1, b: '3.5' }))
    assert.isNull(run('max(a, b)', { a: 1 }))
    assert.isNull(run('a * 99999999999999999', { a: '99999999999' })) // fora de 19 dígitos
  })

  test('gramática: só os símbolos permitidos; nada é executável', ({ assert }) => {
    for (const bad of [
      '',
      '1 +',
      '(1',
      'a b',
      'eval(a)',
      'a.b',
      'a; b',
      "'x'",
      'a ** b',
      'sqrt(a)',
      'round(a)',
      'round(a, 1.5)',
      'round(a, 11)',
      'abs(a, b)',
      'min(a)',
      '1abc',
      '__proto__ + 1',
    ]) {
      assert.isFalse(parseFormula(bad).ok, bad)
    }
    const parsed = parseFormula('a * (b + c) - round(d, 2)')
    assert.isTrue(parsed.ok)
    if (parsed.ok) assert.sameMembers(parsed.refs, ['a', 'b', 'c', 'd'])
  })

  test('o custo é limitado: fórmulas gigantes e aninhamento excessivo são recusados', ({
    assert,
  }) => {
    assert.isFalse(parseFormula(Array.from({ length: 80 }, () => '1').join(' + ')).ok)
    assert.isFalse(parseFormula(`${'('.repeat(40)}1${')'.repeat(40)}`).ok)
    assert.isFalse(parseFormula('1' + ' + 1'.repeat(300)).ok)
    assert.isFalse(parseFormula(`${'-'.repeat(60)}1`).ok)
  })

  test('o orçamento de elementos é exacto: no limite passa, acima falha com a mensagem do custo', ({
    assert,
  }) => {
    const atLimit = Array.from({ length: 33 }, () => 'a').join(' + ')
    assert.isTrue(parseFormula(atLimit).ok)
    const beyond = parseFormula(Array.from({ length: 120 }, () => 'a').join(' + '))
    assert.isFalse(beyond.ok)
    if (!beyond.ok) assert.include(beyond.message, 'demasiado complexa')
  })
})

test.group('fórmulas | campos, dependências e ciclos', () => {
  test('um campo fórmula é só de leitura, não obrigatório e sem valor por omissão; a árvore é guardada', ({
    assert,
  }) => {
    const { specs, issues } = fieldsOf(
      number('qtd'),
      decimal('preco'),
      formula('total', 'qtd * preco')
    )
    assert.isEmpty(issues)
    const total = specs[2]
    assert.isTrue(total.readOnly)
    assert.deepInclude(total.validation, { expression: 'qtd * preco', scale: 2 })
    assert.sameMembers(total.validation.dependencies as string[], ['qtd', 'preco'])
    assert.property(total.validation, 'ast')
    const bad = fieldsOf(
      number('qtd'),
      formula('total', 'qtd', { required: true, defaultValue: '1' })
    )
    assert.sameMembers(
      bad.issues.map((i) => i.code),
      ['FORMULA_REQUIRED', 'DEFAULT_NOT_ALLOWED']
    )
  })

  test('referências inexistentes, não numéricas, ciclos e fuga de dados sensíveis são recusados', ({
    assert,
  }) => {
    const codes = (...defs: Record<string, unknown>[]) =>
      fieldsOf(...defs).issues.map((i) => `${i.path}:${i.code}`)
    const expr = 'validation.expression'
    assert.include(
      codes(number('alfa'), formula('tot', 'alfa + zz')),
      `fields[1].${expr}:FORMULA_UNKNOWN_FIELD`
    )
    assert.include(
      codes({ code: 'nome', label: 'n', type: 'TEXT' }, formula('tot', 'nome + 1')),
      `fields[1].${expr}:FORMULA_NOT_NUMERIC`
    )
    assert.include(codes(formula('tot', 'tot + 1')), `fields[0].${expr}:CIRCULAR_FORMULA`)
    assert.includeMembers(
      codes(number('alfa'), formula('xx', 'yy + alfa'), formula('yy', 'xx * 2')),
      [`fields[1].${expr}:CIRCULAR_FORMULA`, `fields[2].${expr}:CIRCULAR_FORMULA`]
    )
    assert.include(
      codes(number('salario', { sensitive: true }), formula('bonus', 'salario * 0.1')),
      `fields[1].${expr}:FORMULA_LEAKS_SENSITIVE`
    )
    assert.isEmpty(
      codes(
        number('salario', { sensitive: true }),
        formula('bonus', 'salario * 0.1', { sensitive: true })
      )
    )
    assert.include(
      codes(number('alfa'), formula('tot', '1 +')),
      `fields[1].${expr}:INVALID_FORMULA`
    )
    assert.include(
      codes(
        number('alfa'),
        formula('tot', 'alfa', { validation: { expression: 'alfa', scale: 11 } })
      ),
      'fields[1].validation.scale:INVALID_VALIDATION'
    )
  })

  test('as fórmulas calculam-se em cadeia, pela ordem das dependências', ({ assert }) => {
    const { specs } = fieldsOf(
      number('qtd'),
      decimal('preco'),
      formula('liquido', 'total - desconto'),
      formula('total', 'qtd * preco'),
      decimal('desconto')
    )
    const values = computeFormulaValues(specs, { qtd: 3, preco: '10.00', desconto: '5.50' })
    assert.deepEqual(values, { total: '30.00', liquido: '24.50' })
  })

  test('um registo: o cliente não escreve fórmulas; o resultado acompanha as alterações e apaga-se se faltar um valor', ({
    assert,
  }) => {
    const { specs } = fieldsOf(number('qtd'), decimal('preco'), formula('total', 'qtd * preco'))
    const created = validateRecordData(specs, { qtd: 3, preco: '10' }, null)
    assert.isEmpty(created.issues)
    assert.equal(created.values.total, '30.00')
    const forged = validateRecordData(specs, { qtd: 3, preco: '10', total: '1.00' }, null)
    assert.deepEqual(
      forged.issues.map((i) => `${i.path}:${i.code}`),
      ['data.total:READ_ONLY']
    )
    const changed = validateRecordData(specs, { qtd: 4 }, created.values)
    assert.equal(changed.values.total, '40.00')
    const cleared = validateRecordData(specs, { preco: null }, created.values)
    assert.notProperty(cleared.values, 'total')
  })
})
