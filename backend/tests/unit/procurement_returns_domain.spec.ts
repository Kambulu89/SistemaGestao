import { test } from '@japa/runner'
import {
  cancelOnCredit,
  creditAmounts,
  creditNeed,
  creditStatusOf,
  normalizeCreditLines,
  normalizeReturnHeader,
  normalizeReturnLines,
  returnable,
} from '#modules/procurement/domain/returns'

const N = (v: number) => BigInt(Math.round(v * 1_000_000))
const C = (v: number) => BigInt(Math.round(v * 100))
const U = '0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const V = '1b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const codes = (issues: { code: string }[]) => issues.map((i) => i.code)

test.group('Compras | devoluções e notas de crédito — regras (9.9)', () => {
  test('linhas da devolução: forma, origem, estado de stock, séries e repetições', ({ assert }) => {
    const ok = normalizeReturnLines([
      { receiptLineId: U, quantity: '2', serials: [' S1 ', 'S2'], notes: ' partida ' },
      { receiptLineId: U, source: 'REFUSED', quantity: '1.5' },
    ])
    assert.deepEqual(ok.issues, [])
    assert.deepInclude(ok.lines[0], {
      source: 'ACCEPTED',
      quantity: N(2),
      bucket: 'UNRESTRICTED',
      notes: 'partida',
    })
    assert.deepEqual(ok.lines[0].serials, ['S1', 'S2'])
    assert.deepInclude(ok.lines[1], { source: 'REFUSED', quantity: N(1.5) })
    const bad = normalizeReturnLines([
      { receiptLineId: U, quantity: '0', bucket: 'RESERVED', source: 'X', serials: ['A', 'A'] },
      { receiptLineId: U, quantity: '1' },
      { quantity: '1' },
    ])
    assert.sameMembers(codes(bad.issues), [
      'INVALID',
      'INVALID',
      'INVALID',
      'DUPLICATE',
      'DUPLICATE',
      'REQUIRED',
    ])
    assert.deepEqual(codes(normalizeReturnLines([]).issues), ['REQUIRED'])
  })

  test('cabeçalho: motivo, descrição, solução, data não futura', ({ assert }) => {
    const ok = normalizeReturnHeader(
      {
        reasonCode: 'DAMAGED',
        description: '  Carcaça partida  ',
        remedy: 'CREDIT',
        carrierRef: ' GT-1 ',
      },
      '2026-11-19'
    )
    assert.deepEqual(ok.issues, [])
    assert.deepEqual(ok.header, {
      returnDate: '2026-11-19',
      reasonCode: 'DAMAGED',
      description: 'Carcaça partida',
      remedy: 'CREDIT',
      carrierRef: 'GT-1',
    })
    const bad = normalizeReturnHeader(
      { reasonCode: 'X', description: 'ok', remedy: 'REFUND', returnDate: '2026-11-20' },
      '2026-11-19'
    )
    assert.sameMembers(codes(bad.issues), ['FUTURE', 'REQUIRED', 'REQUIRED', 'REQUIRED'])
  })

  test('devolvível, crédito pendente, cancelamento a crédito e estado do crédito', ({ assert }) => {
    assert.equal(returnable(N(6), N(2)), N(4))
    assert.equal(returnable(N(2), N(3)), 0n)
    // Facturadas 6, recebidas 4 depois da devolução de 2 → as 2 ficam por creditar.
    assert.equal(
      creditNeed({ remedy: 'CREDIT', quantity: N(2), invoiced: N(6), receivedAfter: N(4) }),
      N(2)
    )
    // Só 5 facturadas: 1 por creditar (a outra nunca foi facturada).
    assert.equal(
      creditNeed({ remedy: 'CREDIT', quantity: N(2), invoiced: N(5), receivedAfter: N(4) }),
      N(1)
    )
    assert.equal(
      creditNeed({ remedy: 'CREDIT', quantity: N(2), invoiced: N(0), receivedAfter: N(4) }),
      0n
    )
    assert.equal(
      creditNeed({ remedy: 'REPLACEMENT', quantity: N(2), invoiced: N(6), receivedAfter: N(4) }),
      0n
    )
    assert.equal(cancelOnCredit({ remedy: 'CREDIT', quantity: N(2), openAfter: N(6) }), N(2))
    assert.equal(cancelOnCredit({ remedy: 'CREDIT', quantity: N(2), openAfter: N(1) }), N(1))
    assert.equal(cancelOnCredit({ remedy: 'CREDIT', quantity: N(2), openAfter: 0n }), 0n)
    assert.equal(cancelOnCredit({ remedy: 'REPLACEMENT', quantity: N(2), openAfter: N(6) }), 0n)
    assert.equal(creditStatusOf([{ creditQuantity: 0n, credited: 0n }]), 'NOT_REQUIRED')
    assert.equal(
      creditStatusOf([
        { creditQuantity: N(2), credited: N(1) },
        { creditQuantity: 0n, credited: 0n },
      ]),
      'PENDING'
    )
    assert.equal(creditStatusOf([{ creditQuantity: N(2), credited: N(2) }]), 'CREDITED')
  })

  test('valores do crédito: ao preço da factura, a última leva o resto exacto', ({ assert }) => {
    const invoice = { quantity: N(3), net: C(1000), tax: C(140), taxRate: 14_000n }
    const first = creditAmounts({
      kind: 'QUANTITY',
      quantity: N(1),
      netAmount: 0n,
      invoice,
      before: { quantity: 0n, net: 0n, tax: 0n },
    })
    assert.deepEqual(first, { net: C(333.33), tax: C(46.67), total: C(380) })
    const last = creditAmounts({
      kind: 'QUANTITY',
      quantity: N(1),
      netAmount: 0n,
      invoice,
      before: { quantity: N(2), net: C(666.66), tax: C(93.34) },
    })
    // 1 000,00 − 666,66 = 333,34; 140,00 − 93,34 = 46,66 (a soma das três dá exactamente a factura).
    assert.deepEqual(last, { net: C(333.34), tax: C(46.66), total: C(380) })
    const price = creditAmounts({
      kind: 'PRICE',
      quantity: 0n,
      netAmount: C(50),
      invoice,
      before: { quantity: 0n, net: 0n, tax: 0n },
    })
    assert.deepEqual(price, { net: C(50), tax: C(7), total: C(57) })
  })

  test('linhas da nota de crédito: tipo, quantidade ou valor, ligação à devolução', ({
    assert,
  }) => {
    const ok = normalizeCreditLines([
      { invoiceLineId: U, quantity: '2', returnLineId: V },
      { invoiceLineId: U, kind: 'PRICE', netAmount: '12.50' },
    ])
    assert.deepEqual(ok.issues, [])
    assert.deepEqual(ok.lines, [
      { invoiceLineId: U, kind: 'QUANTITY', quantity: N(2), netAmount: 0n, returnLineId: V },
      { invoiceLineId: U, kind: 'PRICE', quantity: 0n, netAmount: C(12.5), returnLineId: null },
    ])
    const bad = normalizeCreditLines([
      { invoiceLineId: U, kind: 'PRICE', netAmount: '0', returnLineId: V },
      { kind: 'OTHER', quantity: '-1' },
    ])
    assert.sameMembers(codes(bad.issues), [
      'INVALID',
      'NOT_ALLOWED',
      'REQUIRED',
      'INVALID',
      'INVALID',
    ])
  })
})
