import { test } from '@japa/runner'
import {
  blockReasonIssue,
  normalizeCustomer,
  normalizeInteraction,
  normalizeSegment,
  saleBlocker,
  touchesCredit,
  type CustomerValues,
  type Issue,
} from '#modules/customers/domain/customers'

const PARTY = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-24T10:00:00.000Z')

const customer = (input: Record<string, unknown>, base: CustomerValues | null = null) => {
  const issues: Issue[] = []
  const values = normalizeCustomer(
    { partyId: PARTY, organizationId: ORG, code: 'C-1', ...input },
    base,
    'AOA',
    issues
  )
  return { values, codes: issues.map((i) => `${i.path}:${i.code}`) }
}

test.group('clientes | domínio', () => {
  test('um cliente leva a moeda da organização por omissão e crédito zero', ({ assert }) => {
    const { values, codes } = customer({})
    assert.deepEqual(codes, [])
    assert.deepInclude(values, {
      currency: 'AOA',
      creditLimit: '0',
      paymentTermDays: 0,
      status: 'ACTIVE',
      segmentId: null,
      accountManagerMembershipId: null,
    })
  })

  test('o crédito é dinheiro em texto com até 4 casas; prazo e moeda são validados', ({
    assert,
  }) => {
    assert.deepEqual(customer({ creditLimit: '1500.1234' }).codes, [])
    assert.include(customer({ creditLimit: '1500.12345' }).codes, 'creditLimit:INVALID_MONEY')
    assert.include(customer({ creditLimit: '-1' }).codes, 'creditLimit:INVALID_MONEY')
    assert.include(customer({ creditLimit: 10 }).codes, 'creditLimit:INVALID_MONEY')
    assert.include(customer({ paymentTermDays: -1 }).codes, 'paymentTermDays:INVALID_TERM')
    assert.include(customer({ paymentTermDays: 1.5 }).codes, 'paymentTermDays:INVALID_TERM')
    assert.include(customer({ currency: 'aoa' }).codes, 'currency:INVALID_CURRENCY')
    assert.include(customer({ code: '_x' }).codes, 'code:INVALID_CODE')
  })

  test('só se bloqueia e desbloqueia pelas operações próprias', ({ assert }) => {
    assert.include(customer({ status: 'BLOCKED' }).codes, 'status:USE_BLOCK')
    const created = customer({}).values as CustomerValues
    assert.deepEqual(customer({ status: 'INACTIVE' }, created).codes, [])
    const blocked: CustomerValues = { ...created, status: 'BLOCKED', statusReason: 'Dívida' }
    assert.include(customer({ status: 'ACTIVE' }, blocked).codes, 'status:USE_UNBLOCK')
    assert.deepEqual(customer({ paymentTermDays: 30 }, blocked).codes, [])
  })

  test('tocar em limite ou moeda é mexer em crédito', ({ assert }) => {
    assert.isTrue(touchesCredit({ creditLimit: '1' }))
    assert.isTrue(touchesCredit({ currency: 'USD' }))
    assert.isFalse(touchesCredit({ paymentTermDays: 10 }))
  })

  test('bloqueado e inactivo não aceitam vendas; activo aceita; o bloqueio exige motivo', ({
    assert,
  }) => {
    assert.equal(saleBlocker('BLOCKED')?.code, 'CUSTOMER_BLOCKED')
    assert.equal(saleBlocker('INACTIVE')?.code, 'CUSTOMER_INACTIVE')
    assert.isNull(saleBlocker('ACTIVE'))
    assert.isNotNull(blockReasonIssue('  '))
    assert.isNotNull(blockReasonIssue('x'.repeat(301)))
    assert.isNull(blockReasonIssue('Dívida em atraso'))
  })

  test('segmentos: código imutável, nome obrigatório', ({ assert }) => {
    const issues: Issue[] = []
    const created = normalizeSegment({ code: 'VIP', name: 'Clientes VIP' }, null, issues)
    assert.deepEqual(issues, [])
    assert.deepInclude(created, { code: 'VIP', active: true, description: null })
    const again: Issue[] = []
    const renamed = normalizeSegment({ code: 'OUTRO', name: 'Novo nome' }, created, again)
    assert.equal(renamed?.code, 'VIP')
    const bad: Issue[] = []
    assert.isNull(normalizeSegment({ code: 'A B', name: ' ' }, null, bad))
    assert.sameMembers(
      bad.map((i) => i.code),
      ['INVALID_CODE', 'INVALID_NAME']
    )
  })
})

test.group('interacções | domínio', () => {
  const interaction = (input: Record<string, unknown>) => {
    const issues: Issue[] = []
    const values = normalizeInteraction(
      { partyId: PARTY, channel: 'CALL', subject: 'Chamada', ...input },
      null,
      'owner-1',
      NOW,
      issues
    )
    return { values, codes: issues.map((i) => `${i.path}:${i.code}`) }
  }

  test('uma interacção leva o agora e o responsável por omissão', ({ assert }) => {
    const { values, codes } = interaction({})
    assert.deepEqual(codes, [])
    assert.deepInclude(values, {
      ownerMembershipId: 'owner-1',
      occurredAt: NOW.toISOString(),
      followUpAt: null,
      summary: '',
    })
  })

  test('canal, assunto e datas são validados; o seguimento não precede a interacção', ({
    assert,
  }) => {
    assert.include(interaction({ channel: 'SMS' }).codes, 'channel:INVALID_CHANNEL')
    assert.include(interaction({ subject: '  ' }).codes, 'subject:INVALID_SUBJECT')
    assert.include(interaction({ subject: 'x'.repeat(201) }).codes, 'subject:INVALID_SUBJECT')
    assert.include(interaction({ occurredAt: 'ontem' }).codes, 'occurredAt:INVALID_INSTANT')
    assert.include(interaction({ occurredAt: '2026-12-31T00:00:00Z' }).codes, 'occurredAt:FUTURE')
    assert.include(
      interaction({ occurredAt: '2026-10-20T10:00:00Z', followUpAt: '2026-10-19T10:00:00Z' }).codes,
      'followUpAt:BEFORE_OCCURRED'
    )
    assert.deepEqual(
      interaction({ occurredAt: '2026-10-20T10:00:00Z', followUpAt: '2026-11-01T10:00:00Z' }).codes,
      []
    )
  })
})
