import { test } from '@japa/runner'
import {
  deliveryState,
  normalizeReceiptLines,
  openQuantity,
  toBaseQuantity,
  unitCostFunctional,
} from '#modules/procurement/domain/receipts'

const N = (v: number) => BigInt(Math.round(v * 1_000_000))
const RATE = (v: number) => BigInt(Math.round(v * 1e10))
const L = '00000000-0000-4000-8000-000000000001'

test.group('Compras | recepções: regras', () => {
  test('unidade base e custo de entrada na moeda funcional', ({ assert }) => {
    assert.equal(toBaseQuantity(N(2), N(12)), N(24))
    assert.equal(toBaseQuantity(N(0.5), N(12)), N(6))
    // 10 × 1 000 com 10% de desconto = 9 000 líquido → 900 por unidade.
    assert.equal(unitCostFunctional(900_000n, N(10), RATE(1), N(1)), N(900))
    // 2 caixas a 120 USD (240 USD = 24 000 cêntimos), câmbio 900, caixa de 12 → 9 000 por unidade.
    assert.equal(unitCostFunctional(24_000n, N(2), RATE(900), N(12)), N(9000))
    // 1 / 3 → 0,333333 (meio para cima).
    assert.equal(unitCostFunctional(100n, N(3), RATE(1), N(1)), N(0.333333))
    assert.equal(unitCostFunctional(100n, 0n, RATE(1), N(1)), 0n)
  })

  test('em falta e estado da entrega prevista', ({ assert }) => {
    assert.equal(openQuantity({ quantity: N(10), received: N(6), cancelled: N(1) }), N(3))
    assert.equal(deliveryState('2026-11-18', N(1), '2026-11-19'), 'OVERDUE')
    assert.equal(deliveryState('2026-11-19', N(1), '2026-11-19'), 'TODAY')
    assert.equal(deliveryState('2026-11-20', N(1), '2026-11-19'), 'UPCOMING')
    assert.equal(deliveryState(null, N(1), '2026-11-19'), 'UNSCHEDULED')
    assert.equal(deliveryState('2026-11-18', 0n, '2026-11-19'), 'DONE')
  })

  test('linhas: quantidades, recusa com motivo, datas, séries e duplicados', ({ assert }) => {
    assert.equal(normalizeReceiptLines([]).issues[0].code, 'REQUIRED')
    const r = normalizeReceiptLines([
      { orderLineId: L, quantity: '0', rejectedQuantity: '0' },
      { orderLineId: L, quantity: '1', rejectedQuantity: '2' },
      { quantity: '-1', expiryDate: '2026-02-30', serials: ['A', 'A'] },
    ])
    assert.includeMembers(
      r.issues.map((i) => `${i.path}:${i.code}`),
      [
        'lines.0.quantity:REQUIRED',
        'lines.1.orderLineId:DUPLICATE',
        'lines.1.rejectReason:REQUIRED',
        'lines.2.orderLineId:REQUIRED',
        'lines.2.quantity:INVALID',
        'lines.2.expiryDate:INVALID',
        'lines.2.serials:DUPLICATE',
      ]
    )
    const good = normalizeReceiptLines([
      {
        orderLineId: L,
        quantity: '1,5',
        rejectedQuantity: '0.5',
        rejectReason: ' Partida ',
        serials: [' S1 ', ''],
      },
    ])
    assert.deepEqual(good.issues, [])
    assert.deepInclude(good.lines[0], {
      quantity: N(1.5),
      rejectedQuantity: N(0.5),
      rejectReason: 'Partida',
    })
    assert.deepEqual(good.lines[0].serials, ['S1'])
  })
})
