import { BaseSeeder } from '@adonisjs/lucid/seeders'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { ApiError } from '#core/http/api_error'
import { authServices } from '#core/auth/index'
import {
  ChangeTenantStatus,
  CreateTenant,
  LucidTenantStore,
  RegisterTenantDomain,
  addMemberByEmail,
} from '#platform/tenants/index'

/** Dois tenants de demonstração, separados. Os domínios/emails usam TLDs reservados (`.test`, `.invalid`). */
const DEMO = [
  { code: 'demo_a', name: 'Demo A', host: 'demo-a.exemplo.test', admin: 'admin@demo-a.invalid' },
  { code: 'demo_b', name: 'Demo B', host: 'demo-b.exemplo.test', admin: 'admin@demo-b.invalid' },
] as const

/** Conta presente nos dois tenants: serve para exercitar a troca de tenant. */
const MULTI_TENANT_USER = 'multi@demo.invalid'

const ignoreConflict = async (action: () => Promise<unknown>) => {
  try {
    await action()
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error
  }
}

/**
 * Idempotente. Nunca corre em produção. A palavra-passe vem de `DEMO_USER_PASSWORD`
 * (nada de credenciais no código). Papéis e permissões chegam com a fatia 1.4.
 */
export default class DemoSeeder extends BaseSeeder {
  static environment = ['development', 'test']

  async run() {
    if (app.inProduction) throw new Error('Os dados de demonstração não correm em produção.')
    const password = env.get('DEMO_USER_PASSWORD')
    if (!password) {
      throw new Error('Defina DEMO_USER_PASSWORD (12+ caracteres) para criar os utilizadores demo.')
    }

    const store = new LucidTenantStore()
    for (const demo of DEMO) {
      await ignoreConflict(async () => {
        await new CreateTenant(store).execute({ code: demo.code, name: demo.name })
      })
      const tenant = await store.findByCode(demo.code)
      if (tenant?.status === 'PROVISIONING') {
        await new ChangeTenantStatus(store).execute(demo.code, 'ACTIVE')
      }
      await ignoreConflict(async () => {
        await new RegisterTenantDomain(store).execute({ code: demo.code, hostname: demo.host })
      })
      await ignoreConflict(async () => {
        await authServices().createUser.execute({
          email: demo.admin,
          displayName: `Administrador ${demo.name}`,
          password,
          verified: true,
        })
      })
      await ignoreConflict(() => addMemberByEmail(demo.code, demo.admin))
    }

    await ignoreConflict(async () => {
      await authServices().createUser.execute({
        email: MULTI_TENANT_USER,
        displayName: 'Utilizador nos dois tenants',
        password,
        verified: true,
      })
    })
    for (const demo of DEMO) {
      await ignoreConflict(() => addMemberByEmail(demo.code, MULTI_TENANT_USER))
    }
  }
}
