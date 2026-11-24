import { test } from '@japa/runner'
import {
  computeTaxes,
  formatFiscalNumber,
  issueDateIssue,
  normalizeRate,
  normalizeSeries,
  normalizeTaxCode,
} from '#modules/sales/domain/fiscal'

const paths = (issues: { path: string }[]) => issues.map((i) => i.path)
// Valores ilustrativos de teste: não são taxas legais.
const T = (rate: string, kind: 'TAX' | 'WITHHOLDING' = 'TAX', minBase: string | null = null) => ({
  codeId: `${kind}-${rate}`,
  code: kind === 'TAX' ? 'T' : 'R',
  kind,
  rate,
  minBase,
  exemptionCode: null,
})

test.group('Vendas | motor fiscal — regras (10.5)', () => {
  test('validação: fonte legal obrigatória, taxa exacta, séries só em simulação', ({ assert }) => {
    assert.includeMembers(paths(normalizeTaxCode({}, true).issues), [
      'countryCode',
      'code',
      'name',
      'kind',
      'taxType',
    ])
    assert.includeMembers(
      paths(normalizeRate({ rate: '10.12345', validFrom: '2026-01-01' }, true).issues),
      ['rate', 'legalSource']
    )
    assert.include(
      paths(
        normalizeRate({ rate: '101', validFrom: 'x', legalSource: 'Diploma X, art. 1' }, true)
          .issues
      ),
      'rate'
    )
    assert.equal(
      normalizeRate(
        { rate: '7,5', validFrom: '2026-01-01', legalSource: 'Diploma X, art. 1' },
        true
      ).v.rate,
      '7.5000'
    )
    assert.include(paths(normalizeSeries({ mode: 'PRODUCTION' }, false).issues), 'mode')
    assert.includeMembers(paths(normalizeSeries({}, true).issues), [
      'legalEntityId',
      'documentKind',
      'fiscalCode',
      'code',
      'fiscalYear',
      'prefix',
    ])
  })

  test('sequência: formato e data de emissão cronológica dentro do ano', ({ assert }) => {
    assert.equal(formatFiscalNumber('FT A/', 7, 4), 'FT A/0007')
    assert.isNull(issueDateIssue('2026-03-01', '2026-02-28', 2026))
    assert.isNull(issueDateIssue('2026-03-01', '2026-03-01', 2026))
    assert.match(issueDateIssue('2026-02-27', '2026-02-28', 2026)!, /não pode recuar/)
    assert.match(issueDateIssue('2027-01-01', null, 2026)!, /2026/)
  })

  test('arredondamento por linha e por documento dão o mesmo total quando não há meios cêntimos', ({
    assert,
  }) => {
    const lines = [
      { key: 'a', netAmount: '100.00', taxes: [T('10')] },
      { key: 'b', netAmount: '50.00', taxes: [T('10')] },
    ]
    const line = computeTaxes(lines, 'LINE')
    const doc = computeTaxes(lines, 'DOCUMENT')
    assert.deepEqual(line.totals, {
      net: '150.00',
      tax: '15.00',
      gross: '165.00',
      withholding: '0.00',
      payable: '165.00',
    })
    assert.deepEqual(doc.totals, line.totals)
  })

  test('meios cêntimos: por linha arredonda cada linha, por documento uma vez', ({ assert }) => {
    // 3 linhas de 0,05 a 10 %: 0,005 cada → linha: 0,01 × 3 = 0,03; documento: 0,015 → 0,02.
    const lines = ['a', 'b', 'c'].map((key) => ({ key, netAmount: '0.05', taxes: [T('10')] }))
    assert.equal(computeTaxes(lines, 'LINE').totals.tax, '0.03')
    assert.equal(computeTaxes(lines, 'DOCUMENT').totals.tax, '0.02')
    assert.equal(computeTaxes(lines, 'DOCUMENT').lines[0].taxes[0].amount, '0.005000')
    // Vários impostos na mesma linha, com resumo por imposto e taxa.
    const multi = computeTaxes(
      [{ key: 'x', netAmount: '1000.00', taxes: [T('10'), { ...T('1'), codeId: 'S', code: 'S' }] }],
      'LINE'
    )
    assert.deepEqual(
      multi.summary.map((r) => [r.code, r.base, r.amount]),
      [
        ['T', '1000.00', '100.00'],
        ['S', '1000.00', '10.00'],
      ]
    )
  })

  test('retenção: sobre a base do documento, só a partir da base mínima', ({ assert }) => {
    const lines = [
      { key: 'a', netAmount: '30000.00', taxes: [T('10'), T('5', 'WITHHOLDING', '50000.00')] },
      { key: 'b', netAmount: '25000.00', taxes: [T('10'), T('5', 'WITHHOLDING', '50000.00')] },
    ]
    const r = computeTaxes(lines, 'LINE')
    assert.deepEqual(r.totals, {
      net: '55000.00',
      tax: '5500.00',
      gross: '60500.00',
      withholding: '2750.00',
      payable: '57750.00',
    })
    const below = computeTaxes([lines[0]], 'LINE')
    assert.equal(below.totals.withholding, '0.00')
    assert.isFalse(below.summary.find((x) => x.kind === 'WITHHOLDING')!.applied)
  })
})
