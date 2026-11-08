import { test } from '@japa/runner'
import { contractIssues, previousDay, termExceeded, termsAt } from '#modules/hr/domain/contracts'

const base = {
  baseSalary: '100.00',
  weeklyHours: '40.00',
  workSchedule: 'A',
  endDate: '2026-06-30',
}
const a = (sequence: number, effectiveDate: string, extra: Record<string, string | null>) => ({
  sequence,
  effectiveDate,
  baseSalary: null,
  weeklyHours: null,
  workSchedule: null,
  endDate: null,
  ...extra,
})

test.group('RH | domínio dos contratos (7.3)', () => {
  test('condições numa data: adendas em vigor aplicadas por data de efeito e sequência', ({
    assert,
  }) => {
    const amendments = [
      a(2, '2026-07-01', { endDate: '2026-12-31' }),
      a(1, '2026-03-01', { baseSalary: '120.00' }),
      a(3, '2026-07-01', { baseSalary: '130.00', workSchedule: 'B' }),
    ]
    assert.deepEqual(termsAt(base, amendments, '2026-02-28'), base)
    assert.deepEqual(termsAt(base, amendments, '2026-03-01'), { ...base, baseSalary: '120.00' })
    assert.deepEqual(termsAt(base, amendments, '2026-07-01'), {
      baseSalary: '130.00',
      weeklyHours: '40.00',
      workSchedule: 'B',
      endDate: '2026-12-31',
    })
    // A entrada não é alterada.
    assert.equal(base.baseSalary, '100.00')
  })

  test('regras entre campos: termo, período experimental e horas', ({ assert }) => {
    const codes = (v: Record<string, unknown>) =>
      contractIssues(v).map((i) => `${i.path}:${i.code}`)
    assert.include(
      codes({ contractType: 'FIXED_TERM', startDate: '2026-01-01' }),
      'endDate:REQUIRED'
    )
    assert.deepEqual(codes({ contractType: 'PERMANENT', startDate: '2026-01-01' }), [])
    assert.include(
      codes({ contractType: 'FIXED_TERM', startDate: '2026-02-01', endDate: '2026-01-01' }),
      'endDate:BEFORE_START'
    )
    assert.include(
      codes({
        contractType: 'UNCERTAIN_TERM',
        startDate: '2026-01-01',
        probationEndDate: '2025-12-01',
      }),
      'probationEndDate:BEFORE_START'
    )
    assert.include(codes({ contractType: 'X' }), 'contractType:INVALID')
    assert.include(codes({ weeklyHours: '0' }), 'weeklyHours:INVALID')
    assert.include(codes({ weeklyHours: '168.01' }), 'weeklyHours:INVALID')
    assert.deepEqual(codes({ weeklyHours: '168' }), [])
  })

  test('véspera e termo ultrapassado', ({ assert }) => {
    assert.equal(previousDay('2026-03-01'), '2026-02-28')
    assert.equal(previousDay('2028-03-01'), '2028-02-29')
    assert.equal(previousDay('2027-01-01'), '2026-12-31')
    assert.isTrue(termExceeded('ACTIVE', '2026-01-01', '2026-01-02'))
    assert.isFalse(termExceeded('ACTIVE', '2026-01-02', '2026-01-02'))
    assert.isFalse(termExceeded('ENDED', '2026-01-01', '2026-06-01'))
    assert.isFalse(termExceeded('ACTIVE', null, '2026-06-01'))
  })
})
