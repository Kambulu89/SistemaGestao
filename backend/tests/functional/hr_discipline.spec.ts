import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const H = '/api/v1/hr'
const D = `${H}/discipline/cases`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)

async function roleMember(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scopeType: string,
  scopeId?: string
) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType,
      ...(scopeId ? { scopeId } : {}),
    }),
    200
  )
  return m
}

const FACTS = 'Faltou ao turno de 3 de Novembro sem aviso nem justificação apresentada.'

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000998',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const dept = async (c: string) =>
    ok(
      await api.post('/api/v1/organization/departments', {
        code: c,
        name: `Dep ${c}`,
        legalEntityId: le.id,
      })
    )
  const d1 = await dept('D1')
  const d2 = await dept('D2')
  const e1 = ok(
    await api.post(`${H}/employees`, {
      code: 'C1',
      fullName: 'Carlos Caso',
      legalEntityId: le.id,
      departmentId: d1.id,
      hireDate: '2026-01-05',
    })
  )
  return { tenant, admin, s, api, le, d1, d2, e1 }
}

test.group('RH | processos disciplinares (7.10)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('abrir, instruir, defesa antes da sanção, encerrar; cronologia e processo encerrado imutáveis', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const open = (body: Record<string, unknown>) =>
      o.api.post(`${H}/employees/${o.e1.id}/discipline/cases`, body)
    assert.includeMembers(
      details(
        await open({
          category: 'FALTAS',
          occurredOn: '2999-01-01',
          summary: 'x',
          description: 'curto',
        })
      ),
      ['INVALID', 'FUTURE', 'LENGTH']
    )
    let c = ok(
      await open({
        category: 'ATTENDANCE',
        occurredOn: '2026-11-03',
        summary: 'Falta injustificada',
        description: FACTS,
      })
    )
    assert.match(c.code, /^DISC-\d{4}-0001$/)
    assert.equal(c.status, 'OPEN')
    c = ok(await o.api.get(`${D}/${c.id}`), 200)
    assert.lengthOf(c.events, 1)
    c = ok(await o.api.post(`${D}/${c.id}/review`, { expectedVersion: c.version }), 200)
    assert.equal(c.status, 'UNDER_REVIEW')
    c = ok(
      await o.api.post(`${D}/${c.id}/events`, {
        kind: 'NOTIFICATION',
        occurredOn: '2026-11-04',
        text: 'Nota de culpa entregue ao trabalhador.',
        expectedVersion: c.version,
      }),
      200
    )
    assert.include(
      details(
        await o.api.post(`${D}/${c.id}/events`, {
          kind: 'DECISION',
          occurredOn: '2026-11-01',
          text: 'Decisão por evento.',
          expectedVersion: c.version,
        })
      ),
      'INVALID'
    )
    const closeBody = {
      outcome: 'WRITTEN_WARNING',
      decidedOn: '2026-11-06',
      outcomeDetails: 'Repreensão registada, primeira ocorrência.',
      expectedVersion: c.version,
    }
    assert.include(details(await o.api.post(`${D}/${c.id}/close`, closeBody)), 'DEFENCE_REQUIRED')
    c = ok(
      await o.api.post(`${D}/${c.id}/events`, {
        kind: 'DEFENCE',
        occurredOn: '2026-11-05',
        text: 'O trabalhador apresentou defesa escrita.',
        expectedVersion: c.version,
      }),
      200
    )
    c = ok(
      await o.api.post(`${D}/${c.id}/close`, { ...closeBody, expectedVersion: c.version }),
      200
    )
    assert.equal(c.status, 'CLOSED')
    assert.equal(c.outcome, 'WRITTEN_WARNING')
    assert.isFalse(c.access.manage)
    assert.deepEqual(
      c.events.map((e: any) => e.kind),
      ['STATUS', 'STATUS', 'NOTIFICATION', 'DEFENCE', 'DECISION']
    )
    assert.equal(
      code(
        await o.api.post(`${D}/${c.id}/events`, {
          kind: 'NOTE',
          occurredOn: '2026-11-07',
          text: 'Depois do fecho.',
          expectedVersion: c.version,
        })
      ),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update disciplinary_cases set summary = 'x' where id = ?`, [c.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from disciplinary_events where case_id = ?`, [c.id])
    )
    // Auditoria: abertura, consultas e decisão, nunca o texto dos factos.
    const events = await owner().rawQuery(
      `select action, metadata::text as m from audit_events where entity_type = 'disciplinary_case' and entity_id = ?`,
      [c.id]
    )
    const actions = events.rows.map((x: any) => x.action)
    assert.includeMembers(actions, [
      'hr.discipline.opened',
      'hr.discipline.viewed',
      'hr.discipline.closed',
    ])
    for (const x of events.rows) assert.notInclude(x.m, 'turno de 3 de Novembro')
  })

  test('acesso restrito: RH geral não vê, âmbito por departamento, ninguém trata o próprio', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const c = ok(
      await o.api.post(`${H}/employees/${o.e1.id}/discipline/cases`, {
        category: 'CONDUCT',
        occurredOn: '2026-11-01',
        summary: 'Conduta',
        description: FACTS,
      })
    )
    const hr = await roleMember(
      client,
      o.s,
      'rh_geral',
      ['hr.read', 'hr.sensitive', 'hr.manage'],
      'TENANT'
    )
    const HR = as(client, hr.session)
    assert.lengthOf(ok(await HR.get(D), 200), 0)
    assert.equal((await HR.get(`${D}/${c.id}`)).status(), 404)
    const other = await roleMember(
      client,
      o.s,
      'disc_d2',
      ['hr.discipline.read'],
      'DEPARTMENT',
      o.d2.id
    )
    assert.equal((await as(client, other.session).get(`${D}/${c.id}`)).status(), 404)
    const reader = await roleMember(
      client,
      o.s,
      'disc_d1',
      ['hr.discipline.read'],
      'DEPARTMENT',
      o.d1.id
    )
    const R = as(client, reader.session)
    const seen = ok(await R.get(`${D}/${c.id}`), 200)
    assert.isFalse(seen.access.manage)
    assert.equal(seen.description, FACTS)
    assert.equal(
      code(await R.post(`${D}/${c.id}/review`, { expectedVersion: seen.version })),
      'OUT_OF_SCOPE'
    )
    // O próprio colaborador, mesmo com permissões, não vê nem abre processos sobre si.
    const subject = await roleMember(
      client,
      o.s,
      'disc_all',
      ['hr.discipline.read', 'hr.discipline.manage'],
      'TENANT'
    )
    ok(
      await o.api.patch(`${H}/employees/${o.e1.id}`, {
        membershipId: subject.memberId,
        expectedVersion: o.e1.version,
      }),
      200
    )
    const S = as(client, subject.session)
    assert.lengthOf(ok(await S.get(D), 200), 0)
    assert.equal((await S.get(`${D}/${c.id}`)).status(), 404)
    assert.equal(
      code(
        await S.post(`${H}/employees/${o.e1.id}/discipline/cases`, {
          category: 'OTHER',
          occurredOn: '2026-11-01',
          summary: 'Sobre mim',
          description: FACTS,
        })
      ),
      'SELF_CASE'
    )
    const views = await owner().rawQuery(
      `select count(*)::int as n from audit_events where action = 'hr.discipline.viewed' and entity_id = ?`,
      [c.id]
    )
    assert.equal(views.rows[0].n, 1)
  })
})
