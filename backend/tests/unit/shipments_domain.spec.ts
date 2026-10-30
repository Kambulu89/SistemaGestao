import { test } from '@japa/runner'
import {
  canShip,
  fits,
  normalizeShipmentLine,
  quantityText,
  remaining,
  statusAfterShipping,
} from '#modules/orders/domain/shipments'
import type { Issue } from '#modules/orders/domain/sales'

test.group('expedições | domínio', () => {
  test('só se expede uma encomenda confirmada ou parcialmente expedida', ({ assert }) => {
    assert.isTrue(canShip('CONFIRMED'))
    assert.isTrue(canShip('PARTIAL'))
    for (const status of ['DRAFT', 'FULFILLED', 'CANCELLED'] as const) {
      assert.isFalse(canShip(status), status)
    }
  })

  test('uma linha precisa da linha da encomenda e de uma quantidade positiva com até 6 casas', ({
    assert,
  }) => {
    const issues: Issue[] = []
    assert.deepEqual(normalizeShipmentLine({ orderLineId: 'l1', quantity: '2.5' }, '', issues), {
      orderLineId: 'l1',
      quantity: '2.5',
    })
    assert.isEmpty(issues)
    for (const quantity of ['0', '0.000000', '-1', '1e3', '1.1234567', 3, undefined]) {
      const bad: Issue[] = []
      assert.isNull(normalizeShipmentLine({ orderLineId: 'l1', quantity }, 'lines[0].', bad))
      assert.equal(bad[0]?.path, 'lines[0].quantity')
    }
    const missing: Issue[] = []
    normalizeShipmentLine({ quantity: '1' }, '', missing)
    assert.equal(missing[0]?.path, 'orderLineId')
  })

  test('o saldo é o encomendado menos o expedido e nunca fica negativo', ({ assert }) => {
    const balance = { ordered: 10_000_000n, shipped: 4_000_000n }
    assert.equal(remaining(balance), 6_000_000n)
    assert.isTrue(fits(balance, '6'))
    assert.isTrue(fits(balance, '5.999999'))
    assert.isFalse(fits(balance, '6.000001'))
    assert.isFalse(fits(balance, '0'))
    assert.equal(remaining({ ordered: 1n, shipped: 5n }), 0n)
    assert.equal(quantityText(6_000_000n), '6.000000')
  })

  test('o estado da encomenda segue as quantidades expedidas', ({ assert }) => {
    const line = (ordered: bigint, shipped: bigint) => ({ ordered, shipped })
    assert.equal(statusAfterShipping([line(10n, 0n), line(5n, 0n)]), 'CONFIRMED')
    assert.equal(statusAfterShipping([line(10n, 3n), line(5n, 0n)]), 'PARTIAL')
    assert.equal(statusAfterShipping([line(10n, 10n), line(5n, 0n)]), 'PARTIAL')
    assert.equal(statusAfterShipping([line(10n, 10n), line(5n, 5n)]), 'FULFILLED')
    assert.equal(statusAfterShipping([]), 'CONFIRMED')
  })
})
