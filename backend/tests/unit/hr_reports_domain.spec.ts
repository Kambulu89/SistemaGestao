import { test } from '@japa/runner'
import {
  activeAt,
  contractTypeAt,
  headcount,
  percent,
  placementAt,
  turnover,
  type StaffFact,
} from '#modules/hr/domain/reports'

const fact = (id: string, hire: string, exit: string | null, extra: Partial<StaffFact> = {}) =>
  ({
    id,
    hireDate: hire,
    exitDate: exit,
    exitReason: exit ? 'RESIGNATION' : null,
    exitInitiative: exit ? 'EMPLOYEE' : null,
    current: { legalEntityId: 'LE', departmentId: 'D2', positionId: null },
    placements: [],
    contractTypes: [],
    ...extra,
  }) as StaffFact

test.group('RH | domínio dos relatórios (7.12)', () => {
  test('em funções, colocação e contrato numa data', ({ assert }) => {
    const f = fact('a', '2026-01-10', '2026-06-30', {
      placements: [
        {
          validFrom: '2026-01-10',
          validTo: '2026-03-31',
          legalEntityId: 'LE',
          departmentId: 'D1',
          positionId: null,
        },
        {
          validFrom: '2026-04-01',
          validTo: null,
          legalEntityId: 'LE',
          departmentId: 'D3',
          positionId: 'P',
        },
      ],
      contractTypes: [{ start: '2026-01-10', end: '2026-06-30', type: 'FIXED_TERM' }],
    })
    assert.isFalse(activeAt(f, '2026-01-09'))
    assert.isTrue(activeAt(f, '2026-06-30')) // o último dia conta
    assert.isFalse(activeAt(f, '2026-07-01'))
    assert.equal(placementAt(f, '2026-02-01').departmentId, 'D1')
    assert.equal(placementAt(f, '2026-05-01').departmentId, 'D3')
    assert.equal(placementAt(fact('b', '2026-01-01', null), '2026-05-01').departmentId, 'D2')
    assert.equal(contractTypeAt(f, '2026-03-01'), 'FIXED_TERM')
    assert.isNull(contractTypeAt(f, '2026-07-01'))
  })

  test('percentagem exacta, meio para cima', ({ assert }) => {
    assert.equal(percent(1n, 3n), '33.33')
    assert.equal(percent(2n, 3n), '66.67')
    assert.equal(percent(1n, 8n), '12.50')
    assert.equal(percent(0n, 5n), '0.00')
    assert.isNull(percent(1n, 0n))
  })

  test('efectivos e rotatividade por mês e no ano', ({ assert }) => {
    const facts = [
      fact('a', '2025-01-01', null),
      fact('b', '2025-01-01', '2026-01-31'),
      fact('c', '2026-03-15', null),
      fact('d', '2025-06-01', '2026-03-10'),
    ]
    const h = headcount(facts, '2026-02-01')
    assert.equal(h.total, 2)
    assert.deepEqual(h.byDepartment, [{ key: 'D2', count: 2 }])
    const t = turnover(facts, 2026)
    assert.deepInclude(t.months[0], { start: 3, end: 3, hires: 0, exits: 1, rate: '33.33' })
    assert.deepInclude(t.months[2], { start: 2, end: 2, hires: 1, exits: 1 })
    assert.equal(t.hires, 1)
    assert.equal(t.exits, 2)
    // Σ(início + fim): jan 6, fev 4, mar 4, abr..dez 9 × 4 = 36 → 50; média 50/24 = 2,08; taxa 2 × 24 / 50.
    assert.equal(t.averageHeadcount, '2.08')
    assert.equal(t.rate, '96.00')
    assert.deepEqual(t.byInitiative, [{ key: 'EMPLOYEE', count: 2 }])
  })
})
