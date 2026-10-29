import { test } from '@japa/runner'
import {
  customerCodeOf,
  destinationKind,
  exclusionValue,
  normalizeCampaign,
  normalizeLead,
  normalizeOpportunity,
  normalizeStage,
  planMove,
  sendDecision,
  splitName,
  type Issue,
  type StageRef,
} from '#modules/prospecting/domain/prospecting'

const codes = (run: (issues: Issue[]) => unknown) => {
  const issues: Issue[] = []
  run(issues)
  return issues.map((i) => i.code)
}

test.group('prospecção | leads', () => {
  test('normaliza o email em minúsculas e valida contacto, origem e consentimento', ({
    assert,
  }) => {
    const issues: Issue[] = []
    const lead = normalizeLead(
      {
        name: ' Ana Silva ',
        source: 'web',
        email: 'ANA@Exemplo.INVALID',
        phone: '+244 923 000 000',
      },
      null,
      issues
    )
    assert.deepEqual(issues, [])
    assert.equal(lead?.email, 'ana@exemplo.invalid')
    assert.equal(lead?.name, 'Ana Silva')
    assert.equal(lead?.consentStatus, 'UNKNOWN')
    assert.deepEqual(
      codes((i) => normalizeLead({ name: 'x', source: 'w', email: 'sem' }, null, i)),
      ['INVALID_EMAIL']
    )
    assert.deepEqual(
      codes((i) => normalizeLead({ name: 'x', source: 'w', phone: 'abc' }, null, i)),
      ['INVALID_PHONE']
    )
    assert.deepEqual(
      codes((i) => normalizeLead({ name: '', source: '' }, null, i)),
      ['REQUIRED', 'REQUIRED']
    )
  })

  test('o nome próprio e o apelido separam-se pelo último elemento', ({ assert }) => {
    assert.deepEqual(splitName('João Pedro Santos'), {
      givenNames: 'João Pedro',
      familyName: 'Santos',
    })
    assert.deepEqual(splitName('  Ana   Silva '), { givenNames: 'Ana', familyName: 'Silva' })
    assert.isNull(splitName('Madonna'))
    assert.match(customerCodeOf('123e4567-e89b-12d3-a456-426614174000'), /^L-[0-9A-F]{10}$/)
  })
})

test.group('prospecção | etapas e oportunidades', () => {
  test('uma etapa terminal tem desfecho e só a de ganho pede evidência', ({ assert }) => {
    const ok = normalizeStage(
      {
        code: 'GANHA',
        name: 'Ganha',
        position: 5,
        probability: '1',
        outcome: 'WON',
        requiresEvidence: true,
      },
      null,
      []
    )
    assert.equal(ok?.terminal, true)
    assert.equal(ok?.probability, '1.0000')
    assert.deepEqual(
      codes((i) =>
        normalizeStage(
          { code: 'X', name: 'x', position: 1, probability: '0.5', requiresEvidence: true },
          null,
          i
        )
      ),
      ['ONLY_WON']
    )
    assert.deepEqual(
      codes((i) =>
        normalizeStage({ code: 'X', name: 'x', position: 0, probability: '2' }, null, i)
      ),
      ['INVALID_POSITION', 'INVALID_PROBABILITY']
    )
  })

  test('uma oportunidade tem cliente ou lead, valor em texto exacto e moeda fixa', ({ assert }) => {
    const base = {
      organizationId: 'o',
      customerId: 'c',
      leadId: null,
      name: 'N',
      stageId: 's',
      expectedValue: '10.0000',
      currency: 'AOA',
      expectedCloseDate: null,
    }
    assert.deepEqual(
      codes((i) => normalizeOpportunity({ organizationId: 'o', name: 'x' }, null, 'AOA', i)),
      ['REQUIRED']
    )
    assert.deepEqual(
      codes((i) =>
        normalizeOpportunity(
          { organizationId: 'o', customerId: 'c', name: 'x', expectedValue: '1.00001' },
          null,
          'AOA',
          i
        )
      ),
      ['INVALID_AMOUNT']
    )
    assert.deepEqual(
      codes((i) => normalizeOpportunity({ currency: 'EUR' }, base, 'AOA', i)),
      ['IMMUTABLE']
    )
    const ok = normalizeOpportunity(
      { organizationId: 'o', customerId: 'c', name: 'x', expectedValue: '5.5' },
      null,
      'AOA',
      []
    )
    assert.equal(ok?.expectedValue, '5.5000')
  })

  const stage = (over: Partial<StageRef> = {}): StageRef => ({
    id: 's1',
    outcome: null,
    requiresEvidence: false,
    active: true,
    ...over,
  })

  test('mover: perda com motivo, ganho com evidência quando exigida, nunca a partir de uma etapa fechada', ({
    assert,
  }) => {
    const open = stage()
    assert.deepEqual(planMove(open, stage({ id: 's1' }), {}), { noop: true })
    assert.deepEqual(planMove(open, stage({ id: 's2' }), {}), {
      noop: false,
      lossReason: null,
      winEvidence: null,
    })
    const lost = stage({ id: 's3', outcome: 'LOST' })
    const lostPlan = planMove(open, lost, {})
    assert.isTrue('issues' in lostPlan && lostPlan.issues[0]?.code === 'LOSS_REASON_REQUIRED')
    assert.deepEqual(planMove(open, lost, { lossReason: ' Preço ' }), {
      noop: false,
      lossReason: 'Preço',
      winEvidence: null,
    })
    const won = stage({ id: 's4', outcome: 'WON', requiresEvidence: true })
    const wonPlan = planMove(open, won, { winEvidence: 'ab' })
    assert.isTrue('issues' in wonPlan && wonPlan.issues[0]?.code === 'EVIDENCE_REQUIRED')
    assert.deepEqual(planMove(open, won, { winEvidence: 'Proposta aceite' }), {
      noop: false,
      lossReason: null,
      winEvidence: 'Proposta aceite',
    })
    assert.isTrue(
      'issues' in planMove(stage({ outcome: 'WON' }), stage({ id: 's9' }), {}) &&
        (
          planMove(stage({ outcome: 'WON' }), stage({ id: 's9' }), {}) as { issues: Issue[] }
        ).issues.some((i) => i.code === 'OPPORTUNITY_CLOSED')
    )
    assert.isTrue('issues' in planMove(open, stage({ id: 's5', active: false }), {}))
  })
})

