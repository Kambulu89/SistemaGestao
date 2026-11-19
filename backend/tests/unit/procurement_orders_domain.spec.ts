import { test } from '@japa/runner'
import {
  allocationDelta,
  invoiceStatus,
  normalizeOrderLines,
  orderCan,
  orderLineAmounts,
  receiptStatus,
} from '#modules/procurement/domain/orders'

const N = (v: number) => BigInt(Math.round(v * 1_000_000))
const R = (v: number) => BigInt(Math.round(v * 1000))

test.group('Compras | ordens de compra: regras', () => {
  test('valores da linha: bruto, desconto, líquido, imposto e total exactos (meio para cima)', ({
    assert,
  }) => {
    assert.deepEqual(orderLineAmounts(N(6), N(1000), R(10), R(14)), {
      gross: 600_000n,
      discount: 60_000n,
      net: 540_000n,
      tax: 75_600n,
      total: 615_600n,
    })
    // 3 × 0,333333 = 0,999999 → 1,00; 2,5% de desconto → 0,03 (0,025 sobe); 14% de 0,97 → 0,14 (0,1358).
    assert.deepEqual(orderLineAmounts(N(3), N(0.333333), R(2.5), R(14)), {
      gross: 100n,
      discount: 3n,
      net: 97n,
      tax: 14n,
      total: 111n,
    })
    assert.deepEqual(orderLineAmounts(N(1), N(10), R(100), R(14)), {
      gross: 1000n,
      discount: 1000n,
      net: 0n,
      tax: 0n,
      total: 0n,
    })
  })

  test('estado de recepção e de facturação pelas linhas', ({ assert }) => {
    const l = (quantity: number, received: number, cancelled = 0, invoiced = 0) => ({
      quantity: N(quantity),
      received: N(received),
      cancelled: N(cancelled),
      invoiced: N(invoiced),
    })
    assert.equal(receiptStatus([l(10, 0), l(1, 0)]), 'NOT_RECEIVED')
    assert.equal(receiptStatus([l(10, 3), l(1, 0)]), 'PARTIALLY_RECEIVED')
    assert.equal(receiptStatus([l(10, 3, 7), l(1, 1)]), 'RECEIVED')
    // Tudo cancelado sem nada recebido não é "recebida".
    assert.equal(receiptStatus([l(10, 0, 10)]), 'NOT_RECEIVED')
    assert.equal(invoiceStatus([l(10, 3, 7, 0)]), 'NOT_INVOICED')
    assert.equal(invoiceStatus([l(10, 3, 0, 3)]), 'PARTIALLY_INVOICED')
    assert.equal(invoiceStatus([l(10, 3, 7, 3)]), 'INVOICED')
  })

  test('o que se pode fazer pelos três estados', ({ assert }) => {
    const base = {
      approval: 'DRAFT' as const,
      issuedRevision: null,
      revision: 0,
      receipt: 'NOT_RECEIVED' as const,
      invoice: 'NOT_INVOICED' as const,
      closed: false,
      hasMovement: false,
    }
    assert.deepInclude(orderCan(base), {
      edit: true,
      submit: true,
      issue: false,
      revise: false,
      cancel: true,
    })
    assert.deepInclude(orderCan({ ...base, approval: 'APPROVED' }), {
      edit: false,
      issue: true,
      revise: false,
    })
    const issued = { ...base, approval: 'APPROVED' as const, issuedRevision: 0 }
    assert.deepInclude(orderCan(issued), { issue: false, revise: true, close: false, cancel: true })
    assert.deepInclude(orderCan({ ...issued, receipt: 'PARTIALLY_RECEIVED', hasMovement: true }), {
      revise: true,
      close: true,
      cancel: false,
    })
    assert.deepInclude(orderCan({ ...issued, receipt: 'RECEIVED', hasMovement: true }), {
      revise: false,
    })
    // Revisão aprovada ainda não emitida: emite-se de novo.
    assert.deepInclude(orderCan({ ...issued, revision: 1 }), { issue: true, revise: false })
    assert.deepInclude(orderCan({ ...issued, closed: true }), {
      revise: false,
      cancel: false,
      close: false,
    })
    assert.deepInclude(orderCan({ ...base, approval: 'CANCELLED' }), { edit: false, cancel: false })
    assert.deepInclude(orderCan({ ...base, invoice: 'PARTIALLY_INVOICED' }), { cancel: false })
  })

  test('linhas: validações de forma e afectação a acertar', ({ assert }) => {
    const r = normalizeOrderLines([
      {
        quantity: '0',
        unitPrice: 'x',
        discountRate: '100.5',
        taxRate: '-1',
        expectedDate: '2026-02-30',
      },
      { id: '00000000-0000-4000-8000-000000000001', quantity: '1', unitPrice: '1' },
      { id: '00000000-0000-4000-8000-000000000001', quantity: '1', unitPrice: '1' },
    ])
    assert.includeMembers(
      r.issues.map((i) => `${i.path}:${i.code}`),
      [
        'lines.0.quantity:INVALID',
        'lines.0.unitPrice:INVALID',
        'lines.0.discountRate:INVALID',
        'lines.0.taxRate:INVALID',
        'lines.0.expectedDate:INVALID',
        'lines:DUPLICATE',
      ]
    )
    assert.equal(normalizeOrderLines([]).issues[0].code, 'REQUIRED')
    assert.equal(allocationDelta(N(8), 0n, N(6)), N(2))
    assert.equal(allocationDelta(N(8), N(5), N(8)), -N(5))
  })
})
