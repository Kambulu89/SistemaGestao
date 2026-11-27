import { test } from '@japa/runner'
import {
  addMonths,
  effectiveVersion,
  normalizeVersion,
  period,
  withinContract,
} from '#modules/sales/domain/recurring'

const P = '00000000-0000-4000-8000-000000000001'
const T = '00000000-0000-4000-8000-000000000002'

test.group('Vendas | recorrência — regras (10.11)', () => {
  test('meses sem deriva de fim de mês e períodos a partir do início', ({ assert }) => {
    assert.deepEqual(
      [
        addMonths('2026-01-31', 1),
        addMonths('2026-01-31', 2),
        addMonths('2024-01-31', 1),
        addMonths('2026-11-15', 3),
      ],
      ['2026-02-28', '2026-03-31', '2024-02-29', '2027-02-15']
    )
    const p1 = period('2026-01-31', 'MONTHLY', 1, 'ADVANCE')
    assert.deepEqual(
      [p1.periodStart, p1.periodEnd, p1.invoiceDate],
      ['2026-02-28', '2026-03-30', '2026-02-28']
    )
    const q = period('2026-01-01', 'QUARTERLY', 3, 'ARREARS')
    assert.deepEqual(
      [q.periodStart, q.periodEnd, q.invoiceDate],
      ['2026-10-01', '2026-12-31', '2026-12-31']
    )
    const y = period('2025-03-01', 'ANNUAL', 1, 'ADVANCE')
    assert.deepEqual([y.periodStart, y.periodEnd], ['2026-03-01', '2027-02-28'])
    assert.isTrue(withinContract(q, null))
    assert.isFalse(withinContract(q, '2026-09-30'))
  })

  test('versão aplicável: a última aprovada com vigência até ao início do período', ({
    assert,
  }) => {
    const vs = [
      { validFrom: '2026-01-01', status: 'APPROVED', n: 1 },
      { validFrom: '2026-06-01', status: 'APPROVED', n: 2 },
      { validFrom: '2026-03-01', status: 'DRAFT', n: 3 },
    ]
    assert.isNull(effectiveVersion(vs, '2025-12-01'))
    assert.equal(effectiveVersion(vs, '2026-05-31')!.n, 1)
    assert.equal(effectiveVersion(vs, '2026-06-01')!.n, 2)
  })

  test('validação das versões: linhas, serviço repetido, preço opcional', ({ assert }) => {
    const bad = normalizeVersion({
      validFrom: 'x',
      lines: [
        { productId: P, quantity: '0', unitPrice: 'abc', taxCodeIds: [] },
        { productId: P, quantity: '1', taxCodeIds: [T] },
      ],
    })
    assert.includeMembers(
      bad.issues.map((i) => i.path),
      [
        'validFrom',
        'lines.0.quantity',
        'lines.0.unitPrice',
        'lines.0.taxCodeIds',
        'lines.1.productId',
      ]
    )
    const good = normalizeVersion({
      validFrom: '2026-01-01',
      lines: [{ productId: P, quantity: '2', unitPrice: '', taxCodeIds: [T] }],
    })
    assert.deepEqual(
      [good.issues, good.lines[0].unitPrice, good.lines[0].quantity],
      [[], null, 2_000000n]
    )
  })
})
