import { test } from '@japa/runner'
import {
  addMonths,
  maxMonthlyDeduction,
  moneyLabel,
  monthLabel,
  percentLabel,
  periodEnd,
  periodStart,
  schedule,
} from '#modules/hr/domain/loans'

test.group('RH | domínio dos adiantamentos e empréstimos', () => {
  test('meses: início, fim e soma com mudança de ano', ({ assert }) => {
    assert.equal(periodStart('2026-11'), '2026-11-01')
    assert.equal(periodStart('2026-11-17'), '2026-11-01')
    assert.isNull(periodStart('2026-13'))
    assert.isNull(periodStart('11/2026'))
    assert.isNull(periodStart(202611))
    assert.equal(addMonths('2026-11-01', 2), '2027-01-01')
    assert.equal(addMonths('2026-01-01', -1), '2025-12-01')
    assert.equal(addMonths('2026-01-01', 24), '2028-01-01')
    assert.equal(periodEnd('2028-02-01'), '2028-02-29')
    assert.equal(periodEnd('2026-12-01'), '2026-12-31')
  })

  test('plano: partes iguais ao cêntimo, resto na última, soma exacta', ({ assert }) => {
    assert.deepEqual(schedule('100000.00', 3, '2026-11-01'), [
      { sequence: 1, duePeriod: '2026-11-01', amount: '33333.33' },
      { sequence: 2, duePeriod: '2026-12-01', amount: '33333.33' },
      { sequence: 3, duePeriod: '2027-01-01', amount: '33333.34' },
    ])
    const plan = schedule('1000.01', 7, '2026-01-01')
    const total = plan.reduce((a, p) => a + Math.round(Number(p.amount) * 100), 0)
    assert.equal(total, 100001)
    assert.equal(schedule('50000', 1, '2026-05-01')[0].amount, '50000.00')
  })

  test('desconto máximo: percentagem do salário base, arredondada para baixo', ({ assert }) => {
    assert.equal(maxMonthlyDeduction('200000.00', '30'), 6000000n)
    assert.equal(maxMonthlyDeduction('1000.01', '33.33'), 33330n) // 333.303 → 333.30
    assert.equal(maxMonthlyDeduction('1000', '100'), 100000n)
  })

  test('textos das mensagens', ({ assert }) => {
    assert.equal(moneyLabel(10000000n), '100 000,00')
    assert.equal(moneyLabel(5n), '0,05')
    assert.equal(percentLabel('30.00'), '30')
    assert.equal(percentLabel('33.50'), '33,5')
    assert.equal(monthLabel('2026-12-01'), '12/2026')
  })
})
