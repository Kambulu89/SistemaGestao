import { test } from '@japa/runner'
import { canTransitionMembership, grantsAccess } from '#core/membership/domain/membership'

test.group('membership | domínio', () => {
  test('transições permitidas e proibidas', ({ assert }) => {
    assert.isTrue(canTransitionMembership('INVITED', 'ACTIVE'))
    assert.isTrue(canTransitionMembership('ACTIVE', 'SUSPENDED'))
    assert.isTrue(canTransitionMembership('SUSPENDED', 'ACTIVE'))
    assert.isTrue(canTransitionMembership('SUSPENDED', 'LEFT'))
    assert.isFalse(canTransitionMembership('INVITED', 'SUSPENDED'))
    assert.isFalse(canTransitionMembership('ACTIVE', 'INVITED'))
    for (const to of ['INVITED', 'ACTIVE', 'SUSPENDED', 'LEFT'] as const) {
      assert.isFalse(canTransitionMembership('LEFT', to), `LEFT → ${to}`)
    }
  })

  test('só ACTIVE dá acesso', ({ assert }) => {
    assert.isTrue(grantsAccess({ status: 'ACTIVE' }))
    for (const status of ['INVITED', 'SUSPENDED', 'LEFT'] as const) {
      assert.isFalse(grantsAccess({ status }))
    }
  })
})
