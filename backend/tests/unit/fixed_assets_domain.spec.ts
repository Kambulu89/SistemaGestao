import { test } from '@japa/runner'
import {
  addMonths,
  buildSchedule,
  disposalResult,
  isMonth,
  monthEnd,
  monthsBetween,
} from '#modules/accounting/domain/fixed_assets'

const sum = (rows: { amount: bigint }[]) => rows.reduce((a, r) => a + r.amount, 0n)

test.group('contabilidade | activos fixos (puro)', () => {
  test('meses: soma, intervalo, último dia e formato', ({ assert }) => {
    assert.equal(addMonths('2026-11', 3), '2027-02')
    assert.equal(addMonths('2026-01', -1), '2025-12')
    assert.equal(monthsBetween('2026-01', '2026-12'), 12)
    assert.equal(monthsBetween('2026-05', '2026-04'), 0)
    assert.equal(monthEnd('2028-02'), '2028-02-29')
    assert.equal(monthEnd('2026-04'), '2026-04-30')
    assert.isTrue(isMonth('2026-12'))
    assert.isFalse(isMonth('2026-13'))
  })

  test('linha recta: quota constante, residual respeitado, soma exacta', ({ assert }) => {
    // 1000,00 com residual 100,00 em 36 meses (2 casas): 25,00 por mês.
    const rows = buildSchedule({
      cost: 100000n,
      residual: 10000n,
      lifeMonths: 36,
      method: 'STRAIGHT_LINE',
      factor: null,
      startMonth: '2026-03',
    })
    assert.lengthOf(rows, 36)
    assert.isTrue(rows.every((r) => r.amount === 2500n))
    assert.equal(rows[0].month, '2026-03')
    assert.equal(rows[35].month, '2029-02')
    assert.equal(rows[35].bookValue, 10000n)
    assert.equal(sum(rows), 90000n)
  })

  test('linha recta com dízima: as quotas diferem no máximo numa unidade e somam o valor', ({
    assert,
  }) => {
    const rows = buildSchedule({
      cost: 100000n,
      residual: 0n,
      lifeMonths: 3,
      method: 'STRAIGHT_LINE',
      factor: null,
      startMonth: '2026-01',
    })
    assert.deepEqual(
      rows.map((r) => r.amount),
      [33333n, 33334n, 33333n]
    )
    assert.equal(rows[2].accumulated, 100000n)
  })

  test('degressivo: quota anual sobre o líquido, passa à linha recta e acaba no residual', ({
    assert,
  }) => {
    // 12 000,00 em 60 meses, coeficiente 2,00 (40% ao ano).
    const rows = buildSchedule({
      cost: 1200000n,
      residual: 0n,
      lifeMonths: 60,
      method: 'DECLINING_BALANCE',
      factor: 200n,
      startMonth: '2026-01',
    })
    assert.lengthOf(rows, 60)
    assert.equal(rows[0].amount, 40000n) // ano 1: 12 000 × 40% / 12
    assert.equal(rows[12].amount, 24000n) // ano 2: 7 200 × 40% / 12
    assert.equal(rows[24].amount, 14400n) // ano 3: 4 320 × 40% / 12
    assert.equal(rows[36].amount, 10800n) // ano 4: linha recta (2 592 / 24) é maior
    assert.equal(rows[59].amount, 10800n)
    assert.equal(sum(rows), 1200000n)
    assert.equal(rows[59].bookValue, 0n)
  })

  test('degressivo com residual: nunca desce abaixo do residual', ({ assert }) => {
    const rows = buildSchedule({
      cost: 1000000n,
      residual: 300000n,
      lifeMonths: 24,
      method: 'DECLINING_BALANCE',
      factor: 300n,
      startMonth: '2026-01',
    })
    assert.equal(sum(rows), 700000n)
    assert.isTrue(rows.every((r) => r.bookValue >= 300000n && r.amount > 0n))
    assert.equal(rows[rows.length - 1].bookValue, 300000n)
  })

  test('sem valor a depreciar não há mapa', ({ assert }) => {
    assert.lengthOf(
      buildSchedule({
        cost: 5000n,
        residual: 5000n,
        lifeMonths: 12,
        method: 'STRAIGHT_LINE',
        factor: null,
        startMonth: '2026-01',
      }),
      0
    )
  })

  test('abate: ganho, perda ou neutro conforme o valor de venda e o líquido', ({ assert }) => {
    assert.deepEqual(disposalResult(100000n, 60000n, 50000n), {
      bookValue: 40000n,
      gain: 10000n,
      loss: 0n,
    })
    assert.deepEqual(disposalResult(100000n, 60000n, 0n), {
      bookValue: 40000n,
      gain: 0n,
      loss: 40000n,
    })
    assert.deepEqual(disposalResult(100000n, 100000n, 0n), { bookValue: 0n, gain: 0n, loss: 0n })
  })
})
