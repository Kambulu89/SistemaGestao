import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { deleteTenantRows } from '#tests/support/membership_fixture'
import { capture } from '#tests/support/capture'
import { ApiError } from '#core/http/api_error'
import {
  ChangeTenantStatus,
  CreateTenant,
  LucidTenantStore,
  RegisterTenantDomain,
  VerifyTenantDomain,
} from '#platform/tenants/index'

const store = new LucidTenantStore()
let counter = 0
const code = () => `t_${process.pid}_${Date.now()}_${counter++}`

const cleanup = () => deleteTenantRows('t\\_%')

test.group('tenants | plano de controlo', (group) => {
  group.each.setup(() => cleanup)

  test('cria um tenant em PROVISIONING com valores por omissão', async ({ assert }) => {
    const tenant = await new CreateTenant(store).execute({ code: code(), name: ' Empresa ' })
    assert.strictEqual(tenant.status, 'PROVISIONING')
    assert.strictEqual(tenant.name, 'Empresa')
    assert.strictEqual(tenant.defaultLocale, 'pt-AO')
    assert.strictEqual(tenant.timezone, 'Africa/Luanda')
    assert.strictEqual(tenant.version, 1)
  })

  test('código repetido devolve 409 e código inválido 422', async ({ assert }) => {
    const c = code()
    await new CreateTenant(store).execute({ code: c, name: 'A' })

    const duplicate = (await capture(() =>
      new CreateTenant(store).execute({ code: c.toUpperCase(), name: 'B' })
    )) as ApiError
    assert.strictEqual(duplicate.status, 409)
    assert.strictEqual(duplicate.code, 'TENANT_CODE_TAKEN')

    const invalid = (await capture(() =>
      new CreateTenant(store).execute({ code: 'com-hifen', name: 'B' })
    )) as ApiError
    assert.strictEqual(invalid.status, 422)
  })

  test('as transições seguem a máquina de estados e incrementam a versão', async ({ assert }) => {
    const c = code()
    await new CreateTenant(store).execute({ code: c, name: 'A' })
    const change = new ChangeTenantStatus(store)

    const skip = (await capture(() => change.execute(c, 'SUSPENDED'))) as ApiError
    assert.strictEqual(skip.status, 409)
    assert.strictEqual(skip.code, 'INVALID_STATE_TRANSITION')

    const active = await change.execute(c, 'ACTIVE')
    assert.strictEqual(active.version, 2)
    const suspended = await change.execute(c, 'SUSPENDED')
    assert.strictEqual(suspended.status, 'SUSPENDED')
    assert.strictEqual((await change.execute(c, 'ACTIVE')).status, 'ACTIVE')

    await change.execute(c, 'CLOSING')
    await change.execute(c, 'CLOSED')
    const reopened = (await capture(() => change.execute(c, 'ACTIVE'))) as ApiError
    assert.strictEqual(reopened.code, 'INVALID_STATE_TRANSITION')

    const row = await db.connection('owner').from('tenants').where('code', c).first()
    assert.isNotNull(row.activated_at)
  })

  test('um tenant inexistente devolve 404', async ({ assert }) => {
    const error = (await capture(() =>
      new ChangeTenantStatus(store).execute('nao_existe_xyz', 'ACTIVE')
    )) as ApiError
    assert.strictEqual(error.status, 404)
  })

  test('o domínio é único globalmente (409), mesmo entre tenants e com maiúsculas', async ({
    assert,
  }) => {
    const a = code()
    const b = code()
    await new CreateTenant(store).execute({ code: a, name: 'A' })
    await new CreateTenant(store).execute({ code: b, name: 'B' })
    const register = new RegisterTenantDomain(store)
    const host = `empresa-${a}.exemplo.test`.replaceAll('_', '-')

    const first = await register.execute({ code: a, hostname: host })
    assert.isTrue(first.domain.isPrimary)
    assert.isNull(first.domain.verifiedAt)

    for (const [tenant, hostname] of [
      [a, host],
      [b, host.toUpperCase()],
    ]) {
      const error = (await capture(() => register.execute({ code: tenant, hostname }))) as ApiError
      assert.strictEqual(error.status, 409)
      assert.strictEqual(error.code, 'DOMAIN_ALREADY_REGISTERED')
    }

    const second = await register.execute({ code: a, hostname: `outro.${host}` })
    assert.isFalse(second.domain.isPrimary)
  })

  test('hostname inválido devolve 422', async ({ assert }) => {
    const c = code()
    await new CreateTenant(store).execute({ code: c, name: 'A' })
    const error = (await capture(() =>
      new RegisterTenantDomain(store).execute({ code: c, hostname: 'http://x.pt' })
    )) as ApiError
    assert.strictEqual(error.status, 422)
  })

  test('a verificação exige o token certo, guarda só o hash e consome-o', async ({ assert }) => {
    const c = code()
    await new CreateTenant(store).execute({ code: c, name: 'A' })
    const hostname = `v-${c.replaceAll('_', '-')}.exemplo.test`
    const { verificationToken } = await new RegisterTenantDomain(store).execute({
      code: c,
      hostname,
    })

    const stored = await db
      .connection('owner')
      .from('tenant_domains')
      .where('hostname', hostname)
      .first()
    assert.notInclude(stored.verification_token_hash, verificationToken)

    const verify = new VerifyTenantDomain(store)
    const wrong = (await capture(() =>
      verify.execute({ hostname, verificationToken: 'errado' })
    )) as ApiError
    assert.strictEqual(wrong.code, 'INVALID_VERIFICATION_TOKEN')

    await verify.execute({ hostname, verificationToken })
    const after = await db
      .connection('owner')
      .from('tenant_domains')
      .where('hostname', hostname)
      .first()
    assert.isNotNull(after.verified_at)
    assert.isNull(after.verification_token_hash)
  })
})
