import { test } from '@japa/runner'
import {
  dueDate,
  invoiceNumberKey,
  type LineFacts,
  matchLine,
  matchTotal,
  netUnit,
  NO_TOLERANCE,
  normalizeInvoiceLines,
  normalizeTolerances,
} from '#modules/procurement/domain/invoices'

const N = (v: number) => BigInt(Math.round(v * 1_000_000))
const C = (v: number) => BigInt(Math.round(v * 100))
const R = (v: number) => BigInt(Math.round(v * 1000))
const line = (
  extra: Partial<LineFacts> = {},
  order: Partial<NonNullable<LineFacts['order']>> = {}
): LineFacts => ({
  lineNo: 1,
  orderLineId: 'x',
  quantity: N(6),
  netCents: C(5400),
  taxRate: R(14),
  order: {
    quantity: N(10),
    received: N(6),
    invoiced: 0n,
    netCents: C(9000),
    taxRate: R(14),
    ...order,
  },
  ...extra,
})

test.group('Compras | facturas: regras', () => {
  test('número externo normalizado, vencimento e preço unitário líquido', ({ assert }) => {
    assert.equal(invoiceNumberKey(' ft 2026 / 001 '), 'FT2026/001')
    assert.equal(dueDate('2026-01-31', 30), '2026-03-02')
    assert.equal(netUnit(C(9000), N(10)), N(900))
    assert.equal(netUnit(C(1), N(3)), N(0.333333))
  })

  test('conferência conforme: quantidade até ao recebido, preço igual ou abaixo, mesmo imposto', ({
    assert,
  }) => {
    assert.deepEqual(matchLine(line(), NO_TOLERANCE), [])
    assert.deepEqual(matchLine(line({ netCents: C(5000) }), NO_TOLERANCE), [])
    assert.deepEqual(
      matchLine(line({ quantity: N(1), netCents: C(900) }, { invoiced: N(5) }), NO_TOLERANCE),
      []
    )
  })

  test('divergências: acima do recebido, preço, imposto, encargo sem linha', ({ assert }) => {
    const codes = (l: LineFacts, t = NO_TOLERANCE) => matchLine(l, t).map((d) => d.code)
    assert.deepEqual(codes(line({ quantity: N(1), netCents: C(900) }, { invoiced: N(6) })), [
      'QTY_OVER_RECEIVED',
    ])
    assert.deepEqual(codes(line({ netCents: C(5481) })), ['PRICE_OVER_ORDER'])
    assert.deepEqual(codes(line({ taxRate: R(7) })), ['TAX_MISMATCH'])
    assert.deepEqual(codes(line({ order: null })), ['UNMATCHED_LINE'])
    // Tolerância de quantidade: 10% de 6 recebidos → até 6,6.
    const q = { ...NO_TOLERANCE, qtyPct: R(10) }
    assert.deepEqual(codes(line({ quantity: N(6.6), netCents: C(5940) }), q), [])
    assert.deepEqual(codes(line({ quantity: N(6.7), netCents: C(6030) }), q), ['QTY_OVER_RECEIVED'])
  })

  test('tolerância de preço: percentagem ou valor da linha', ({ assert }) => {
    const codes = (l: LineFacts, t: any) => matchLine(l, t).map((d) => d.code)
    // 913,50 contra 900: +1,5% → dentro de 2%, fora de 1%.
    const l = line({ netCents: C(5481) })
    assert.deepEqual(codes(l, { ...NO_TOLERANCE, pricePct: R(2) }), [])
    assert.deepEqual(codes(l, { ...NO_TOLERANCE, pricePct: R(1) }), ['PRICE_OVER_ORDER'])
    // Diferença da linha 81,00: aceite com tolerância de valor ≥ 81,00.
    assert.deepEqual(codes(l, { ...NO_TOLERANCE, priceAmount: C(81) }), [])
    assert.deepEqual(codes(l, { ...NO_TOLERANCE, priceAmount: C(80.99) }), ['PRICE_OVER_ORDER'])
  })

  test('total declarado contra a soma das linhas', ({ assert }) => {
    assert.deepEqual(matchTotal(C(100), C(100), NO_TOLERANCE), [])
    assert.equal(matchTotal(C(100.5), C(100), NO_TOLERANCE)[0].code, 'TOTAL_MISMATCH')
    assert.deepEqual(matchTotal(C(99.5), C(100), { ...NO_TOLERANCE, totalAmount: C(1) }), [])
  })

  test('validações de linhas e tolerâncias', ({ assert }) => {
    const id = '00000000-0000-4000-8000-000000000001'
    const r = normalizeInvoiceLines([
      { orderLineId: id, quantity: '0', unitPrice: 'x' },
      { orderLineId: id, quantity: '1', unitPrice: '1', discountRate: '101' },
      { quantity: '1', unitPrice: '1', description: 'ab' },
    ])
    assert.includeMembers(
      r.issues.map((i) => `${i.path}:${i.code}`),
      [
        'lines.0.quantity:INVALID',
        'lines.0.unitPrice:INVALID',
        'lines.1.orderLineId:DUPLICATE',
        'lines.1.discountRate:INVALID',
        'lines.2.description:REQUIRED',
      ]
    )
    assert.equal(normalizeInvoiceLines([]).issues[0].code, 'REQUIRED')
    const t = normalizeTolerances({
      pricePct: '2,5',
      priceAmount: '10',
      qtyPct: '101',
      totalAmount: '-1',
    })
    assert.equal(t.tolerances.pricePct, R(2.5))
    assert.deepEqual(
      t.issues.map((i) => i.path),
      ['qtyPct', 'totalAmount']
    )
  })
})
