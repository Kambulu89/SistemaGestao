import { test } from '@japa/runner'
import {
  daysBetween,
  initiativeOf,
  lineAmount,
  noticeFacts,
  prorate,
  scaled,
  scaledText,
  serviceLength,
  settlementLineIssues,
  settlementTotals,
  yearFraction,
} from '#modules/hr/domain/termination'

const codes = (issues: { code: string }[]) => issues.map((i) => i.code)

test.group('RH | domínio da cessação (7.11)', () => {
  test('contagens de datas: dias, antiguidade e fracção do ano', ({ assert }) => {
    assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30)
    assert.deepInclude(serviceLength('2020-01-01', '2020-12-31'), {
      years: 1,
      months: 0,
      days: 0,
      totalDays: 366,
    })
    assert.deepInclude(serviceLength('2026-01-05', '2026-11-30'), {
      years: 0,
      months: 10,
      days: 26,
    })
    assert.deepInclude(serviceLength('2025-01-31', '2025-02-27'), { months: 0, days: 28 })
    assert.deepEqual(yearFraction('2020-06-01', '2026-06-30'), { worked: 181, total: 365 })
    assert.deepEqual(yearFraction('2024-03-01', '2024-12-31'), { worked: 306, total: 366 })
    assert.deepEqual(yearFraction('2027-01-01', '2026-06-30'), { worked: 0, total: 365 })
  })

  test('aviso prévio: dias dados, exigidos e falta (sem valores legais no código)', ({
    assert,
  }) => {
    assert.deepEqual(noticeFacts('2026-10-01', '2026-11-30', 60), {
      required: 60,
      given: 61,
      shortfall: 0,
    })
    assert.deepEqual(noticeFacts('2026-11-21', '2026-11-30', 30), {
      required: 30,
      given: 10,
      shortfall: 20,
    })
    assert.deepEqual(noticeFacts(null, '2026-11-30', 30), {
      required: 30,
      given: null,
      shortfall: 30,
    })
    assert.deepEqual(noticeFacts(null, '2026-11-30', null), {
      required: null,
      given: null,
      shortfall: null,
    })
  })

  test('aritmética exacta: proporção, quantidade × valor unitário e totais', ({ assert }) => {
    assert.equal(prorate(2200n, 181, 365), 1091n) // 22 dias × 181/365 = 10,9096…
    assert.equal(prorate(100n, 1, 2), 50n)
    assert.equal(prorate(1n, 1, 2), 1n) // meio para cima
    assert.equal(scaled('6666.6667', 4), 66666667n)
    assert.isNull(scaled('1.23456', 4))
    assert.isNull(scaled('-1', 2))
    assert.equal(scaledText(66666667n, 4), '6666.6667')
    assert.equal(lineAmount(1000n, 66666667n), 6666667n) // 10 × 6 666,6667 = 66 666,667 → 66 666,67
    assert.equal(lineAmount(50n, 10001n), 50n) // 0,5 × 1,0001 = 0,50005 → 0,50
    assert.equal(lineAmount(100n, 5000n), 50n) // 1 × 0,5 = 0,50
    assert.equal(lineAmount(1n, 5000n), 1n) // 0,01 × 0,5 = 0,005 → 0,01 (meio para cima)
    assert.deepEqual(
      settlementTotals([
        { kind: 'UNUSED_VACATION', amount: '66666.67' },
        { kind: 'INDEMNITY', amount: '400000.00' },
        { kind: 'NOTICE_DEDUCTION', amount: '1000.50' },
      ]),
      { earnings: 46666667n, deductions: 100050n, net: 46566617n }
    )
  })

  test('linhas: tipo × componente, indemnização só se aplicável, par quantidade/valor', ({
    assert,
  }) => {
    const base = {
      kind: 'UNUSED_VACATION',
      componentKind: 'EARNING',
      quantity: 1000n,
      rate: 66666667n,
      amount: 6666667n,
      indemnityApplicable: false,
    }
    assert.lengthOf(settlementLineIssues(base), 0)
    assert.include(codes(settlementLineIssues({ ...base, kind: 'X' })), 'INVALID')
    assert.include(
      codes(settlementLineIssues({ ...base, componentKind: 'DEDUCTION' })),
      'KIND_MISMATCH'
    )
    assert.include(
      codes(settlementLineIssues({ ...base, kind: 'NOTICE_DEDUCTION' })),
      'KIND_MISMATCH'
    )
    assert.include(
      codes(settlementLineIssues({ ...base, kind: 'INDEMNITY' })),
      'INDEMNITY_NOT_APPLICABLE'
    )
    assert.lengthOf(
      settlementLineIssues({ ...base, kind: 'INDEMNITY', indemnityApplicable: true }),
      0
    )
    assert.include(codes(settlementLineIssues({ ...base, rate: null })), 'PAIR')
    assert.include(codes(settlementLineIssues({ ...base, amount: 6666600n })), 'AMOUNT_MISMATCH')
    assert.lengthOf(settlementLineIssues({ ...base, quantity: null, rate: null }), 0)
  })

  test('iniciativa derivada do motivo', ({ assert }) => {
    assert.equal(initiativeOf('RESIGNATION'), 'EMPLOYEE')
    assert.equal(initiativeOf('MUTUAL_AGREEMENT'), 'MUTUAL')
    assert.equal(initiativeOf('DISMISSAL_DISCIPLINARY'), 'EMPLOYER')
    assert.equal(initiativeOf('DEATH'), 'OTHER')
  })
})
