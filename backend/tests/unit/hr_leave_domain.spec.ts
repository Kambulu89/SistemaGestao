import { test } from '@japa/runner'
import {
  calendarDays,
  carryover,
  daysCents,
  daysText,
  entitlementFor,
  requestIssues,
  serviceMonthsInHireYear,
} from '#modules/hr/domain/leave'

const rules = (extra: Record<string, unknown> = {}) => ({
  annualDays: '22',
  firstYearRule: 'PROPORTIONAL_MONTHS' as const,
  firstYearDaysPerMonth: null,
  rounding: 'NONE' as const,
  ...extra,
})

test.group('RH | domínio das férias (7.4)', () => {
  test('meses completos no ano de admissão', ({ assert }) => {
    assert.equal(serviceMonthsInHireYear('2025-01-01'), 12)
    assert.equal(serviceMonthsInHireYear('2025-01-02'), 11)
    assert.equal(serviceMonthsInHireYear('2025-03-15'), 9)
    assert.equal(serviceMonthsInHireYear('2025-12-01'), 1)
    assert.equal(serviceMonthsInHireYear('2025-12-31'), 0)
  })

  test('direito: anual, proporcional com arredondamentos, por mês com tecto, admitido depois', ({
    assert,
  }) => {
    const t = (r: Record<string, unknown>, hire: string, year = 2025) =>
      daysText(entitlementFor(rules(r) as never, hire, year))
    assert.equal(t({}, '2020-05-10'), '22.00')
    assert.equal(t({}, '2026-01-01'), '0.00')
    assert.equal(t({ firstYearRule: 'FULL' }, '2025-11-20'), '22.00')
    // 22 × 9/12 = 16,5 exacto; 22 × 11/12 = 20,1666…
    assert.equal(t({}, '2025-03-15'), '16.50')
    assert.equal(t({}, '2025-01-02'), '20.17')
    assert.equal(t({ rounding: 'HALF_DAY_UP' }, '2025-01-02'), '20.50')
    assert.equal(t({ rounding: 'DAY_UP' }, '2025-01-02'), '21.00')
    assert.equal(t({ rounding: 'DAY_UP' }, '2025-03-15'), '17.00')
    // Dias por mês completo, nunca acima do anual.
    assert.equal(
      t({ firstYearRule: 'DAYS_PER_MONTH', firstYearDaysPerMonth: '2' }, '2025-07-01'),
      '12.00'
    )
    assert.equal(
      t({ firstYearRule: 'DAYS_PER_MONTH', firstYearDaysPerMonth: '2' }, '2025-01-01'),
      '22.00'
    )
  })

  test('transporte até ao máximo e expiração do resto', ({ assert }) => {
    const c = (balance: string, max: string) => {
      const r = carryover(daysCents(balance)!, max)
      return [daysText(r.carry), daysText(r.expire)]
    }
    assert.deepEqual(c('6.5', '5'), ['5.00', '1.50'])
    assert.deepEqual(c('3', '5'), ['3.00', '0.00'])
    assert.deepEqual(c('0', '5'), ['0.00', '0.00'])
    assert.deepEqual(c('-2', '5'), ['0.00', '0.00'])
    assert.deepEqual(c('4', '0'), ['0.00', '4.00'])
  })

  test('dias em texto com sinal e pedidos no mesmo ano', ({ assert }) => {
    assert.equal(daysText(-150n), '-1.50')
    assert.equal(daysCents('-0.5'), -50n)
    assert.isNull(daysCents('1.234'))
    assert.equal(calendarDays('2026-02-27', '2026-03-02'), 4)
    assert.deepEqual(
      requestIssues('2026-01-02', '2026-01-01').map((i) => i.code),
      ['BEFORE_START']
    )
    assert.deepEqual(
      requestIssues('2026-12-30', '2027-01-02').map((i) => i.code),
      ['CROSS_YEAR']
    )
    assert.deepEqual(
      requestIssues('x', '2026-01-01').map((i) => i.code),
      ['INVALID_DATE']
    )
    assert.deepEqual(requestIssues('2026-01-01', '2026-01-01'), [])
  })
})
