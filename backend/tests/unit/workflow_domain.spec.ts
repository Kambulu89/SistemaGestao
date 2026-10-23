import { test } from '@japa/runner'
import {
  compareDecimals,
  conditionVariables,
  createsCycle,
  normalizeGraph,
  normalizeScope,
  stageOutcome,
  type TaskStatus,
  type WorkflowIssue,
} from '#dynamic/workflows/domain/workflow'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const stage = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  label: code,
  criteria: 'ALL',
  approvers: [{ type: 'MEMBERSHIP', id: A }],
  ...extra,
})

const codes = (raw: unknown) => {
  const issues: WorkflowIssue[] = []
  normalizeGraph(raw, issues)
  return issues.map((i) => `${i.path}:${i.code}`)
}

test.group('workflows | grafo', () => {
  test('normaliza as etapas e aplica os valores por omissão', ({ assert }) => {
    const issues: WorkflowIssue[] = []
    const graph = normalizeGraph(
      {
        stages: [
          stage('chefia', { label: '  Chefia  ', dueInHours: 24 }),
          stage('direcao', {
            criteria: 'QUORUM',
            quorum: 2,
            approvers: [
              { type: 'MEMBERSHIP', id: A.toUpperCase() },
              { type: 'ROLE', id: B },
            ],
            condition: { op: 'gt', left: { var: 'resource.valor' }, right: { value: '1000' } },
          }),
        ],
        amountField: 'valor',
        currencyField: 'moeda',
      },
      issues
    )
    assert.deepEqual(issues, [])
    assert.equal(graph.stages[0]?.label, 'Chefia')
    assert.isFalse(graph.stages[0]?.allowSelfApproval)
    assert.equal(graph.stages[0]?.dueInHours, 24)
    assert.equal(graph.stages[1]?.approvers[0]?.id, A, 'os ids normalizam-se para minúsculas')
    assert.equal(graph.stages[1]?.quorum, 2)
    assert.equal(graph.amountField, 'valor')
  })

  test('recusa estruturas mal formadas, com o caminho', ({ assert }) => {
    assert.include(codes(null), 'graph:INVALID_GRAPH')
    assert.include(codes({ stages: [] }), 'graph.stages:INVALID_STAGES')
    assert.include(codes({ stages: [stage('a')] }), 'graph.stages[0].code:INVALID_CODE')
    assert.include(
      codes({ stages: [stage('aprova'), stage('aprova')] }),
      'graph.stages[1].code:DUPLICATE_STAGE'
    )
    assert.include(
      codes({ stages: [stage('aprova', { criteria: 'MAJORITY' })] }),
      'graph.stages[0].criteria:INVALID_CRITERIA'
    )
    assert.include(
      codes({ stages: [stage('aprova', { approvers: [] })] }),
      'graph.stages[0].approvers:INVALID_APPROVERS'
    )
    assert.include(
      codes({
        stages: [
          stage('aprova', {
            approvers: [
              { type: 'MEMBERSHIP', id: A },
              { type: 'MEMBERSHIP', id: A },
            ],
          }),
        ],
      }),
      'graph.stages[0].approvers[1]:DUPLICATE_APPROVER'
    )
    assert.include(
      codes({ stages: [stage('aprova', { approvers: [{ type: 'USER', id: A }] })] }),
      'graph.stages[0].approvers[0].type:INVALID_APPROVER_TYPE'
    )
    assert.include(
      codes({ stages: [stage('aprova', { approvers: [{ type: 'ROLE', id: 'x' }] })] }),
      'graph.stages[0].approvers[0].id:INVALID_APPROVER_ID'
    )
    assert.include(
      codes({ stages: [stage('aprova', { criteria: 'QUORUM' })] }),
      'graph.stages[0].quorum:INVALID_QUORUM'
    )
    assert.include(
      codes({ stages: [stage('aprova', { criteria: 'QUORUM', quorum: 2 })] }),
      'graph.stages[0].quorum:INVALID_QUORUM',
      'o quórum não excede os responsáveis'
    )
    assert.include(
      codes({ stages: [stage('aprova', { quorum: 1 })] }),
      'graph.stages[0].quorum:QUORUM_NOT_ALLOWED'
    )
    assert.include(
      codes({ stages: [stage('aprova', { dueInHours: 0 })] }),
      'graph.stages[0].dueInHours:INVALID_DUE'
    )
    assert.include(
      codes({ stages: [stage('aprova', { condition: 'true' })] }),
      'graph.stages[0].condition:INVALID_CONDITION'
    )
    assert.include(
      codes({ stages: [stage('aprova', { codigo: 'eval' })] }),
      'graph.stages[0].codigo:UNKNOWN_KEY'
    )
    assert.include(
      codes({ stages: [stage('aprova')], currencyField: 'moeda' }),
      'graph.currencyField:CURRENCY_WITHOUT_AMOUNT'
    )
  })

  test('lê as variáveis de uma condição', ({ assert }) => {
    assert.deepEqual(
      conditionVariables({
        op: 'and',
        args: [
          { op: 'gt', left: { var: 'resource.valor' }, right: { value: 1 } },
          { op: 'eq', left: { var: 'subject.membershipId' }, right: { var: 'resource.dono' } },
        ],
      }).sort(),
      ['resource.dono', 'resource.valor', 'subject.membershipId']
    )
  })
})