test.group('prospecção | campanhas, consentimento e exclusão', () => {
  test('valida datas, orçamento e canal', ({ assert }) => {
    const ok = normalizeCampaign(
      { name: 'x', channel: 'EMAIL', startsAt: '2026-01-01T00:00:00Z', budget: '10' },
      null,
      'AOA',
      []
    )
    assert.equal(ok?.budget, '10.0000')
    assert.equal(ok?.currency, 'AOA')
    assert.deepEqual(
      codes((i) =>
        normalizeCampaign({ name: 'x', channel: 'FAX', startsAt: 'ontem' }, null, 'AOA', i)
      ),
      ['INVALID', 'INVALID_DATE']
    )
    assert.deepEqual(
      codes((i) =>
        normalizeCampaign(
          {
            name: 'x',
            channel: 'EMAIL',
            startsAt: '2026-02-01T00:00:00Z',
            endsAt: '2026-01-01T00:00:00Z',
          },
          null,
          'AOA',
          i
        )
      ),
      ['BEFORE_START']
    )
  })

  test('as chaves de exclusão normalizam o email e o telefone', ({ assert }) => {
    assert.equal(exclusionValue('EMAIL', ' ANA@Exemplo.invalid '), 'ana@exemplo.invalid')
    assert.isNull(exclusionValue('EMAIL', 'ana'))
    assert.equal(exclusionValue('PHONE', '+244 923-000.000'), '+244923000000')
    assert.equal(exclusionValue('PHONE', '923 000 000'), '923000000')
    assert.isNull(exclusionValue('PHONE', 'abc'))
  })

  test('quem recusou nunca recebe; lead sem consentimento expresso e sem destino também não', ({
    assert,
  }) => {
    const base = { destination: 'a@b.pt', excluded: false }
    assert.equal(sendDecision({ ...base, leadConsent: 'OPT_IN' }), 'SEND')
    assert.equal(sendDecision({ ...base, leadConsent: 'OPT_OUT' }), 'OPTED_OUT')
    assert.equal(sendDecision({ ...base, leadConsent: 'UNKNOWN' }), 'NO_CONSENT')
    assert.equal(sendDecision({ ...base, leadConsent: null }), 'SEND')
    assert.equal(sendDecision({ ...base, leadConsent: null, excluded: true }), 'OPTED_OUT')
    assert.equal(sendDecision({ ...base, leadConsent: 'OPT_IN', excluded: true }), 'OPTED_OUT')
    assert.equal(
      sendDecision({ destination: null, excluded: false, leadConsent: 'OPT_IN' }),
      'NO_DESTINATION'
    )
    assert.equal(destinationKind('EMAIL'), 'EMAIL')
    assert.equal(destinationKind('WHATSAPP'), 'PHONE')
    assert.isNull(destinationKind('EVENT'))
  })
})
