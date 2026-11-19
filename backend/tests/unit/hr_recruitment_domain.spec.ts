import { test } from '@japa/runner'
import {
  STAGE_TRANSITIONS,
  cents,
  money,
  normalizeFields,
  parseInstant,
  REQUISITION_FIELDS,
  remainingPositions,
  requisitionIssues,
  withinRange,
} from '#modules/hr/domain/recruitment'

test.group('RH | domínio do recrutamento (7.2)', () => {
  test('montantes exactos: cêntimos inteiros, 2 casas e comparação sem float', ({ assert }) => {
    assert.equal(cents('0.1'), 10n)
    assert.equal(cents('150000'), 15000000n)
    assert.isNull(cents('1.234'))
    assert.isNull(cents('-5'))
    assert.isNull(cents('1e3'))
    assert.equal(money('200000.5'), '200000.50')
    assert.equal(money('0'), '0.00')
    assert.equal(money('9999999999999999.99'), '9999999999999999.99')
    // 0.1 + 0.2 em float não é 0.3; aqui os limites são exactos.
    assert.isTrue(withinRange('0.30', '0.30', '0.30'))
    assert.isTrue(withinRange('150000.00', '150000', '250000'))
    assert.isFalse(withinRange('250000.01', '150000', '250000'))
    assert.isFalse(withinRange('149999.99', '150000', '250000'))
  })

  test('vaga: normalização, moeda e código em maiúsculas, intervalo e prazo', ({ assert }) => {
    const { values, issues } = normalizeFields(
      {
        code: 'v-01',
        title: '  Analista  ',
        currency: 'aoa',
        salaryMin: '100',
        salaryMax: '90.5',
        quantity: 0,
        deadline: '2026-02-30',
        requirements: '',
      },
      REQUISITION_FIELDS
    )
    assert.equal(values.code, 'V-01')
    assert.equal(values.title, 'Analista')
    assert.equal(values.currency, 'AOA')
    assert.isNull(values.requirements)
    const codes = issues.map((i) => `${i.path}:${i.code}`)
    assert.include(codes, 'quantity:INVALID')
    assert.include(codes, 'deadline:INVALID_DATE')
    const range = requisitionIssues(values, '2026-01-01')
    assert.deepEqual(
      range.map((i) => i.code),
      ['RANGE']
    )
    assert.deepEqual(
      requisitionIssues(
        { salaryMin: '1', salaryMax: '2', deadline: '2025-12-31' },
        '2026-01-01'
      ).map((i) => i.code),
      ['PAST_DATE']
    )
  })

  test('etapas: só transições permitidas; contratar não é manual e estados finais não mudam', ({
    assert,
  }) => {
    assert.include(STAGE_TRANSITIONS.APPLIED, 'SCREENING')
    assert.notInclude(STAGE_TRANSITIONS.APPLIED, 'HIRED')
    assert.notInclude(STAGE_TRANSITIONS.INTERVIEW, 'OFFER')
    for (const stage of Object.values(STAGE_TRANSITIONS)) assert.notInclude(stage, 'HIRED')
    assert.deepEqual(STAGE_TRANSITIONS.HIRED, [])
    assert.deepEqual(STAGE_TRANSITIONS.REJECTED, [])
    assert.deepEqual(STAGE_TRANSITIONS.WITHDRAWN, [])
    assert.equal(remainingPositions(2, 1), 1)
    assert.equal(remainingPositions(1, 3), 0)
  })

  test('entrevistas: data e hora com fuso obrigatório', ({ assert }) => {
    assert.equal(
      parseInstant('2026-11-20T10:00:00+01:00')?.toISOString(),
      '2026-11-20T09:00:00.000Z'
    )
    assert.isNotNull(parseInstant('2026-11-20T10:00Z'))
    assert.isNull(parseInstant('2026-11-20T10:00:00'))
    assert.isNull(parseInstant('20/11/2026 10:00'))
  })
})
