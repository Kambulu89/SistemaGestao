import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@japa/runner'
import router from '@adonisjs/core/services/router'
import { PERMISSIONS } from '#modules/rbac/index'
import { FEATURES } from '#modules/subscription/index'
import {
  as,
  cleanDatabase,
  createUser,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'

interface RouteInfo {
  method: string
  pattern: string
  middleware: { name: string; args?: Record<string, string> }[]
}

/** Todas as rotas registadas, com o nome e os argumentos de cada middleware nomeado. */
function routes(): RouteInfo[] {
  const out: RouteInfo[] = []
  for (const list of Object.values(router.toJSON())) {
    for (const route of list as any[]) {
      const store = route.middleware
      const entries: any[] =
        typeof store?.all === 'function' ? [...store.all()] : Array.isArray(store) ? store : []
      const middleware = entries
        .filter((m) => typeof m?.name === 'string')
        .map((m) => ({ name: m.name as string, args: m.args }))
      for (const method of route.methods as string[]) {
        if (method === 'HEAD') continue
        out.push({ method, pattern: route.pattern, middleware })
      }
    }
  }
  return out
}

const key = (r: RouteInfo) => `${r.method} ${r.pattern}`
const has = (r: RouteInfo, name: string) => r.middleware.some((m) => m.name === name)
const argsOf = (r: RouteInfo, name: string) =>
  r.middleware.filter((m) => m.name === name).map((m) => m.args ?? {})

/** Rotas sem sessão (cada uma com limites próprios e respostas genéricas). */
const PUBLIC = new Set([
  'GET /api/v1/health',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/invitations/accept',
])

/** Rotas da conta (sessão, sem empresa em contexto). */
const ACCOUNT = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/logout',
  'GET /api/v1/auth/sessions',
  'DELETE /api/v1/auth/sessions/:id',
  'GET /api/v1/permissions',
])

/**
 * Rotas de empresa sem `can`, e porquê: a autorização é do próprio caso de uso (dados do próprio, aprovador da etapa,
 * acesso herdado do registo). Cada entrada tem testes funcionais que provam a regra.
 */
