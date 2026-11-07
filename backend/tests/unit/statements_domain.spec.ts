import { test } from '@japa/runner'
import {
  computeLines,
  lineFor,
  type Mapping,
  parseFormula,
  type TemplateLine,
  validateTemplate,
} from '#modules/accounting/domain/statements'

const line = (code: string | null, kind: TemplateLine['kind'], extra: Partial<TemplateLine> = {}) =>
  ({
    lineNo: 0,
    code,
    label: code ?? 'Título',
    kind,
    sign: 1,
    formula: null,
    noteRef: null,
    ...extra,
  }) as TemplateLine

test.group('contabilidade | demonstrações (puro)', () => {
  test('fórmulas: soma e subtracção de códigos; sintaxe inválida é recusada', ({ assert }) => {
    assert.deepEqual(parseFormula('A1 + A2 - B.3'), [
      { code: 'A1', sign: 1 },
      { code: 'A2', sign: 1 },
      { code: 'B.3', sign: -1 },
    ])
    assert.deepEqual(parseFormula('-A1'), [{ code: 'A1', sign: -1 }])
    assert.isNull(parseFormula(''))
    assert.isNull(parseFormula('A1*A2'))
    assert.isNull(parseFormula('A1 A2'))
  })

  test('cada conta vai para a linha do prefixo mais longo que aceita o sinal do saldo', ({
    assert,
  }) => {
    const maps: Mapping[] = [
      { lineCode: 'CAIXA', prefix: '11', rule: 'ANY' },
      { lineCode: 'BANCO', prefix: '113', rule: 'DEBIT' },
      { lineCode: 'DESCOBERTO', prefix: '113', rule: 'CREDIT' },
    ]
    assert.equal(lineFor('111', 500n, maps), 'CAIXA')
    assert.equal(lineFor('1131', 500n, maps), 'BANCO')
    assert.equal(lineFor('1131', -500n, maps), 'DESCOBERTO')
    assert.isNull(lineFor('21', 100n, maps))
  })

  test('validação: códigos repetidos, fórmulas com linhas inexistentes, ciclos e prefixos ambíguos', ({
    assert,
  }) => {
    const codes = (issues: { code: string }[]) => issues.map((i) => i.code)
    assert.include(
      codes(validateTemplate('BALANCE_SHEET', [line('A', 'ACCOUNTS'), line('A', 'ACCOUNTS')], [])),
      'DUPLICATE'
    )
    assert.include(
      codes(
        validateTemplate(
          'BALANCE_SHEET',
          [line('T', 'TOTAL', { formula: 'A+Z' }), line('A', 'ACCOUNTS')],
          []
        )
      ),
      'UNKNOWN_LINE'
    )
    assert.include(
      codes(
        validateTemplate(
          'BALANCE_SHEET',
          [line('T1', 'TOTAL', { formula: 'T2' }), line('T2', 'TOTAL', { formula: 'T1' })],
          []
        )
      ),
      'CYCLE'
    )
    assert.include(
      codes(
        validateTemplate(
          'BALANCE_SHEET',
          [line('A', 'ACCOUNTS'), line('B', 'ACCOUNTS')],
          [
            { lineCode: 'A', prefix: '1', rule: 'ANY' },
            { lineCode: 'B', prefix: '1', rule: 'CREDIT' },
          ]
        )
      ),
      'AMBIGUOUS'
    )
    assert.deepEqual(
      validateTemplate(
        'BALANCE_SHEET',
        [line('A', 'ACCOUNTS'), line('B', 'ACCOUNTS')],
        [
          { lineCode: 'A', prefix: '1', rule: 'DEBIT' },
          { lineCode: 'B', prefix: '1', rule: 'CREDIT' },
        ]
      ),
      []
    )
    assert.include(
      codes(validateTemplate('INCOME_STATEMENT', [line('R', 'NET_INCOME')], [])),
      'INVALID'
    )
  })

  test('valores: contas com sinal, resultado líquido e totais por fórmula', ({ assert }) => {
    const lines = [
      line('A1', 'ACCOUNTS'),
      line('TA', 'TOTAL', { formula: 'A1' }),
      line('C1', 'ACCOUNTS', { sign: -1 }),
      line('RL', 'NET_INCOME', { sign: -1 }),
      line('TC', 'TOTAL', { formula: 'C1+RL' }),
    ]
    const v = computeLines(
      lines,
      new Map([
        ['A1', 115000n],
        ['C1', -100000n],
      ]),
      -15000n
    )
    assert.equal(v.get('TA'), 115000n)
    assert.equal(v.get('C1'), 100000n)
    assert.equal(v.get('RL'), 15000n)
    assert.equal(v.get('TC'), 115000n)
  })
})
