import { test } from '@japa/runner'
import {
  expiryStatus,
  movementClass,
  periodDays,
  replenishment,
  turnover,
} from '#modules/inventory/domain/reports'

const q = (n: number) => BigInt(Math.round(n * 1_000_000))

test.group('Inventário | domínio dos alertas e relatórios (8.11)', () => {
  test('reposição: ruptura, abaixo do mínimo, coberto pelo que vem a caminho e sugestão até ao máximo', ({
    assert,
  }) => {
    const r = (available: number, incoming: number, min: number | null, max: number | null) =>
      replenishment({
        available: q(available),
        incoming: q(incoming),
        min: min === null ? null : q(min),
        max: max === null ? null : q(max),
      })
    assert.deepEqual(r(46, 0, 50, 120), { status: 'REORDER', suggested: q(74) })
    assert.deepEqual(r(50, 0, 50, null), { status: 'REORDER', suggested: 0n }) // no mínimo: repor, sem alvo acima
    assert.deepEqual(r(51, 0, 50, 120), { status: 'OK', suggested: 0n })
    assert.deepEqual(r(3, 10, 5, null), { status: 'INCOMING', suggested: 0n })
    assert.deepEqual(r(3, 1, 5, 20), { status: 'REORDER', suggested: q(16) })
    assert.deepEqual(r(0, 0, 10, null), { status: 'STOCKOUT', suggested: q(10) })
    assert.deepEqual(r(-2, 0, null, null), { status: 'STOCKOUT', suggested: 0n }) // reservado acima do livre
    assert.deepEqual(r(0, 30, 10, 20), { status: 'STOCKOUT', suggested: 0n }) // em ruptura, mas já vem mais do que o alvo
    assert.deepEqual(r(7, 0, null, null), { status: 'OK', suggested: 0n })
  })

  test('rotação e cobertura em inteiros; validade; dias do período', ({ assert }) => {
    const k = turnover({
      consumption: q(50),
      opening: 0n,
      closing: q(46),
      available: q(46),
      days: 1,
    })
    assert.equal(k.average, q(23))
    assert.equal(k.turnover, '2.17')
    assert.equal(k.daily, q(50))
    assert.equal(k.coverageDays, 1)
    const slow = turnover({
      consumption: q(30),
      opening: q(100),
      closing: q(70),
      available: q(60),
      days: 30,
    })
    assert.equal(slow.turnover, '0.35')
    assert.equal(slow.coverageDays, 60)
    const none = turnover({
      consumption: 0n,
      opening: q(5),
      closing: q(5),
      available: q(5),
      days: 30,
    })
    assert.equal(none.turnover, '0.00')
    assert.isNull(none.coverageDays)
    assert.isNull(
      turnover({ consumption: q(1), opening: 0n, closing: 0n, available: 0n, days: 7 }).turnover
    )
    assert.equal(expiryStatus(-1), 'EXPIRED')
    assert.equal(expiryStatus(0), 'EXPIRING')
    assert.equal(periodDays('2026-01-01', '2026-01-31'), 31)
    assert.equal(periodDays('2026-03-10', '2026-03-10'), 1)
  })

  test('classe do movimento pelo tipo, origem e sentido', ({ assert }) => {
    const c = (
      type: string,
      sourceType: string | null,
      documentOrigin: string | null,
      direction: 'IN' | 'OUT',
      transferLoss = false
    ) => movementClass({ type, sourceType, documentOrigin, direction, transferLoss })
    assert.equal(c('RECEIPT', 'PURCHASE_RECEIPT', null, 'IN'), 'PURCHASE')
    assert.equal(c('RECEIPT', 'STOCK_DOCUMENT', 'PURCHASE', 'IN'), 'PURCHASE')
    assert.equal(c('RECEIPT', 'SALES_RETURN', null, 'IN'), 'CUSTOMER_RETURN')
    assert.equal(c('RECEIPT', 'STOCK_DOCUMENT', 'OPENING', 'IN'), 'OPENING')
    assert.equal(c('RECEIPT', 'TEST', null, 'IN'), 'OTHER_RECEIPT')
    assert.equal(c('ISSUE', 'SALES_DELIVERY', null, 'OUT'), 'SALE')
    assert.equal(c('ISSUE', 'INTERNAL_REQUISITION', null, 'OUT'), 'CONSUMPTION')
    assert.equal(c('ISSUE', 'STOCK_DOCUMENT', 'LOSS', 'OUT'), 'LOSS')
    assert.equal(c('ISSUE', 'STOCK_DOCUMENT', 'RETURN', 'OUT'), 'SUPPLIER_RETURN')
    assert.equal(c('ISSUE', 'STOCK_DOCUMENT', 'SAMPLE', 'OUT'), 'SAMPLE')
    assert.equal(c('ADJUSTMENT', 'STOCK_COUNT', null, 'OUT'), 'ADJUSTMENT_LOSS')
    assert.equal(c('ADJUSTMENT', 'STOCK_COUNT', null, 'IN'), 'ADJUSTMENT_GAIN')
    assert.equal(c('TRANSFER_OUT', 'STOCK_TRANSFER', null, 'OUT'), 'TRANSFER_OUT')
    assert.equal(c('TRANSFER_OUT', 'STOCK_TRANSFER', null, 'IN'), 'TRANSFER_IN')
    assert.equal(c('TRANSFER_IN', 'STOCK_TRANSFER', null, 'OUT', true), 'TRANSFER_LOSS')
    assert.equal(c('STATUS_CHANGE', 'STOCK_STATUS', null, 'IN'), 'OTHER')
  })
})
