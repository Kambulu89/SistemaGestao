import { test } from '@japa/runner'
import {
  evaluateCondition,
  validateCondition,
  type Condition,
  type EvalContext,
} from '#core/permissions/domain/condition'
import {
  decide,
  forbiddenChanges,
  redactFields,
  type AccessPolicy,
  type Grant,
} from '#core/permissions/domain/decision'

const ctx = (
  resource: Record<string, unknown> = {},
  subject: Record<string, unknown> = {}
): EvalContext => ({
  subject: { membershipId: 'm1', ...subject },
  resource,
  env: { now: '2026-10-22T10:00:00.000Z' },
})

test.group('condições ABAC | validação', () => {
  test('aceita uma árvore válida', ({ assert }) => {
    const ast: Condition = {
      op: 'and',
      args: [
        { op: 'eq', left: { var: 'subject.membershipId' }, right: { var: 'resource.ownerId' } },
        {
          op: 'not',
          arg: { op: 'in', left: { var: 'resource.status' }, right: { value: ['PAID'] } },
        },
      ],
    }
    assert.deepEqual(validateCondition(ast), [])
  })

  test('rejeita operadores, variáveis, estruturas e tamanhos inválidos', ({ assert }) => {
    const codes = (ast: unknown) => validateCondition(ast).map((i) => i.code)
    assert.include(codes({ op: 'eval', code: '1+1' }), 'UNKNOWN_OP')
    assert.include(
      codes({ op: 'eq', left: { var: 'process.env.X' }, right: { value: 1 } }),
      'INVALID_VARIABLE'
    )
    assert.include(
      codes({ op: 'eq', left: { var: 'resource.a b' }, right: { value: 1 } }),
      'INVALID_VARIABLE'
    )
    assert.include(
      codes({ op: 'in', left: { var: 'resource.a' }, right: { value: 'x' } }),
      'IN_NEEDS_LIST'
    )
    assert.include(codes({ op: 'and', args: [] }), 'INVALID_ARGS')
    assert.include(codes('texto'), 'INVALID_NODE')
    assert.include(
      codes({ op: 'eq', left: { value: { x: 1 } }, right: { value: 1 } }),
      'INVALID_VALUE'
    )

    let deep: Condition = { op: 'true' }
    for (let i = 0; i < 10; i++) deep = { op: 'not', arg: deep }
    assert.include(codes(deep), 'TOO_DEEP')

    const wide: Condition = {
      op: 'and',
      args: Array.from({ length: 20 }, () => ({
        op: 'or' as const,
        args: Array.from({ length: 5 }, () => ({ op: 'true' as const })),
      })),
    }
    assert.include(codes(wide), 'TOO_LARGE')
  })
})

