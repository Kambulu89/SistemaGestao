import { test } from '@japa/runner'
import {
  budgetState,
  documentAmounts,
  normalizeBudget,
  normalizePayment,
  openShare,
  orderCommitment,
  orderValueFor,
  payableStatus,
  paymentAmounts,
  requisitionCommitment,
} from '#modules/procurement/domain/finance'

const N = (v: number) => BigInt(Math.round(v * 1_000_000))
const C = (v: number) => BigInt(Math.round(v * 100))
const RATE = (v: number) => BigInt(Math.round(v * 1e4)) * 1_000_000n
const ONE = RATE(1)
const codes = (issues: { code: string }[]) => issues.map((i) => i.code)

test.group('Compras | orçamento, obrigação e contabilidade — regras (9.10)', () => {
  test('compromisso em aberto: requisição por encomendar, ordem por facturar, ao câmbio', ({
    assert,
  }) => {
    assert.equal(openShare(C(1000), N(3), N(1)), C(333.33))
    assert.equal(openShare(C(1000), N(3), N(-1)), 0n)
    assert.equal(openShare(C(1000), N(3), N(5)), C(1000))
    const req = [{ net: C(10000), quantity: N(10), ordered: N(6), closed: N(0) }]
    assert.equal(requisitionCommitment(true, ONE, req), C(4000))
    assert.equal(requisitionCommitment(false, ONE, req), 0n)
    assert.equal(
      requisitionCommitment(true, ONE, [
        { net: C(10000), quantity: N(10), ordered: N(6), closed: N(4) },
      ]),
      0n
    )
    const ord = [
      { net: C(100), quantity: N(10), cancelled: N(2), invoiced: N(3) },
      { net: C(50), quantity: N(1), cancelled: N(0), invoiced: N(0) },
    ]
    // (100 × 5/10 + 50) × 900 = 90 000,00
    assert.equal(orderCommitment(true, RATE(900), ord), C(90000))
    assert.equal(orderCommitment(false, RATE(900), ord), 0n)
  })

  test('verba: disponível e excesso; validação da verba', ({ assert }) => {
    assert.deepEqual(budgetState({ amount: C(15000), committed: C(10600), actual: 0n }), {
      available: C(4400),
      over: false,
    })
    assert.deepEqual(budgetState({ amount: C(15000), committed: C(9000), actual: C(6900) }), {
      available: C(-900),
      over: true,
    })
    const ok = normalizeBudget({ fiscalYear: 2026, amount: '15000', control: 'WARN', notes: ' x ' })
    assert.deepEqual(ok, {
      budget: { fiscalYear: 2026, amount: C(15000), control: 'WARN', notes: 'x' },
      issues: [],
    })
    assert.equal(normalizeBudget({ fiscalYear: 2026, amount: '1' }).budget.control, 'BLOCK')
    assert.sameMembers(
      codes(normalizeBudget({ fiscalYear: 1999, amount: '-1', control: 'X' }).issues),
      ['INVALID', 'INVALID', 'INVALID']
    )
  })

  test('obrigação: estado pelo saldo; pagamento validado', ({ assert }) => {
    assert.equal(payableStatus({ amount: C(100), credited: 0n, paid: 0n }), 'OPEN')
    assert.equal(payableStatus({ amount: C(100), credited: C(10), paid: C(50) }), 'PARTIALLY_PAID')
    assert.equal(payableStatus({ amount: C(100), credited: C(10), paid: C(90) }), 'SETTLED')
    assert.equal(payableStatus({ amount: C(100), credited: C(100), paid: 0n }), 'SETTLED')
    const p = normalizePayment({ amount: '10.5', reference: ' TRF ' }, '2026-11-23')
    assert.deepEqual(p, {
      payment: { paidOn: '2026-11-23', amount: C(10.5), reference: 'TRF', notes: null },
      issues: [],
    })
    assert.sameMembers(
      codes(normalizePayment({ amount: '0', paidOn: '2026-11-24' }, '2026-11-23').issues),
      ['FUTURE', 'INVALID', 'REQUIRED']
    )
  })

  test('contabilização: recepções por facturar ao valor de entrada, diferença, serviços, imposto; total equilibrado', ({
    assert,
  }) => {
    // 6 bombas: ordem 6 600 (entraram em stock), factura 6 900 + 14%; instalação 500 sem stock.
    const a = documentAmounts(
      [
        { net: C(6900), tax: C(966), stockedOrderNet: orderValueFor(C(6600), N(6), N(6)) },
        { net: C(500), tax: 0n, stockedOrderNet: null },
      ],
      ONE,
      ONE
    )
    assert.deepEqual(a.amounts, {
      goodsReceived: '6600.00',
      priceVarianceUp: '300.00',
      priceVarianceDown: '0.00',
      services: '500.00',
      tax: '966.00',
      payable: '8366.00',
    })
    assert.equal(a.total, C(8366))
    // Em USD: ordem a 900, factura a 950 → a diferença de câmbio vai para a diferença; abaixo → "down".
    const b = documentAmounts(
      [{ net: C(10), tax: 0n, stockedOrderNet: C(12) }],
      RATE(950),
      RATE(900)
    )
    assert.deepEqual(b.amounts, {
      goodsReceived: '10800.00',
      priceVarianceUp: '0.00',
      priceVarianceDown: '1300.00',
      services: '0.00',
      tax: '0.00',
      payable: '9500.00',
    })
    assert.equal(orderValueFor(C(1000), N(3), N(1)), C(333.33))
  })

  test('pagamento: obrigação ao câmbio da factura, banco ao do pagamento, diferença cambial', ({
    assert,
  }) => {
    assert.deepEqual(paymentAmounts(C(100), RATE(900), RATE(950)).amounts, {
      payable: '90000.00',
      bank: '95000.00',
      fxLoss: '5000.00',
      fxGain: '0.00',
    })
    assert.deepEqual(paymentAmounts(C(100), RATE(900), RATE(880)).amounts, {
      payable: '90000.00',
      bank: '88000.00',
      fxLoss: '0.00',
      fxGain: '2000.00',
    })
    assert.deepEqual(paymentAmounts(C(100), ONE, ONE).amounts, {
      payable: '100.00',
      bank: '100.00',
      fxLoss: '0.00',
      fxGain: '0.00',
    })
  })
})
