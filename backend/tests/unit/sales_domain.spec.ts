import { test } from '@japa/runner'
import {
  decimalPlaces,
  fromScaled,
  lineAmounts,
  roundDiv,
  sumTotals,
  toScaled,
} from '#modules/orders/domain/money'
import {
  canCancel,
  canConfirm,
  canQuoteMove,
  effectiveQuoteStatus,
  normalizeAddress,
  normalizeLineRequest,
  normalizeOrderHeader,
  normalizeQuoteHeader,
  type Issue,
} from '#modules/orders/domain/sales'

const base = {
  quantity: '1',
  unitPrice: '100',
  discountRate: '0',
  taxRate: '0',
  taxInclusive: false,
}

test.group('aritmética exacta das linhas', () => {
  test('quantidade × preço com desconto e imposto, sem erros de vírgula flutuante', ({
    assert,
  }) => {
    // 3 × 33,3333 = 99,9999; −10 % = 89,99991 → 89,9999; IVA 14 % = 12,599986 → 12,6000.
    const amounts = lineAmounts(
      { ...base, quantity: '3', unitPrice: '33.3333', discountRate: '0.1', taxRate: '14' },
      'HALF_UP'
    )
    assert.deepEqual(amounts, { net: '89.9999', tax: '12.6000', total: '102.5999' })
    // O clássico 0,1 + 0,2: com bigint nunca dá 0,30000000000000004.
    assert.deepEqual(
      sumTotals([
        { net: '0.1000', tax: '0.0000', total: '0.1000' },
        { net: '0.2000', tax: '0.0000', total: '0.2000' },
      ]),
      { net: '0.3000', tax: '0.0000', total: '0.3000' }
    )
  })

  test('o modo de arredondamento decide o meio exacto', ({ assert }) => {
    const half = { ...base, unitPrice: '0.0005', discountRate: '0.5' } // 0,00025
    assert.equal(lineAmounts(half, 'HALF_UP')?.net, '0.0003')
    assert.equal(lineAmounts(half, 'HALF_EVEN')?.net, '0.0002')
    assert.equal(roundDiv(25n, 10n, 'HALF_UP'), 3n)
    assert.equal(roundDiv(25n, 10n, 'HALF_EVEN'), 2n)
    assert.equal(roundDiv(35n, 10n, 'HALF_EVEN'), 4n)
    assert.equal(roundDiv(14n, 10n, 'HALF_EVEN'), 1n)
  })

  test('preço com imposto incluído: o líquido sai do total e o total não muda', ({ assert }) => {
    assert.deepEqual(
      lineAmounts({ ...base, unitPrice: '114', taxRate: '14', taxInclusive: true }, 'HALF_UP'),
      { net: '100.0000', tax: '14.0000', total: '114.0000' }
    )
    // 100 / 1,14 = 87,7192982… → 87,7193; o imposto é o que falta para o total.
    assert.deepEqual(lineAmounts({ ...base, taxRate: '14', taxInclusive: true }, 'HALF_UP'), {
      net: '87.7193',
      tax: '12.2807',
      total: '100.0000',
    })
  })

  test('total = líquido + imposto, sempre, e as entradas inválidas são recusadas', ({ assert }) => {
    for (const price of ['0.0001', '1.2345', '19.9999', '1000000.0001']) {
      for (const rate of ['0', '5.5', '14', '23.0001']) {
        for (const inclusive of [false, true]) {
          const a = lineAmounts(
            {
              ...base,
              quantity: '7.333333',
              unitPrice: price,
              taxRate: rate,
              taxInclusive: inclusive,
            },
            'HALF_UP'
          )
          assert.isNotNull(a)
          const sum = (toScaled(a!.net, 4) as bigint) + (toScaled(a!.tax, 4) as bigint)
          assert.equal(fromScaled(sum, 4), a!.total)
        }
      }
    }
    assert.isNull(lineAmounts({ ...base, discountRate: '1.0001' }, 'HALF_UP'))
    assert.isNull(lineAmounts({ ...base, unitPrice: '1.00001' }, 'HALF_UP'))
    assert.isNull(lineAmounts({ ...base, quantity: '1e3' }, 'HALF_UP'))
    assert.deepEqual(lineAmounts({ ...base, discountRate: '1' }, 'HALF_UP'), {
      net: '0.0000',
      tax: '0.0000',
      total: '0.0000',
    })
  })

  test('conversões de texto para inteiro escalado', ({ assert }) => {
    assert.equal(toScaled('12.5', 4), 125000n)
    assert.isNull(toScaled('1.00001', 4))
    assert.isNull(toScaled('-1', 4))
    assert.equal(fromScaled(125000n, 4), '12.5000')
    assert.equal(fromScaled(5n, 4), '0.0005')
    assert.equal(decimalPlaces('1.250'), 3)
    assert.equal(decimalPlaces('7'), 0)
  })
})