test.group('workflows | resultado de uma etapa', () => {
  const outcome = (criteria: 'ALL' | 'ANY' | 'QUORUM', statuses: TaskStatus[], quorum?: number) =>
    stageOutcome(criteria, quorum, statuses)

  test('ALL: todas aprovam; uma rejeição rejeita; nunca aprova sem tarefas', ({ assert }) => {
    assert.equal(outcome('ALL', ['APPROVED', 'APPROVED']), 'APPROVED')
    assert.equal(outcome('ALL', ['APPROVED', 'OPEN']), 'PENDING')
    assert.equal(outcome('ALL', ['APPROVED', 'CLAIMED']), 'PENDING')
    assert.equal(outcome('ALL', ['REJECTED', 'OPEN']), 'REJECTED')
    assert.equal(outcome('ALL', []), 'PENDING')
  })

  test('ANY: uma aprovação basta; só rejeita quando ninguém mais pode aprovar', ({ assert }) => {
    assert.equal(outcome('ANY', ['APPROVED', 'OPEN']), 'APPROVED')
    assert.equal(outcome('ANY', ['REJECTED', 'OPEN']), 'PENDING')
    assert.equal(outcome('ANY', ['REJECTED', 'REJECTED']), 'REJECTED')
    assert.equal(outcome('ANY', ['OPEN', 'OPEN']), 'PENDING')
  })

  test('QUORUM: n aprovações; rejeita quando já não é possível atingir n', ({ assert }) => {
    assert.equal(outcome('QUORUM', ['APPROVED', 'APPROVED', 'OPEN'], 2), 'APPROVED')
    assert.equal(outcome('QUORUM', ['APPROVED', 'OPEN', 'OPEN'], 2), 'PENDING')
    assert.equal(outcome('QUORUM', ['APPROVED', 'REJECTED', 'OPEN'], 2), 'PENDING')
    assert.equal(outcome('QUORUM', ['APPROVED', 'REJECTED', 'REJECTED'], 2), 'REJECTED')
    assert.equal(outcome('QUORUM', ['REJECTED', 'REJECTED', 'OPEN'], 2), 'REJECTED')
  })
})

test.group('workflows | montantes e delegações', () => {
  test('compara decimais em texto, sem float', ({ assert }) => {
    assert.equal(compareDecimals('10', '10.0000'), 0)
    assert.equal(compareDecimals('9.99', '10'), -1)
    assert.equal(compareDecimals('1000.0001', '1000'), 1)
    assert.equal(compareDecimals('0.1', '0.10'), 0)
    assert.equal(compareDecimals('-1', '1'), -1)
    assert.equal(compareDecimals('-0', '0'), 0)
    assert.equal(compareDecimals('123456789012345.1234', '123456789012345.1235'), -1)
    assert.isNull(compareDecimals('abc', '1'))
    assert.isNull(compareDecimals('1e3', '1'))
  })

  test('detecta ciclos de delegação, directos e longos', ({ assert }) => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]
    assert.isTrue(createsCycle(edges, { from: 'c', to: 'a' }))
    assert.isTrue(createsCycle(edges, { from: 'b', to: 'a' }))
    assert.isTrue(createsCycle([], { from: 'a', to: 'a' }))
    assert.isFalse(createsCycle(edges, { from: 'a', to: 'c' }))
    assert.isFalse(createsCycle(edges, { from: 'd', to: 'a' }))
  })

  test('o âmbito de uma delegação é validado', ({ assert }) => {
    const ok: WorkflowIssue[] = []
    assert.deepEqual(normalizeScope({ workflowCodes: ['despesas'] }, ok), {
      workflowCodes: ['despesas'],
    })
    assert.deepEqual(normalizeScope(undefined, ok), {})
    assert.deepEqual(normalizeScope({ workflowCodes: [] }, ok), {})
    assert.deepEqual(ok, [])
    const bad: WorkflowIssue[] = []
    normalizeScope({ workflowCodes: ['Despesas'] }, bad)
    normalizeScope({ outro: 1 }, bad)
    normalizeScope('tudo', bad)
    assert.lengthOf(bad, 3)
  })
})
