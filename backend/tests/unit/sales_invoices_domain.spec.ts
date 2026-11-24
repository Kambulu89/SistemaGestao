import { test } from '@japa/runner'
import {
  addDays,
  collectionView,
  documentHash,
  effectiveDiscount,
  lineNet,
  normalizeInvoiceHeader,
  normalizeInvoiceLines,
} from '#modules/sales/domain/invoices'

const paths = (issues: { path: string }[]) => issues.map((i) => i.path)
const U = '00000000-0000-4000-8000-000000000001'

test.group('Vendas | facturas — regras (10.6)', () => {
  test('cabeçalho e linhas: obrigatórios, isenção e origem', ({ assert }) => {
    assert.includeMembers(paths(normalizeInvoiceHeader({}, true).issues), [
      'legalEntityId',
      'customerId',
      'invoiceDate',
    ])
    const manual = normalizeInvoiceLines(
      [
        { productId: U, quantity: '1', taxCodeIds: [] },
        { productId: U, quantity: '1', taxCodeIds: [U], orderLineId: U },
      ],
      false
    )
    assert.includeMembers(paths(manual.issues), ['lines.0.taxCodeIds', 'lines.1.orderLineId'])
    const ord = normalizeInvoiceLines(
      [
        {
          orderLineId: U,
          quantity: '2,5',
          taxCodeIds: [U, U],
          manualDiscountPct: '50',
          exemptionCode: 'x1',
        },
      ],
      true
    )
    assert.deepEqual(ord.issues, [])
    assert.deepEqual(ord.lines[0].taxCodeIds, [U])
    assert.isNull(ord.lines[0].manualDiscountPct)
    assert.equal(ord.lines[0].exemptionCode, 'X1')
    assert.include(
      paths(normalizeInvoiceLines([{ quantity: '1', taxCodeIds: [U] }], true).issues),
      'lines.0.orderLineId'
    )
  })

  test('valores exactos: linha, desconto efectivo, vencimento', ({ assert }) => {
    assert.equal(lineNet('3', '0.3333'), '1.00')
    assert.equal(lineNet('2.5', '100.0000'), '250.00')
    assert.equal(effectiveDiscount('1000.0000', '855.0000'), '14.5000')
    assert.equal(effectiveDiscount(null, '10.0000'), '0.0000')
    assert.equal(effectiveDiscount('10.0000', '12.0000'), '0.0000')
    assert.equal(addDays('2026-01-31', 30), '2026-03-02')
  })

  test('cobrança: vencida calcula-se; rascunho sem estado', ({ assert }) => {
    assert.isNull(collectionView('DRAFT', null, null, '2026-05-01'))
    assert.equal(collectionView('ISSUED', 'UNPAID', '2026-04-30', '2026-05-01'), 'OVERDUE')
    assert.equal(collectionView('ISSUED', 'PARTIAL', '2026-05-01', '2026-05-01'), 'PARTIAL')
    assert.equal(collectionView('ISSUED', 'PAID', '2026-04-01', '2026-05-01'), 'PAID')
  })

  test('impressão digital canónica (independente da ordem das chaves)', ({ assert }) => {
    assert.equal(
      documentHash({ a: 1, b: { c: 2, d: [1, 2] } }),
      documentHash({ b: { d: [1, 2], c: 2 }, a: 1 })
    )
    assert.notEqual(documentHash({ a: 1 }), documentHash({ a: 2 }))
  })
})