test.group('condições ABAC | avaliação', () => {
  test('comparações, lógica e listas', ({ assert }) => {
    const eq: Condition = { op: 'eq', left: { var: 'resource.status' }, right: { value: 'DRAFT' } }
    assert.isTrue(evaluateCondition(eq, ctx({ status: 'DRAFT' })))
    assert.isFalse(evaluateCondition(eq, ctx({ status: 'PAID' })))
    assert.isFalse(evaluateCondition(eq, ctx({})), 'variável em falta nunca é verdadeira')
    assert.isTrue(evaluateCondition({ op: 'not', arg: eq }, ctx({ status: 'PAID' })))
    assert.isTrue(
      evaluateCondition(
        { op: 'in', left: { var: 'resource.status' }, right: { value: ['DRAFT', 'OPEN'] } },
        ctx({ status: 'OPEN' })
      )
    )
    assert.isTrue(
      evaluateCondition({ op: 'exists', arg: { var: 'resource.owner' } }, ctx({ owner: 'x' }))
    )
    assert.isFalse(
      evaluateCondition({ op: 'exists', arg: { var: 'resource.owner' } }, ctx({ owner: null }))
    )
  })

  test('decimais em string comparam-se como números, não como texto', ({ assert }) => {
    const gt: Condition = { op: 'gt', left: { var: 'resource.total' }, right: { value: '99.9900' } }
    assert.isTrue(
      evaluateCondition(gt, ctx({ total: '100.0000' })),
      '"100" > "99.99" (lexicograficamente seria falso)'
    )
    assert.isFalse(evaluateCondition(gt, ctx({ total: '99.9900' })))
    assert.isTrue(
      evaluateCondition(
        { op: 'lte', left: { var: 'resource.total' }, right: { value: '-0.5' } },
        ctx({ total: '-1' })
      )
    )
    assert.isFalse(evaluateCondition(gt, ctx({ total: 100 })), 'tipos diferentes não se comparam')
  })

  test('segregação: o sujeito não coincide com o criador do recurso', ({ assert }) => {
    const own: Condition = {
      op: 'eq',
      left: { var: 'subject.membershipId' },
      right: { var: 'resource.createdByMembershipId' },
    }
    assert.isTrue(evaluateCondition(own, ctx({ createdByMembershipId: 'm1' })))
    assert.isFalse(evaluateCondition(own, ctx({ createdByMembershipId: 'm2' })))
  })

  test('não acede a protótipos nem a propriedades herdadas', ({ assert }) => {
    for (const name of ['resource.constructor', 'resource.__proto__', 'resource.toString']) {
      const cond: Condition = { op: 'exists', arg: { var: name } }
      assert.isFalse(evaluateCondition(cond, ctx({})), name)
    }
  })

  test('uma condição inválida lança em vez de ser avaliada', ({ assert }) => {
    assert.throws(() => evaluateCondition({ op: 'xyz' } as never, ctx()))
  })
})

const grant = (permissionCode: string, extra: Partial<Grant> = {}): Grant => ({
  permissionCode,
  roleId: 'r1',
  roleCode: 'operator',
  assignmentId: 'a1',
  unitId: null,
  ...extra,
})

const policy = (extra: Partial<AccessPolicy>): AccessPolicy => ({
  id: 'p1',
  name: 'política',
  resource: 'invoice',
  action: 'approve',
  effect: 'ALLOW',
  condition: null,
  priority: 0,
  status: 'ACTIVE',
  fieldRules: [],
  ...extra,
})

