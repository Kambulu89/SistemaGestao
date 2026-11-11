import { test } from '@japa/runner'
import {
  averageOut,
  consumeLayers,
  costText,
  divRound,
  lineValue,
  moneyText,
  parseScaled,
  unitCostOf,
  ValueQueue,
} from '#modules/inventory/domain/valuation'

const U = 1_000_000n

test.group('Inventário | domínio da valorização (8.9)', () => {
  test('arredondamento meio-para-cima e conversões exactas', ({ assert }) => {
    assert.equal(divRound(5n, 2n), 3n)
    assert.equal(divRound(-5n, 2n), -3n)
    assert.equal(divRound(4n, 3n), 1n)
    // 3 unidades a 33,333333 = 100,00; 1 unidade a 0,005 = 0,01.
    assert.equal(lineValue(3n * U, 33_333_333n), 10000n)
    assert.equal(lineValue(U, 5_000n), 1n)
    assert.equal(costText(unitCostOf(10000n, 3n * U)), '33.333333')
    assert.equal(moneyText(-12345n), '-123.45')
    assert.equal(parseScaled('12.5', 2), 1250n)
    assert.isNull(parseScaled('1.234', 2))
    assert.isNull(parseScaled('-1', 2))
    assert.equal(parseScaled('-1.5', 2, true), -150n)
  })

  test('custo médio: o último a sair leva o resto; nada se perde', ({ assert }) => {
    let pool = { quantity: 3n * U, value: 10000n }
    const outs: bigint[] = []
    for (let i = 0; i < 3; i++) {
      const v = averageOut(U, pool)
      outs.push(v)
      pool = { quantity: pool.quantity - U, value: pool.value - v }
    }
    assert.deepEqual(outs, [3333n, 3334n, 3333n])
    assert.equal(
      outs.reduce((a, b) => a + b, 0n),
      10000n
    )
    assert.deepEqual(pool, { quantity: 0n, value: 0n })
  })

  test('camadas FIFO e fila de valor entre entidades', ({ assert }) => {
    const layers = [
      { id: 'a', remainingQuantity: 10n * U, remainingValue: 5000n },
      { id: 'b', remainingQuantity: 10n * U, remainingValue: 7001n },
    ]
    const c = consumeLayers(15n * U, layers)
    assert.deepEqual(
      c.parts.map((p) => [p.layerId, Number(p.quantity / U), p.value]),
      [
        ['a', 10, 5000n],
        ['b', 5, 3501n],
      ]
    )
    assert.equal(c.short, 0n)
    assert.equal(consumeLayers(25n * U, layers).short, 5n * U)
    const q = new ValueQueue()
    q.push('p', 4n * U, 40000n)
    assert.deepEqual(q.take('p', U), { value: 10000n, short: 0n })
    assert.deepEqual(q.take('p', 5n * U), { value: 30000n, short: 2n * U })
  })
})
