import { test } from '@japa/runner'
import {
  InvalidTenantContextError,
  MissingTenantContextError,
  TenantContext,
  TenantContextStore,
  type TenantContextProps,
} from '#core/tenancy/index'

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const U = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const M = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const props = (override: Partial<TenantContextProps> = {}): TenantContextProps => ({
  tenantId: T1,
  userId: U,
  membershipId: M,
  unitScope: { kind: 'ALL' },
  actorType: 'USER',
  permissionsVersion: 3,
  correlationId: 'corr-0001',
  locale: 'pt-AO',
  ...override,
})

test.group('TenantContext', () => {
  test('cria um contexto válido com todos os campos da spec', ({ assert }) => {
    const ctx = TenantContext.create(props({ organizationId: M }))
    assert.deepInclude(ctx, {
      tenantId: T1,
      userId: U,
      membershipId: M,
      organizationId: M,
      actorType: 'USER',
      permissionsVersion: 3,
      correlationId: 'corr-0001',
      locale: 'pt-AO',
    })
    assert.deepEqual(ctx.unitScope, { kind: 'ALL' })
  })

  test('é imutável, incluindo a lista de unidades', ({ assert }) => {
    const unitIds = [T2]
    const ctx = TenantContext.create(props({ unitScope: { kind: 'UNITS', unitIds } }))

    assert.isTrue(Object.isFrozen(ctx))
    assert.throws(() => {
      ;(ctx as { tenantId: string }).tenantId = T2
    })
    unitIds.push(T1) // alterar a lista original não afecta o contexto
    assert.deepEqual(ctx.unitScope, { kind: 'UNITS', unitIds: [T2] })
    assert.throws(() => {
      ;(ctx.unitScope as unknown as { unitIds: string[] }).unitIds.push(T1)
    })
  })

  test('rejeita ids que não são UUID', ({ assert }) => {
    for (const bad of ['', 'abc', '1', '11111111-1111-4111-8111-11111111111', "x'; drop table--"]) {
      assert.throws(() => TenantContext.create(props({ tenantId: bad })), InvalidTenantContextError)
    }
    assert.throws(() => TenantContext.create(props({ membershipId: 'nao-uuid' })))
    assert.throws(() => TenantContext.create(props({ organizationId: 'nao-uuid' })))
    assert.throws(() =>
      TenantContext.create(props({ unitScope: { kind: 'UNITS', unitIds: [T1, 'nao-uuid'] } }))
    )
  })

  test('valida a versão de autorização, o correlationId e o locale', ({ assert }) => {
    assert.throws(() => TenantContext.create(props({ permissionsVersion: -1 })))
    assert.throws(() => TenantContext.create(props({ permissionsVersion: 1.5 })))
    assert.throws(() => TenantContext.create(props({ correlationId: '  ' })))
    assert.throws(() => TenantContext.create(props({ locale: '' })))
  })

  test('o tipo de actor impõe que identidades são obrigatórias', ({ assert }) => {
    assert.throws(() => TenantContext.create(props({ userId: null })), InvalidTenantContextError)
    assert.throws(
      () => TenantContext.create(props({ membershipId: null })),
      InvalidTenantContextError
    )
    assert.throws(
      () => TenantContext.create(props({ actorType: 'SUPPORT', userId: null, membershipId: null })),
      InvalidTenantContextError
    )
    assert.throws(
      () => TenantContext.create(props({ actorType: 'SERVICE', userId: U, membershipId: null })),
      InvalidTenantContextError
    )
    // Um actor de serviço (jobs) não tem utilizador nem membership.
    const service = TenantContext.create(
      props({ actorType: 'SERVICE', userId: null, membershipId: null })
    )
    assert.isNull(service.userId)
    assert.throws(
      () => TenantContext.create(props({ actorType: 'ROOT' as never })),
      InvalidTenantContextError
    )
  })
})

test.group('TenantContextStore', () => {
  const ctxA = TenantContext.create(props({ tenantId: T1 }))
  const ctxB = TenantContext.create(props({ tenantId: T2 }))

  test('sem contexto falha em vez de assumir um tenant', ({ assert }) => {
    const store = new TenantContextStore()
    assert.isUndefined(store.find())
    assert.throws(() => store.current(), MissingTenantContextError)
  })

  test('propaga o contexto pela cadeia assíncrona e limpa-o no fim', async ({ assert }) => {
    const store = new TenantContextStore()
    const seen = await store.run(ctxA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return store.current().tenantId
    })
    assert.strictEqual(seen, T1)
    assert.isUndefined(store.find())
  })

  test('execuções concorrentes de tenants diferentes não se misturam', async ({ assert }) => {
    const store = new TenantContextStore()
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.run(i % 2 === 0 ? ctxA : ctxB, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
          return [i % 2 === 0 ? T1 : T2, store.current().tenantId]
        })
      )
    )
    for (const [expected, actual] of results) assert.strictEqual(actual, expected)
  })

  test('um run aninhado usa o seu próprio contexto e restaura o exterior', ({ assert }) => {
    const store = new TenantContextStore()
    store.run(ctxA, () => {
      store.run(ctxB, () => assert.strictEqual(store.current().tenantId, T2))
      assert.strictEqual(store.current().tenantId, T1)
    })
  })
})