test.group('decisão RBAC + ABAC', () => {
  const base = { permission: 'invoice.approve', context: ctx({ total: '10.0000' }) }

  test('nega por omissão: sem atribuição não há acesso', ({ assert }) => {
    const decision = decide({ ...base, grants: [], policies: [] })
    assert.isFalse(decision.allowed)
    assert.strictEqual(decision.reason, 'NO_PERMISSION')
    assert.isFalse(decide({ ...base, grants: [grant('invoice.read')], policies: [] }).allowed)
  })

  test('um papel que concede a permissão basta quando não há políticas', ({ assert }) => {
    const decision = decide({ ...base, grants: [grant('invoice.approve')], policies: [] })
    assert.isTrue(decision.allowed)
    assert.deepEqual(decision.grantedBy, [{ roleId: 'r1', roleCode: 'operator' }])
  })

  test('qualquer DENY prevalece, mesmo com ALLOW e prioridade maior', ({ assert }) => {
    const decision = decide({
      ...base,
      grants: [grant('invoice.approve')],
      policies: [
        policy({ id: 'allow', effect: 'ALLOW', priority: 100 }),
        policy({
          id: 'deny',
          effect: 'DENY',
          priority: -5,
          condition: { op: 'gt', left: { var: 'resource.total' }, right: { value: '5' } },
        }),
      ],
    })
    assert.isFalse(decision.allowed)
    assert.strictEqual(decision.reason, 'POLICY_DENY')
    assert.strictEqual(decision.policies[0].id, 'deny')
  })

  test('um DENY cuja condição é falsa não bloqueia; um DENY inválido falha fechado', ({
    assert,
  }) => {
    const falsy: Condition = { op: 'eq', left: { var: 'resource.total' }, right: { value: 'x' } }
    assert.isTrue(
      decide({
        ...base,
        grants: [grant('invoice.approve')],
        policies: [policy({ effect: 'DENY', condition: falsy })],
      }).allowed
    )
    const broken = decide({
      ...base,
      grants: [grant('invoice.approve')],
      policies: [policy({ effect: 'DENY', condition: { op: 'zzz' } as never })],
    })
    assert.isFalse(broken.allowed)
    assert.strictEqual(broken.reason, 'POLICY_ERROR')
  })

  test('com políticas ALLOW aplicáveis, pelo menos uma tem de se verificar', ({ assert }) => {
    const owner: Condition = {
      op: 'eq',
      left: { var: 'subject.membershipId' },
      right: { var: 'resource.ownerId' },
    }
    const policies = [policy({ condition: owner })]
    const grants = [grant('invoice.approve')]
    const mine = decide({
      permission: 'invoice.approve',
      grants,
      policies,
      context: ctx({ ownerId: 'm1' }),
    })
    const other = decide({
      permission: 'invoice.approve',
      grants,
      policies,
      context: ctx({ ownerId: 'm9' }),
    })
    assert.isTrue(mine.allowed)
    assert.isFalse(other.allowed)
    assert.strictEqual(other.reason, 'NO_ALLOW_POLICY_MATCHED')
  })

  test('rascunhos, desactivadas e de outros recursos não se aplicam; * aplica-se a tudo', ({
    assert,
  }) => {
    const grants = [grant('invoice.approve')]
    const denyAll = (extra: Partial<AccessPolicy>) => policy({ effect: 'DENY', ...extra })
    for (const ignored of [
      denyAll({ status: 'DRAFT' }),
      denyAll({ status: 'DISABLED' }),
      denyAll({ resource: 'order' }),
      denyAll({ action: 'cancel' }),
    ]) {
      assert.isTrue(decide({ ...base, grants, policies: [ignored] }).allowed)
    }
    assert.isFalse(
      decide({ ...base, grants, policies: [denyAll({ resource: '*', action: '*' })] }).allowed
    )
  })

  test('atribuição limitada a uma unidade só vale para recursos dessa unidade', ({ assert }) => {
    const grants = [grant('invoice.approve', { unitId: 'u1' })]
    const inUnit = decide({
      permission: 'invoice.approve',
      grants,
      policies: [],
      context: ctx({ unitId: 'u1' }),
    })
    const elsewhere = decide({
      permission: 'invoice.approve',
      grants,
      policies: [],
      context: ctx({ unitId: 'u2' }),
    })
    const noUnit = decide({ permission: 'invoice.approve', grants, policies: [], context: ctx({}) })
    assert.isTrue(inUnit.allowed)
    assert.strictEqual(elsewhere.reason, 'UNIT_MISMATCH')
    assert.isFalse(noUnit.allowed)
  })

  test('regras de campo: ocultar prevalece sobre só leitura; condicionais respeitam a condição', ({
    assert,
  }) => {
    const policies = [
      policy({
        fieldRules: [
          { field: 'salary', mode: 'HIDDEN' },
          { field: 'salary', mode: 'READ_ONLY' },
          { field: 'notes', mode: 'READ_ONLY' },
          {
            field: 'secret',
            mode: 'HIDDEN',
            when: { op: 'eq', left: { var: 'resource.kind' }, right: { value: 'X' } },
          },
        ],
      }),
    ]
    const decision = decide({ ...base, grants: [grant('invoice.approve')], policies })
    assert.deepEqual(decision.hiddenFields, ['salary'])
    assert.deepEqual(decision.readOnlyFields, ['notes'])

    const record = { id: 1, salary: '9000.0000', notes: 'n', name: 'Ana' }
    assert.deepEqual(redactFields(record, decision.hiddenFields), {
      id: 1,
      notes: 'n',
      name: 'Ana',
    })
    assert.deepEqual(forbiddenChanges({ salary: 1, notes: 'x', name: 'Y' }, decision), [
      'salary',
      'notes',
    ])
  })
})
