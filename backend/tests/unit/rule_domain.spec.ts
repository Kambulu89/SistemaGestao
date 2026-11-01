import { test } from '@japa/runner'
import { serviceTenantContext } from '#core/tenancy/index'
import type { FieldSpec } from '#dynamic/metadata/index'
import { RuleEnforcer } from '#dynamic/rules/application/rule_enforcer'
import type { EvaluationRow, Rule, RuleStore } from '#dynamic/rules/application/ports'
import {
  conditionVariables,
  inputHash,
  isEffective,
  normalizeAction,
  type RuleIssue,
} from '#dynamic/rules/domain/rule'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ENTITY = '22222222-2222-4222-8222-222222222222'

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: crypto.randomUUID(),
  entityDefinitionId: ENTITY,
  entityCode: 'encomenda',
  code: 'r',
  name: 'R',
  description: null,
  trigger: 'VALIDATE',
  revision: 1,
  priority: 100,
  conditionAst: { op: 'true' },
  actionAst: { type: 'BLOCK', message: 'bloqueado' },
  status: 'PUBLISHED',
  effectiveFrom: null,
  effectiveTo: null,
  publishedAt: new Date(),
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

test.group('regras | domínio', () => {
  test('a acção é só um bloqueio com mensagem de negócio', ({ assert }) => {
    const issues: RuleIssue[] = []
    assert.deepEqual(
      normalizeAction({ type: 'BLOCK', message: ' Não pode ', field: 'preco' }, issues),
      {
        type: 'BLOCK',
        message: 'Não pode',
        field: 'preco',
      }
    )
    assert.isEmpty(issues)
    for (const bad of [
      null,
      [],
      { type: 'EXEC', message: 'x' },
      { type: 'BLOCK' },
      { type: 'BLOCK', message: 'x', run: 'rm' },
      { type: 'BLOCK', message: 'x', field: 'Mau' },
    ]) {
      const found: RuleIssue[] = []
      assert.isNull(normalizeAction(bad, found), JSON.stringify(bad))
      assert.isNotEmpty(found)
    }
  })

  test('variáveis de uma condição, vigência e resumo estável dos dados', ({ assert }) => {
    const condition = {
      op: 'and',
      args: [
        { op: 'gt', left: { var: 'resource.preco' }, right: { value: 1 } },
        {
          op: 'not',
          arg: { op: 'eq', left: { var: 'subject.userId' }, right: { var: 'resource.preco' } },
        },
      ],
    }
    assert.deepEqual(conditionVariables(condition), ['resource.preco', 'subject.userId'])
    const now = new Date('2026-06-15T00:00:00Z')
    assert.isTrue(isEffective({ effectiveFrom: null, effectiveTo: null }, now))
    assert.isFalse(
      isEffective({ effectiveFrom: new Date('2026-07-01T00:00:00Z'), effectiveTo: null }, now)
    )
    assert.isFalse(isEffective({ effectiveFrom: null, effectiveTo: now }, now)) // o fim é exclusivo
    assert.equal(inputHash({ a: 1, b: 2 }), inputHash({ b: 2, a: 1 }))
    assert.notEqual(inputHash({ a: 1 }), inputHash({ a: 2 }))
  })
})

test.group('regras | aplicação aos registos (falha fechada)', () => {
  const context = serviceTenantContext(TENANT, 'teste')
  const field = (code: string, sensitive = false): FieldSpec =>
    ({ code, type: 'TEXT', sensitive, archived: false }) as FieldSpec

  function enforcer(
    rules: Rule[],
    evaluate: (condition: unknown, resource: Record<string, unknown>) => boolean
  ) {
    const logged: EvaluationRow[] = []
    const store = {
      listPublished: async () => rules,
      insertEvaluations: async (_scope: unknown, rows: EvaluationRow[]) =>
        void logged.push(...rows),
    } as unknown as RuleStore
    const uow = { run: (fn: (scope: unknown) => unknown) => Promise.resolve(fn({})) }
    const engine = {
      validate: () => [],
      evaluate: (condition: unknown, ctx: { resource: Record<string, unknown> }) =>
        evaluate(condition, ctx.resource),
    }
    return { logged, enforcer: new RuleEnforcer(uow as never, store, engine) }
  }
  const input = (values: Record<string, unknown>) => ({
    entity: { id: ENTITY, code: 'encomenda' },
    operation: 'CREATE' as const,
    recordId: null,
    fields: [field('preco'), field('segredo', true)],
    values,
  })

  test('uma condição que não se consegue avaliar bloqueia e fica registada como erro', async ({
    assert,
  }) => {
    const broken = rule({ conditionAst: { op: 'boom' } })
    const { enforcer: e, logged } = enforcer([broken], () => {
      throw new Error('condição inválida')
    })
    const issues = await e.check(context, input({ preco: 1 }))
    assert.deepEqual(
      issues.map((i) => i.code),
      ['RULE_ERROR']
    )
    assert.deepEqual(
      logged.map((l) => [l.result, l.errorCode]),
      [['ERROR', 'CONDITION_ERROR']]
    )
  })

  test('os campos sensíveis nunca chegam às condições e passar não deixa rasto', async ({
    assert,
  }) => {
    let seen: Record<string, unknown> = {}
    const { enforcer: e, logged } = enforcer([rule()], (_c, resource) => {
      seen = resource
      return false
    })
    assert.isEmpty(await e.check(context, input({ preco: 1, segredo: 'confidencial' })))
    assert.deepEqual(seen, { preco: 1 })
    assert.isEmpty(logged)
  })

  test('sem regras em vigor não há trabalho nem registo', async ({ assert }) => {
    const future = rule({ effectiveFrom: new Date(Date.now() + 86_400_000) })
    const { enforcer: e, logged } = enforcer([future], () => true)
    assert.isEmpty(await e.check(context, input({ preco: 1 })))
    assert.isEmpty(logged)
  })
})
