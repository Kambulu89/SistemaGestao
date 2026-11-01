import { test } from '@japa/runner'
import {
  costText,
  fromDb,
  parseCost,
  parseQty,
  parseSignedQty,
  qtyText,
  roundDiv,
} from '#modules/inventory/domain/decimal'
import {
  locationIssues,
  lotIssues,
  nextCost,
  reservationStatus,
  sourceIssues,
  warehouseIssues,
} from '#modules/inventory/domain/stock'

test.group('inventário | decimais exactos', () => {
  test('quantidades têm até 6 casas e nunca passam por number', ({ assert }) => {
    assert.equal(parseQty('1.5'), 1_500_000n)
    assert.equal(parseQty('0.000001'), 1n)
    assert.isNull(parseQty('0.0000001'))
    assert.isNull(parseQty('-1'))
    assert.isNull(parseQty('1e3'))
    assert.isNull(parseQty(1.5))
    assert.equal(parseSignedQty('-2.25'), -2_250_000n)
    assert.equal(qtyText(-2_250_000n), '-2.250000')
    assert.equal(qtyText(1n), '0.000001')
  })

  test('custos têm até 4 casas e a base de dados lê-se sem perdas', ({ assert }) => {
    assert.equal(parseCost('12.3456'), 123_456n)
    assert.isNull(parseCost('12.34567'))
    assert.isNull(parseCost('-1'))
    assert.equal(costText(123_456n), '12.3456')
    assert.equal(fromDb('10.500000', 6), 10_500_000n)
    assert.equal(fromDb('-0.000001', 6), -1n)
    assert.equal(roundDiv(5n, 2n), 3n)
    assert.equal(roundDiv(4n, 3n), 1n)
  })
})

test.group('inventário | custo médio móvel', () => {
  test('entradas misturam ao custo da entrada', ({ assert }) => {
    // 10 a 5,0000 + 10 a 7,0000 = 20 a 6,0000
    const first = nextCost({ quantity: 0n, avgCost: 0n }, 10_000_000n, 50_000n, false)
    assert.deepEqual(first, { quantity: 10_000_000n, avgCost: 50_000n })
    const second = nextCost(first, 10_000_000n, 70_000n, false)
    assert.deepEqual(second, { quantity: 20_000_000n, avgCost: 60_000n })
  })

  test('saídas não mudam o custo médio', ({ assert }) => {
    const out = nextCost({ quantity: 20_000_000n, avgCost: 60_000n }, -5_000_000n, 60_000n, false)
    assert.deepEqual(out, { quantity: 15_000_000n, avgCost: 60_000n })
  })

  test('a reversão de uma entrada sai ao custo original e recalcula o que resta', ({ assert }) => {
    // 10 a 5 + 10 a 7 → 20 a 6; reverter a entrada de 10 a 7 deixa 10 a 5.
    const reverted = nextCost(
      { quantity: 20_000_000n, avgCost: 60_000n },
      -10_000_000n,
      70_000n,
      true
    )
    assert.deepEqual(reverted, { quantity: 10_000_000n, avgCost: 50_000n })
  })

  test('com saldo negativo a entrada recomeça o custo sobre a própria quantidade', ({ assert }) => {
    const next = nextCost({ quantity: -3_000_000n, avgCost: 40_000n }, 10_000_000n, 90_000n, false)
    assert.equal(next.avgCost, 90_000n)
    assert.equal(next.quantity, 7_000_000n)
  })

  test('o arredondamento do custo médio é ao mais próximo (o meio sobe)', ({ assert }) => {
    // 1 a 0,0001 + 2 a 0,0002 → (1·1 + 2·2)/3 = 1,6667 (em 4 casas)
    const next = nextCost({ quantity: 1_000_000n, avgCost: 1n }, 2_000_000n, 2n, false)
    assert.equal(next.avgCost, 2n)
  })
})

test.group('inventário | validação e reservas', () => {
  test('armazéns, locais e lotes validam códigos, nomes e datas', ({ assert }) => {
    assert.lengthOf(warehouseIssues({ code: 'ARM-1', name: 'Central' }, true), 0)
    assert.isAbove(warehouseIssues({ code: '-x', name: 'Central' }, true).length, 0)
    assert.isAbove(warehouseIssues({ code: 'A', name: '' }, true).length, 0)
    assert.lengthOf(warehouseIssues({ name: 'Novo nome' }, false), 0)
    assert.isAbove(locationIssues({ code: '', name: 'x' }).length, 0)
    assert.lengthOf(
      lotIssues({ code: 'L1', manufacturedOn: '2026-01-01', expiresOn: '2026-12-31' }),
      0
    )
    const reversed = lotIssues({
      code: 'L1',
      manufacturedOn: '2026-12-31',
      expiresOn: '2026-01-01',
    })
    assert.equal(reversed[0]?.code, 'EXPIRY_BEFORE_MANUFACTURE')
    assert.equal(lotIssues({ code: 'L1', expiresOn: '31/12/2026' })[0]?.code, 'INVALID_DATE')
  })

  test('a origem é um tipo em maiúsculas', ({ assert }) => {
    assert.lengthOf(sourceIssues({ sourceType: 'SALES_ORDER' }), 0)
    assert.isAbove(sourceIssues({ sourceType: 'sales order' }).length, 0)
  })

  test('o estado da reserva deriva do que foi consumido e libertado', ({ assert }) => {
    assert.equal(reservationStatus(10n, 0n, 0n, false), 'ACTIVE')
    assert.equal(reservationStatus(10n, 4n, 0n, false), 'ACTIVE')
    assert.equal(reservationStatus(10n, 10n, 0n, false), 'CONSUMED')
    assert.equal(reservationStatus(10n, 4n, 6n, false), 'CONSUMED')
    assert.equal(reservationStatus(10n, 0n, 10n, false), 'RELEASED')
    assert.equal(reservationStatus(10n, 0n, 10n, true), 'EXPIRED')
  })
})