const SELF_AUTHORIZED: Record<string, string> = {
  'GET /api/v1/context': 'contexto da própria membership',
  'GET /api/v1/me/permissions': 'permissões do próprio',
  'GET /api/v1/me/notifications': 'filtra pelo destinatário',
  'POST /api/v1/me/notifications/read-all': 'só as do destinatário',
  'POST /api/v1/me/notifications/:id/read': 'só as do destinatário (404 nas outras)',
  'GET /api/v1/me/tasks': 'tarefas do próprio',
  'GET /api/v1/hr/employees':
    'âmbito RBAC de hr.* (empresa, entidade, filial, departamento, próprio) verificado no serviço',
  'POST /api/v1/hr/employees':
    'âmbito RBAC de hr.* (empresa, entidade, filial, departamento, próprio) verificado no serviço',
  'GET /api/v1/hr/employees/:id':
    'âmbito RBAC de hr.* (empresa, entidade, filial, departamento, próprio) verificado no serviço',
  'PATCH /api/v1/hr/employees/:id':
    'âmbito RBAC de hr.* (empresa, entidade, filial, departamento, próprio) verificado no serviço',
  'POST /api/v1/hr/employees/:id/status':
    'âmbito RBAC de hr.* (empresa, entidade, filial, departamento, próprio) verificado no serviço',
  'GET /api/v1/hr/requisitions':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/requisitions':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'GET /api/v1/hr/requisitions/:id':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'PATCH /api/v1/hr/requisitions/:id':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/requisitions/:id/submit':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/requisitions/:id/decision':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/requisitions/:id/close':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/requisitions/:id/cancel':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'GET /api/v1/hr/candidates':
    'candidatos de vagas visíveis ou registados pelo próprio (hr.recruitment.*) verificado no serviço',
  'POST /api/v1/hr/candidates': 'hr.recruitment.manage em algum âmbito verificado no serviço',
  'GET /api/v1/hr/candidates/:id':
    'candidatos de vagas visíveis ou registados pelo próprio (hr.recruitment.*) verificado no serviço',
  'PATCH /api/v1/hr/candidates/:id':
    'quem registou ou gere uma vaga do candidato (hr.recruitment.manage) verificado no serviço',
  'GET /api/v1/hr/applications':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/applications':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'GET /api/v1/hr/applications/:id':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/applications/:id/stage':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/applications/:id/interviews':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/applications/:id/evaluations':
    'entrevistador da entrevista ou hr.recruitment.manage no âmbito da vaga, verificado no serviço',
  'POST /api/v1/hr/applications/:id/offers':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'GET /api/v1/hr/interviews/mine': 'só as entrevistas atribuídas ao próprio membro',
  'PATCH /api/v1/hr/interviews/:id':
    'hr.recruitment.manage no âmbito da vaga, ou o entrevistador a marcar a sua como realizada',
  'PATCH /api/v1/hr/offers/:id':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/offers/:id/submit':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/offers/:id/decision':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/offers/:id/response':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/offers/:id/cancel':
    'âmbito RBAC de hr.recruitment.* sobre a colocação da vaga verificado no serviço',
  'POST /api/v1/hr/offers/:id/hire':
    'hr.recruitment.manage no âmbito da vaga e hr.manage na colocação do novo colaborador, verificados no serviço',
  'GET /api/v1/hr/employees/:id/onboarding':
    'âmbito RBAC de hr.read/hr.manage do colaborador verificado no serviço; o responsável conclui a sua tarefa',
  'POST /api/v1/hr/employees/:id/onboarding':
    'âmbito RBAC de hr.read/hr.manage do colaborador verificado no serviço; o responsável conclui a sua tarefa',
  'PATCH /api/v1/hr/onboarding-tasks/:id':
    'âmbito RBAC de hr.read/hr.manage do colaborador verificado no serviço; o responsável conclui a sua tarefa',
  'GET /api/v1/hr/employees/:id/contracts':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'POST /api/v1/hr/employees/:id/contracts':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'GET /api/v1/hr/contracts/:id':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'PATCH /api/v1/hr/contracts/:id':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'POST /api/v1/hr/contracts/:id/activate':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'POST /api/v1/hr/contracts/:id/suspend':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'POST /api/v1/hr/contracts/:id/resume':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'POST /api/v1/hr/contracts/:id/terminate':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'POST /api/v1/hr/contracts/:id/cancel':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'POST /api/v1/hr/contracts/:id/amendments':
    'âmbito RBAC de hr.contracts.read/manage sobre a colocação do colaborador verificado no serviço',
  'GET /api/v1/hr/employees/:id/assignments':
    'âmbito RBAC de hr.read/hr.manage sobre a colocação (antiga e nova) verificado no serviço',
  'POST /api/v1/hr/employees/:id/assignments':
    'âmbito RBAC de hr.read/hr.manage sobre a colocação (antiga e nova) verificado no serviço',
  'GET /api/v1/me/preferences/:key': 'preferências de interface do próprio membro',
  'PUT /api/v1/me/preferences/:key': 'preferências de interface do próprio membro',
  'GET /api/v1/dashboard': 'cada secção exige a permissão e a funcionalidade do módulo dono',
  'GET /api/v1/search': 'cada fonte exige a permissão e a funcionalidade do módulo dono',
  'GET /api/v1/approvals/requests': 'approvals.read vê tudo; os outros só os seus',
  'GET /api/v1/approvals/requests/:id': 'requerente, aprovador ou approvals.read',
  'POST /api/v1/approvals/requests/:id/decisions': 'aprovador da etapa ou delegado',
  'POST /api/v1/approvals/requests/:id/cancel': 'requerente ou approvals.manage',
  'GET /api/v1/approvals/delegations': 'as próprias; todas com approvals.manage',
  'POST /api/v1/approvals/delegations': 'delega as próprias aprovações',
  'POST /api/v1/approvals/delegations/:id/revoke': 'quem delegou ou approvals.manage',
  'GET /api/v1/attachments': 'herda a leitura do registo',
  'POST /api/v1/attachments': 'herda a escrita do registo',
  'GET /api/v1/attachments/:id/content': 'herda a leitura do registo',
  'DELETE /api/v1/attachments/:id': 'herda a escrita do registo',
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

test.group('rotas | protecção declarada', () => {
  test('cada rota é pública por lista, de conta, de plataforma ou de empresa com autorização', ({
    assert,
  }) => {
    const all = routes()
    assert.isAbove(all.length, 50)
    const problems: string[] = []
    const seen = new Set(all.map(key))
    for (const r of all) {
      const k = key(r)
      if (!r.pattern.startsWith('/api/v1/')) problems.push(`${k}: fora de /api/v1`)
      if (PUBLIC.has(k)) {
        if (['auth', 'tenant', 'can', 'platformAdmin'].some((n) => has(r, n)))
          problems.push(`${k}: pública mas com middleware de sessão ou autorização`)
        continue
      }
      if (!has(r, 'auth')) {
        problems.push(`${k}: sem sessão (auth) e não está na lista pública`)
        continue
      }
      if (ACCOUNT.has(k)) continue
      if (r.pattern.startsWith('/api/v1/platform/')) {
        if (!has(r, 'platformAdmin')) problems.push(`${k}: plataforma sem platformAdmin`)
        if (has(r, 'tenant')) problems.push(`${k}: plataforma com contexto de empresa`)
        continue
      }
      if (!has(r, 'tenant')) {
        problems.push(`${k}: sem contexto de empresa (tenant)`)
        continue
      }
      if (!has(r, 'can') && !SELF_AUTHORIZED[k])
        problems.push(`${k}: rota de empresa sem can() nem justificação`)
    }
    for (const k of [...PUBLIC, ...ACCOUNT, ...Object.keys(SELF_AUTHORIZED)])
      if (!seen.has(k)) problems.push(`${k}: entrada de lista que já não existe`)
    assert.deepEqual(problems, [])
  })

  test('permissões e funcionalidades das rotas existem; nenhuma permissão fica sem uso', ({
    assert,
  }) => {
    const codes = new Set(PERMISSIONS.map((p) => p.code))
    const features = new Set(FEATURES.map((f) => f.code))
    const problems: string[] = []
    const usedByRoutes = new Set<string>()
    for (const r of routes()) {
      for (const a of argsOf(r, 'can')) {
        usedByRoutes.add(a.permission)
        if (!codes.has(a.permission))
          problems.push(`${key(r)}: permissão desconhecida ${a.permission}`)
      }
      for (const a of argsOf(r, 'entitled'))
        if (!features.has(a.feature))
          problems.push(`${key(r)}: funcionalidade desconhecida ${a.feature}`)
    }
    // Permissões verificadas dentro dos casos de uso contam como usadas.
    const modules = join(import.meta.dirname, '..', '..', 'app', 'modules')
    const source = sourceFiles(modules)
      .filter((f) => !f.endsWith('permissions.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    for (const code of codes)
      if (!usedByRoutes.has(code) && !source.includes(`'${code}'`))
        problems.push(`permissão sem uso: ${code}`)
    assert.deepEqual(problems, [])
  })
})

test.group('rotas | negar por omissão', (group) => {
  group.each.setup(() => cleanDatabase())

  test('um membro sem perfis recebe 403 em todas as rotas com can(); quem não é da plataforma também', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const adminSession = await signIn(client, admin.email, tenant.id)
    const member = await memberWithRoles(client, adminSession, [])
    const fakeId = '00000000-0000-4000-8000-000000000000'
    const url = (pattern: string) =>
      pattern
        .replace(':kind', 'legal-entities')
        .replace(':feature', 'organization')
        .replace(/:[a-zA-Z]+/g, fakeId)
    const call = (s: typeof adminSession, r: RouteInfo) => {
      const c = as(client, s)
      const target = url(r.pattern)
      switch (r.method) {
        case 'GET':
          return c.get(target)
        case 'POST':
          return c.post(target, {})
        case 'PUT':
          return c.put(target, {})
        case 'PATCH':
          return c.patch(target, {})
        default:
          return c.delete(target)
      }
    }
    const failures: string[] = []
    const guarded = routes().filter((r) => has(r, 'can'))
    for (const r of guarded) {
      const response = await call(member.session, r)
      if (response.status() !== 403) failures.push(`${key(r)} → ${response.status()}`)
    }
    const outsider = await createUser()
    const outsiderSession = await signIn(client, outsider.email, tenant.id)
    for (const r of routes().filter((x) => has(x, 'platformAdmin'))) {
      const response = await call(adminSession, r)
      const other = await call(outsiderSession, r)
      if (response.status() !== 403 || other.status() !== 403)
        failures.push(`${key(r)} → ${response.status()}/${other.status()}`)
    }
    assert.isAbove(guarded.length, 20)
    assert.deepEqual(failures, [])
  })
})
