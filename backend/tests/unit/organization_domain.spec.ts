import { test } from '@japa/runner'
import {
  ancestorsOf,
  isValidNodeCode,
  organizationIssues,
  wouldCreateCycle,
} from '#core/organization/domain/organization'
import { decide } from '#core/permissions/domain/decision'
import { evaluateCondition, validateCondition } from '#core/permissions/domain/condition'

const parents = new Map<string, string | null>([
  ['root', null],
  ['mid', 'root'],
  ['leaf', 'mid'],
  ['other', null],
])

test.group('organização | árvore', (_group) => {
  test('antepassados do pai imediato para cima', ({ assert }) => {
    assert.deepEqual(ancestorsOf(parents, 'leaf'), ['mid', 'root'])
    assert.deepEqual(ancestorsOf(parents, 'root'), [])
    assert.deepEqual(ancestorsOf(parents, 'inexistente'), [])
  })

  test('deteta ciclos: si próprio e descendentes', ({ assert }) => {
    assert.isTrue(wouldCreateCycle(parents, 'root', 'root'))
    assert.isTrue(wouldCreateCycle(parents, 'root', 'leaf'))
    assert.isTrue(wouldCreateCycle(parents, 'mid', 'leaf'))
    assert.isFalse(wouldCreateCycle(parents, 'leaf', 'root'))
    assert.isFalse(wouldCreateCycle(parents, 'mid', 'other'))
    assert.isFalse(wouldCreateCycle(parents, 'mid', null))
  })

  test('não entra em ciclo infinito com dados já corrompidos', ({ assert }) => {
    const broken = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ])
    assert.deepEqual(ancestorsOf(broken, 'a'), ['b'])
  })
})

test.group('organização | campos', () => {
  test('códigos', ({ assert }) => {
    assert.isTrue(isValidNodeCode('FIL-01'))
    for (const bad of ['', ' x', 'a b', '-x', 'x'.repeat(41)])
      assert.isFalse(isValidNodeCode(bad), bad)
  })

  test('país, moeda e mês fiscal', ({ assert }) => {
    const ok = { code: 'A', legalName: 'X', countryCode: 'AO', baseCurrency: 'AOA' }
    assert.deepEqual(organizationIssues(ok), [])
    const codes = (v: object) => organizationIssues({ ...ok, ...v }).map((i) => i.code)
    assert.include(codes({ countryCode: 'ao' }), 'INVALID_COUNTRY')
    assert.include(codes({ baseCurrency: 'KZ' }), 'INVALID_CURRENCY')
    assert.include(codes({ fiscalYearStartMonth: 0 }), 'INVALID_MONTH')
    assert.include(codes({ fiscalYearStartMonth: 12.5 }), 'INVALID_MONTH')
    assert.deepEqual(organizationIssues({ legalName: 'Novo' }, true), [])
  })
})

test.group('autorização | âmbito de unidades', () => {
  const grant = {
    permissionCode: 'organization.read',
    roleId: 'r',
    roleCode: 'leitor',
    assignmentId: 'a',
    unitId: null,
  }
  const ctx = (unitId?: string) => ({
    subject: { membershipId: 'm1', unitIds: ['u1', 'u2'] },
    resource: unitId ? { unitId } : {},
    env: {},
  })
  const base = { permission: 'organization.read', grants: [grant], policies: [] }

  test('recurso numa unidade fora do âmbito é recusado', ({ assert }) => {
    const scope = { kind: 'UNITS' as const, unitIds: ['u1', 'u2'] }
    assert.isTrue(decide({ ...base, context: ctx('u1'), unitScope: scope }).allowed)
    const out = decide({ ...base, context: ctx('u9'), unitScope: scope })
    assert.strictEqual(out.reason, 'UNIT_OUT_OF_SCOPE')
    assert.isFalse(
      decide({ ...base, context: ctx('u1'), unitScope: { kind: 'UNITS', unitIds: [] } }).allowed
    )
  })

  test('ALL e a ausência de unidade no recurso não limitam', ({ assert }) => {
    assert.isTrue(decide({ ...base, context: ctx('u9'), unitScope: { kind: 'ALL' } }).allowed)
    assert.isTrue(
      decide({ ...base, context: ctx(), unitScope: { kind: 'UNITS', unitIds: [] } }).allowed
    )
  })

  test('"in" aceita uma variável que seja lista (subject.unitIds)', ({ assert }) => {
    const cond = {
      op: 'in' as const,
      left: { var: 'resource.unitId' },
      right: { var: 'subject.unitIds' },
    }
    assert.deepEqual(validateCondition(cond), [])
    assert.isTrue(evaluateCondition(cond, ctx('u2')))
    assert.isFalse(evaluateCondition(cond, ctx('u9')))
    assert.isFalse(evaluateCondition(cond, ctx()))
    assert.include(
      validateCondition({ op: 'in', left: { var: 'resource.x' }, right: { value: 'texto' } }).map(
        (i) => i.code
      ),
      'IN_NEEDS_LIST'
    )
  })
})
