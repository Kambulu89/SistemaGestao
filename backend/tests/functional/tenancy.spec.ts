import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ApiError } from '#core/http/api_error'
import { capture } from '#tests/support/capture'
import {
  LucidTenantDatabase,
  MissingTenantContextError,
  ReservedColumnError,
  TenantContextStore,
} from '#core/tenancy/index'
import {
  MEMBERSHIPS,
  ProbeCustomers,
  ProbeOrders,
  TENANT_A,
  TENANT_B,
  contextFor,
  createProbeSchema,
  dropProbeSchema,
} from '#tests/support/tenancy_fixture'

const store = new TenantContextStore()
const tenantDb = new LucidTenantDatabase(store)
const customers = new ProbeCustomers()
const orders = new ProbeOrders()
const A = contextFor('A')
const B = contextFor('B')

test.group('isolamento por tenant (base de dados)', (group) => {
  group.setup(createProbeSchema)
  group.teardown(dropProbeSchema)
  group.each.setup(async () => {
    await db.connection('owner').rawQuery('truncate probe.orders, probe.customers cascade')
  })

  test('sem contexto de tenant a operação falha antes de tocar na base de dados', async ({
    assert,
  }) => {
    assert.instanceOf(
      await capture(() => tenantDb.run(async () => 'nunca')),
      MissingTenantContextError
    )
    assert.instanceOf(
      await capture(() => tenantDb.run(async (scope) => customers.list(scope))),
      MissingTenantContextError
    )
  })

  test('o tenant vem sempre do contexto e o registo fica atribuído a esse tenant e membership', async ({
    assert,
  }) => {
    const row = await tenantDb.run((scope) => customers.insert(scope, { name: 'Ana' }), A)
    assert.strictEqual(row.tenant_id, TENANT_A)
    assert.strictEqual(row.created_by_membership_id, MEMBERSHIPS.A)
    assert.strictEqual(row.version, 1)
  })

  test('o chamador não pode definir colunas reservadas (tenant_id, version, autor…)', async ({
    assert,
  }) => {
    for (const reserved of ['tenant_id', 'id', 'version', 'created_by_membership_id']) {
      const error = await capture(() =>
        tenantDb.run(
          (scope) => customers.insert(scope, { name: 'x', [reserved]: TENANT_B } as never),
          A
        )
      )
      assert.instanceOf(error, ReservedColumnError)
    }
    const error = await capture(() =>
      tenantDb.run(
        async (scope) => customers.update(scope, TENANT_A, 1, { tenant_id: TENANT_B } as never),
        A
      )
    )
    assert.instanceOf(error, ReservedColumnError)
  })

  test('um tenant não vê, lista nem obtém os registos de outro (404 sem revelar existência)', async ({
    assert,
  }) => {
    const mine = await tenantDb.run((scope) => customers.insert(scope, { name: 'Só do A' }), A)

    assert.isNull(await tenantDb.run((scope) => customers.findById(scope, mine.id), B))
    assert.lengthOf(await tenantDb.run((scope) => customers.list(scope), B), 0)
    const error = await tenantDb
      .run((scope) => customers.getById(scope, mine.id), B)
      .catch((e: unknown) => e)
    assert.instanceOf(error, ApiError)
    assert.strictEqual((error as ApiError).status, 404)
    assert.strictEqual((error as ApiError).code, 'NOT_FOUND')

    assert.lengthOf(await tenantDb.run((scope) => customers.list(scope), A), 1)
  })

  test('a RLS isola sozinha, mesmo sem o filtro do repositório', async ({ assert }) => {
    await tenantDb.run((scope) => customers.insert(scope, { name: 'A1' }), A)
    await tenantDb.run((scope) => customers.insert(scope, { name: 'B1' }), B)

    const count = async (context: typeof A) =>
      tenantDb.run(async (scope) => {
        const result = await scope.trx.rawQuery('select count(*)::int as n from probe.customers')
        return result.rows[0].n as number
      }, context)
    assert.strictEqual(await count(A), 1)
    assert.strictEqual(await count(B), 1)
  })

  test('sem contexto SQL nenhuma linha é visível, nem para a conta dona (FORCE RLS)', async ({
    assert,
  }) => {
    await tenantDb.run((scope) => customers.insert(scope, { name: 'A1' }), A)

    const runtime = await db
      .connection('runtime')
      .rawQuery('select count(*)::int as n from probe.customers')
    const owner = await db
      .connection('owner')
      .rawQuery('select count(*)::int as n from probe.customers')
    assert.strictEqual(runtime.rows[0].n, 0)
    assert.strictEqual(owner.rows[0].n, 0)
  })

  test('WITH CHECK impede escrever uma linha de outro tenant', async ({ assert }) => {
    const error = await capture(() =>
      tenantDb.run(
        (scope) =>
          scope.trx.rawQuery('insert into probe.customers (tenant_id, name) values (?, ?)', [
            TENANT_B,
            'intruso',
          ]),
        A
      )
    )
    assert.match(error.message, /row-level security/)
  })

  test('FK composta: uma linha do tenant A não pode apontar para um registo do tenant B', async ({
    assert,
  }) => {
    const foreign = await tenantDb.run((scope) => customers.insert(scope, { name: 'Do B' }), B)

    const error = await capture(() =>
      tenantDb.run(
        (scope) => orders.insert(scope, { customer_id: foreign.id, title: 'cruzada' }),
        A
      )
    )
    assert.match(error.message, /violates foreign key constraint/)

    // Dentro do mesmo tenant a ligação é permitida.
    const own = await tenantDb.run((scope) => customers.insert(scope, { name: 'Do A' }), A)
    const order = await tenantDb.run(
      (scope) => orders.insert(scope, { customer_id: own.id, title: 'normal' }),
      A
    )
    assert.strictEqual(order.customer_id, own.id)
  })

  test('actualização com expectedVersion: sucesso, conflito 409 e outro tenant 404', async ({
    assert,
  }) => {
    const row = await tenantDb.run((scope) => customers.insert(scope, { name: 'v1' }), A)

    const updated = await tenantDb.run(
      (scope) => customers.update(scope, row.id, 1, { name: 'v2' }),
      A
    )
    assert.deepInclude(updated, { name: 'v2', version: 2, updated_by_membership_id: MEMBERSHIPS.A })
    assert.isAtLeast(updated.updated_at.getTime(), row.updated_at.getTime())

    const stale = await tenantDb
      .run((scope) => customers.update(scope, row.id, 1, { name: 'perdido' }), A)
      .catch((e: unknown) => e)
    assert.instanceOf(stale, ApiError)
    assert.strictEqual((stale as ApiError).status, 409)
    assert.strictEqual((stale as ApiError).code, 'VERSION_CONFLICT')
    assert.include((stale as ApiError).details[0].message, '2')

    // Um id de outro tenant é 404, nunca 409 (não revela que existe).
    const foreign = await tenantDb
      .run((scope) => customers.update(scope, row.id, 2, { name: 'x' }), B)
      .catch((e: unknown) => e)
    assert.strictEqual((foreign as ApiError).status, 404)

    const after = await tenantDb.run((scope) => customers.getById(scope, row.id), A)
    assert.strictEqual(after.name, 'v2')
  })

  test('duas actualizações concorrentes com a mesma versão: só uma vence', async ({ assert }) => {
    const row = await tenantDb.run((scope) => customers.insert(scope, { name: 'corrida' }), A)
    const attempt = (name: string) =>
      tenantDb
        .run((scope) => customers.update(scope, row.id, 1, { name }), A)
        .then(() => 'ok')
        .catch((e: unknown) => (e as ApiError).code)

    const results = await Promise.all([attempt('x'), attempt('y'), attempt('z')])
    assert.strictEqual(results.filter((r) => r === 'ok').length, 1)
    assert.strictEqual(results.filter((r) => r === 'VERSION_CONFLICT').length, 2)
  })

  test('uma falha anula toda a transacção', async ({ assert }) => {
    const error = await capture(() =>
      tenantDb.run(async (scope) => {
        await customers.insert(scope, { name: 'meio' })
        throw new Error('falha de negócio')
      }, A)
    )
    assert.strictEqual(error.message, 'falha de negócio')
    assert.lengthOf(await tenantDb.run((scope) => customers.list(scope), A), 0)
  })

  test('ligações reutilizadas entre tenants nunca herdam o contexto anterior', async ({
    assert,
  }) => {
    for (let i = 0; i < 30; i++) {
      const [mine, other] = i % 2 === 0 ? [A, B] : [B, A]
      await tenantDb.run((scope) => customers.insert(scope, { name: `n${i}` }), mine)
      const seen = await tenantDb.run((scope) => customers.list(scope, { limit: 100 }), other)
      for (const row of seen) assert.strictEqual(row.tenant_id, other.tenantId)
    }
    const a = await tenantDb.run((scope) => customers.list(scope, { limit: 100 }), A)
    const b = await tenantDb.run((scope) => customers.list(scope, { limit: 100 }), B)
    assert.strictEqual(a.length + b.length, 30)
  })

  test('pedidos concorrentes de tenants diferentes só vêem os seus dados', async ({ assert }) => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tenantDb.run((scope) => customers.insert(scope, { name: `c${i}` }), i % 2 === 0 ? A : B)
      )
    )
    const checks = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const context = i % 2 === 0 ? A : B
        return tenantDb
          .run((scope) => customers.list(scope, { limit: 100 }), context)
          .then((rows) => ({ context, rows }))
      })
    )
    for (const { context, rows } of checks) {
      assert.lengthOf(rows, 10)
      for (const row of rows) assert.strictEqual(row.tenant_id, context.tenantId)
    }
  })

  test('usa o contexto do TenantContextStore quando não é passado explicitamente', async ({
    assert,
  }) => {
    const viaStore = await store.run(A, () => tenantDb.run(async (scope) => scope.context.tenantId))
    assert.strictEqual(viaStore, TENANT_A)

    // Um contexto explícito prevalece sobre o do store.
    const explicit = await store.run(A, () =>
      tenantDb.run(async (scope) => scope.context.tenantId, B)
    )
    assert.strictEqual(explicit, TENANT_B)
  })
})
