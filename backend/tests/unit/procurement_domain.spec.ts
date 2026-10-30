import { test } from '@japa/runner'
import {
  canReceive,
  fits,
  normalizeReceiptLine,
  normalizeSupplier,
  purchaseBlocker,
  purchaseLineValues,
  remaining,
  statusAfterReceiving,
  sumLines,
  type Issue,
} from '#modules/procurement/domain/procurement'

const base = { partyId: 'p1', organizationId: 'o1', code: 'FOR-1' }

test.group('compras | fornecedores', () => {
  test('valida o prazo, a moeda e exige motivo para bloquear', ({ assert }) => {
    const issues: Issue[] = []
    const ok = normalizeSupplier({ ...base, paymentTermDays: 30 }, null, 'AOA', issues)
    assert.isEmpty(issues)
    assert.deepInclude(ok, { currency: 'AOA', status: 'ACTIVE', statusReason: null })
    const bad: Issue[] = []
    normalizeSupplier(
      { ...base, code: '!', paymentTermDays: -1, currency: 'aoa', status: 'BLOCKED' },
      null,
      'AOA',
      bad
    )
    assert.sameMembers(
      bad.map((i) => i.code),
      ['INVALID_CODE', 'INVALID_TERMS', 'INVALID_CURRENCY', 'REASON_REQUIRED']
    )
  })

  test('só fornecedores activos recebem novas encomendas', ({ assert }) => {
    assert.isNull(purchaseBlocker('ACTIVE'))
    assert.equal(purchaseBlocker('BLOCKED')?.code, 'SUPPLIER_BLOCKED')
    assert.equal(purchaseBlocker('INACTIVE')?.code, 'SUPPLIER_INACTIVE')
  })
})

test.group('compras | linhas e totais', () => {
  test('líquido, imposto e total em aritmética exacta, arredondados uma vez por linha', ({
    assert,
  }) => {
    const issues: Issue[] = []
    const line = purchaseLineValues(
      { variantId: 'v', quantity: '3', unitCost: '33.3333', taxRate: '14' },
      '',
      'HALF_UP',
      issues
    )
    assert.isEmpty(issues)
    assert.deepInclude(line, { netAmount: '99.9999', taxAmount: '14.0000', total: '113.9999' })
    const second = purchaseLineValues(
      { variantId: 'v', quantity: '2', unitCost: '50' },
      '',
      'HALF_UP',
      issues
    )
    assert.deepEqual(sumLines([line!, second!]), {
      net: '199.9999',
      tax: '14.0000',
      total: '213.9999',
    })
  })

  test('recusa quantidades, custos e taxas inválidos com o caminho do campo', ({ assert }) => {
    const issues: Issue[] = []
    purchaseLineValues(
      { variantId: '', quantity: '0', unitCost: '-1', taxRate: '101' },
      'lines[2].',
      'HALF_UP',
      issues
    )
    assert.deepEqual(
      issues.map((i) => i.path),
      ['lines[2].variantId', 'lines[2].quantity', 'lines[2].unitCost', 'lines[2].taxRate']
    )
  })
})

test.group('compras | recepções', () => {
  test('o saldo por receber nunca é negativo e a quantidade tem de caber nele', ({ assert }) => {
    const balance = { ordered: 10_000_000n, received: 4_000_000n }
    assert.equal(remaining(balance), 6_000_000n)
    assert.isTrue(fits(balance, '6'))
    assert.isFalse(fits(balance, '6.000001'))
    assert.isFalse(fits(balance, '0'))
    assert.equal(remaining({ ordered: 1n, received: 5n }), 0n)
  })

  test('o estado da encomenda deriva dos saldos', ({ assert }) => {
    assert.equal(statusAfterReceiving([]), 'ORDERED')
    assert.equal(statusAfterReceiving([{ ordered: 5n, received: 0n }]), 'ORDERED')
    assert.equal(
      statusAfterReceiving([
        { ordered: 5n, received: 5n },
        { ordered: 5n, received: 1n },
      ]),
      'PARTIAL'
    )
    assert.equal(statusAfterReceiving([{ ordered: 5n, received: 5n }]), 'RECEIVED')
    assert.isTrue(canReceive('ORDERED'))
    assert.isTrue(canReceive('PARTIAL'))
    for (const status of ['DRAFT', 'RECEIVED', 'CANCELLED'] as const) {
      assert.isFalse(canReceive(status), status)
    }
  })

  test('a linha precisa da linha da encomenda, de uma quantidade positiva e valida lote e validade', ({
    assert,
  }) => {
    const issues: Issue[] = []
    assert.deepEqual(
      normalizeReceiptLine(
        { purchaseLineId: 'l1', quantity: '2.5', lotCode: ' L1 ', expiresOn: '2099-01-31' },
        '',
        issues
      ),
      { purchaseLineId: 'l1', quantity: '2.5', lotCode: 'L1', expiresOn: '2099-01-31' }
    )
    assert.isEmpty(issues)
    const bad: Issue[] = []
    normalizeReceiptLine({ quantity: '0', expiresOn: '2099-02-30' }, 'lines[0].', bad)
    assert.sameMembers(
      bad.map((i) => i.code),
      ['REQUIRED', 'INVALID_QUANTITY', 'INVALID_DATE']
    )
  })
})