test.group('propostas e encomendas | domínio', () => {
  const issues = () => [] as Issue[]

  test('uma proposta enviada que passou da validade é derivada como expirada', ({ assert }) => {
    assert.equal(effectiveQuoteStatus('SENT', '2026-10-01', '2026-10-02'), 'EXPIRED')
    assert.equal(effectiveQuoteStatus('SENT', '2026-10-02', '2026-10-02'), 'SENT')
    assert.equal(effectiveQuoteStatus('DRAFT', '2020-01-01', '2026-10-02'), 'DRAFT')
    assert.equal(effectiveQuoteStatus('ACCEPTED', '2020-01-01', '2026-10-02'), 'ACCEPTED')
  })

  test('transições: só se aceita ou rejeita o que foi enviado; confirma-se um rascunho; cancela-se antes de expedir', ({
    assert,
  }) => {
    assert.isTrue(canQuoteMove('DRAFT', 'SENT'))
    assert.isTrue(canQuoteMove('SENT', 'ACCEPTED'))
    assert.isFalse(canQuoteMove('DRAFT', 'ACCEPTED'))
    assert.isFalse(canQuoteMove('EXPIRED', 'ACCEPTED'))
    assert.isFalse(canQuoteMove('ACCEPTED', 'REJECTED'))
    assert.isTrue(canConfirm('DRAFT'))
    assert.isFalse(canConfirm('CONFIRMED'))
    assert.isTrue(canCancel('DRAFT'))
    assert.isTrue(canCancel('CONFIRMED'))
    assert.isFalse(canCancel('PARTIAL'))
    assert.isFalse(canCancel('FULFILLED'))
  })

  test('cabeçalho da proposta: validade futura, moeda do cliente por omissão', ({ assert }) => {
    const ok = issues()
    const values = normalizeQuoteHeader(
      {
        organizationId: 'o',
        customerId: 'c',
        validUntil: '2026-11-30',
      },
      null,
      'AOA',
      '2026-10-27',
      ok
    )
    assert.deepEqual(ok, [])
    assert.deepInclude(values, { currency: 'AOA', notes: null })
    const bad = issues()
    normalizeQuoteHeader(
      { organizationId: 'o', customerId: 'c', validUntil: '2026-10-01', currency: 'aoa' },
      null,
      'AOA',
      '2026-10-27',
      bad
    )
    assert.sameMembers(
      bad.map((i) => i.code),
      ['IN_THE_PAST', 'INVALID_CURRENCY']
    )
    const none = issues()
    normalizeQuoteHeader(
      { organizationId: 'o', customerId: 'c', validUntil: '2026-02-30' },
      null,
      'AOA',
      '2026-01-01',
      none
    )
    assert.deepEqual(
      none.map((i) => i.code),
      ['INVALID_DATE']
    )
  })

  test('cabeçalho da encomenda: data por omissão é hoje; morada de entrega é um instantâneo de campos conhecidos', ({
    assert,
  }) => {
    const ok = issues()
    const values = normalizeOrderHeader(
      {
        organizationId: 'o',
        customerId: 'c',
        deliveryAddress: { line1: ' Rua A, 1 ', city: 'Luanda', countryCode: 'AO', line2: '  ' },
      },
      null,
      'AOA',
      '2026-10-27',
      ok
    )
    assert.deepEqual(ok, [])
    assert.equal(values?.orderDate, '2026-10-27')
    assert.deepEqual(values?.deliveryAddress, {
      line1: 'Rua A, 1',
      city: 'Luanda',
      countryCode: 'AO',
    })
    const bad = issues()
    normalizeAddress({ rua: 'x' }, bad)
    normalizeAddress('texto', bad)
    assert.lengthOf(bad, 2)
    assert.isNull(normalizeAddress(null, issues()))
  })

  test('pedido de linha: quantidade positiva em texto e desconto 0..1; o preço nunca vem do cliente', ({
    assert,
  }) => {
    const ok = issues()
    assert.deepEqual(normalizeLineRequest({ variantId: 'v', quantity: '2.5' }, null, ok), {
      variantId: 'v',
      quantity: '2.5',
      discountRate: '0',
    })
    for (const quantity of ['0', '0.0000000', '-1', 3, 'dois', '1.1234567']) {
      const bad = issues()
      assert.isNull(normalizeLineRequest({ variantId: 'v', quantity }, null, bad))
      assert.equal(bad[0]?.code, 'INVALID_QUANTITY')
    }
    for (const discountRate of ['1.5', '-0.1', 0.1, '0.12345']) {
      const bad = issues()
      assert.isNull(
        normalizeLineRequest({ variantId: 'v', quantity: '1', discountRate }, null, bad)
      )
      assert.equal(bad[0]?.code, 'INVALID_DISCOUNT')
    }
    // Actualização parcial: parte do que já existe.
    const patch = issues()
    assert.deepInclude(
      normalizeLineRequest(
        { quantity: '5' },
        { variantId: 'v', quantity: '1', discountRate: '0.05' },
        patch
      ),
      { variantId: 'v', quantity: '5', discountRate: '0.05' }
    )
  })
})
