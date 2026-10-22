import { test } from '@japa/runner'
import {
  BillingRuleError,
  canTransitionSubscription,
  classifyChange,
  grantsEntitlements,
  limitViolations,
  parseEntitlements,
  parseLimits,
  parsePrice,
} from '#platform/billing/domain/plan'

test.group('billing | domínio', () => {
  test('limites: todas as métricas definidas; null só onde é suportado', ({ assert }) => {
    assert.deepEqual(parseLimits({ members: 5 }), { members: 5 })
    assert.deepEqual(parseLimits({ members: null }), { members: null })
    for (const bad of [
      {},
      { members: -1 },
      { members: 1.5 },
      { members: '3' },
      { x: 1, members: 1 },
      [],
      null,
    ]) {
      assert.throws(() => parseLimits(bad), BillingRuleError)
    }
  })

  test('preço decimal em string, nunca número', ({ assert }) => {
    assert.strictEqual(parsePrice('49.90'), '49.90')
    assert.strictEqual(parsePrice('0'), '0')
    for (const bad of ['-1', '1.23456', 'abc', '', '1e3']) {
      assert.throws(() => parsePrice(bad), BillingRuleError)
    }
  })

  test('direitos: códigos válidos e sem repetições', ({ assert }) => {
    assert.deepEqual(parseEntitlements({ modules: ['sales'], features: ['sales.quotes'] }), {
      modules: ['sales'],
      features: ['sales.quotes'],
    })
    assert.deepEqual(parseEntitlements(undefined), { modules: [], features: [] })
    assert.throws(() => parseEntitlements({ modules: ['a', 'a'] }), BillingRuleError)
    assert.throws(() => parseEntitlements({ modules: ['Maiúscula'] }), BillingRuleError)
  })

  test('estados concedem (ou não) direitos', ({ assert }) => {
    const now = new Date('2026-01-10T00:00:00Z')
    const past = new Date('2026-01-01T00:00:00Z')
    const future = new Date('2026-02-01T00:00:00Z')
    const base = { trialEnd: null, graceEnd: null }
    assert.isTrue(grantsEntitlements({ ...base, status: 'ACTIVE' }, now))
    assert.isTrue(grantsEntitlements({ ...base, status: 'TRIAL' }, now))
    assert.isFalse(grantsEntitlements({ ...base, status: 'TRIAL', trialEnd: past }, now))
    assert.isTrue(grantsEntitlements({ ...base, status: 'PAST_DUE', graceEnd: future }, now))
    assert.isFalse(grantsEntitlements({ ...base, status: 'PAST_DUE', graceEnd: past }, now))
    assert.isFalse(grantsEntitlements({ ...base, status: 'PAST_DUE' }, now))
    assert.isFalse(grantsEntitlements({ ...base, status: 'SUSPENDED' }, now))
    assert.isFalse(grantsEntitlements({ ...base, status: 'CANCELLED' }, now))
  })

  test('excesso de limites e classificação da mudança', ({ assert }) => {
    assert.deepEqual(limitViolations({ members: 3 }, { members: 5 }), [
      { metric: 'members', used: 5, limit: 3 },
    ])
    assert.deepEqual(limitViolations({ members: 5 }, { members: 5 }), [])
    assert.deepEqual(limitViolations({ members: null }, { members: 999 }), [])
    assert.strictEqual(classifyChange({ members: 5 }, { members: 2 }), 'DOWNGRADED')
    assert.strictEqual(classifyChange({ members: 5 }, { members: null }), 'UPGRADED')
    assert.strictEqual(classifyChange({ members: null }, { members: 5 }), 'DOWNGRADED')
    assert.strictEqual(classifyChange({ members: 5 }, { members: 5 }), 'PLAN_CHANGED')
  })

  test('transições da assinatura: cancelada é final', ({ assert }) => {
    assert.isTrue(canTransitionSubscription('ACTIVE', 'PAST_DUE'))
    assert.isTrue(canTransitionSubscription('SUSPENDED', 'ACTIVE'))
    assert.isFalse(canTransitionSubscription('CANCELLED', 'ACTIVE'))
    assert.isFalse(canTransitionSubscription('ACTIVE', 'TRIAL'))
  })
})
