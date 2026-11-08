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

const H = '/api/v1/hr/employees'
const IBAN = 'AO36004000006729503010102'
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')

const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}

/** Duas entidades legais; em A uma filial, um departamento com subdepartamento, cargo e centro de custo. */
async function structure(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = (code: string, taxId: string) =>
    api.post('/api/v1/organization/legal-entities', {
      code,
      legalName: `Entidade ${code}, Lda.`,
      taxId,
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  const leA = ok(await le('LEA', '5000000301'))
  const leB = ok(await le('LEB', '5000000302'))
  const branch = ok(
    await api.post('/api/v1/organization/branches', {
      code: 'BR1',
      name: 'Filial 1',
      legalEntityId: leA.id,
    })
  )
  const d1 = ok(
    await api.post('/api/v1/organization/departments', {
      code: 'D1',
      name: 'Finanças',
      legalEntityId: leA.id,
    })
  )
  const d2 = ok(
    await api.post('/api/v1/organization/departments', {
      code: 'D2',
      name: 'Tesouraria',
      legalEntityId: leA.id,
      parentId: d1.id,
    })
  )
  const d3 = ok(
    await api.post('/api/v1/organization/departments', {
      code: 'D3',
      name: 'Vendas B',
      legalEntityId: leB.id,
    })
  )
  const position = ok(
    await api.post('/api/v1/organization/positions', {
      code: 'P1',
      name: 'Contabilista',
      departmentId: d1.id,
    })
  )
  const cc = ok(
    await api.post('/api/v1/organization/cost-centers', {
      code: 'CC1',
      name: 'Centro 1',
      legalEntityId: leA.id,
    })
  )
  return { s, api, tenantId: tenant.id, leA, leB, branch, d1, d2, d3, position, cc }
}

async function scopedMember(
  client: any,
  admin: Session,
  code: string,
  permissions: string[],
  scopeType: string,
  scopeId?: string
) {
  const role = await createRole(client, admin, code, permissions)
  const m = await memberWithRoles(client, admin, [])
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

test.group('RH | colaboradores (7.1)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('ficha: criação, coerência com a estrutura, unicidade, versão, superior sem ciclos e estado', async ({
    client,
    assert,
  }) => {
    const o = await structure(client)
    const e1 = ok(
      await o.api.post(H, {
        code: 'C001',
        fullName: 'Ana Silva',
        legalEntityId: o.leA.id,
        branchId: o.branch.id,
        departmentId: o.d1.id,
        positionId: o.position.id,
        costCenterId: o.cc.id,
        hireDate: '2026-02-01',
        birthDate: '1990-05-10',
        nationality: 'ao',
        taxId: '004567890LA041',
        socialSecurityNumber: '123456789',
        bankIban: 'ao36 0040 0000 6729 5030 1010 2',
        workEmail: 'ana@empresa.ao',
      })
    )
    assert.deepInclude(e1, {
      status: 'ACTIVE',
      nationality: 'AO',
      bankIban: IBAN,
      sensitiveVisible: true,
      departmentName: 'Finanças',
      positionName: 'Contabilista',
    })
    assert.equal(e1.hireDate, '2026-02-01')

    const dup = await o.api.post(H, {
      code: 'C001',
      fullName: 'Outro',
      legalEntityId: o.leA.id,
      hireDate: '2026-02-01',
    })
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'CODE_TAKEN')
    const dupTax = await o.api.post(H, {
      code: 'C009',
      fullName: 'Outro',
      legalEntityId: o.leA.id,
      hireDate: '2026-02-01',
      taxId: '004567890LA041',
    })
    assert.equal(dupTax.body().error.code, 'TAX_ID_TAKEN')

    const wrong = await o.api.post(H, {
      code: 'C002',
      fullName: 'Errado',
      legalEntityId: o.leA.id,
      departmentId: o.d3.id,
      hireDate: '2026-02-01',
      bankIban: 'AO06123',
      birthDate: '2030-01-01',
    })
    wrong.assertStatus(422)
    const codes = wrong.body().error.details.map((d: any) => `${d.path}:${d.code}`)
    assert.includeMembers(codes, ['bankIban:INVALID_IBAN', 'birthDate:FUTURE_DATE'])
    const other = await o.api.post(H, {
      code: 'C002',
      fullName: 'Errado',
      legalEntityId: o.leA.id,
      departmentId: o.d3.id,
      hireDate: '2026-02-01',
    })
    assert.include(
      other.body().error.details.map((d: any) => d.code),
      'OTHER_LEGAL_ENTITY'
    )

    const e2 = ok(
      await o.api.post(H, {
        code: 'C002',
        fullName: 'Bruno Costa',
        legalEntityId: o.leA.id,
        departmentId: o.d2.id,
        managerId: e1.id,
        hireDate: '2026-03-01',
      })
    )
    assert.deepEqual(e2.manager, { code: 'C001', fullName: 'Ana Silva' })
    const cycle = await o.api.patch(`${H}/${e1.id}`, { expectedVersion: 1, managerId: e2.id })
    assert.include(
      cycle.body().error.details.map((d: any) => d.code),
      'CYCLE'
    )

    const stale = await o.api.patch(`${H}/${e1.id}`, { expectedVersion: 7, fullName: 'X' })
    stale.assertStatus(409)
    const updated = ok(
      await o.api.patch(`${H}/${e1.id}`, {
        expectedVersion: 1,
        fullName: 'Ana M. Silva',
        taxId: '009999999LA041',
      }),
      200
    )
    assert.equal(updated.version, 2)
    const detail = ok(await o.api.get(`${H}/${e1.id}`), 200)
    assert.equal(detail.directReports, 1)
    assert.deepEqual(detail.access, { manage: true, sensitive: true })

    // Auditoria: o nome muda com valores, o NIF só como "reservado".
    const ev = await db
      .connection('owner')
      .rawQuery(
        `select changes from audit_events where action = 'hr.employee.updated' and entity_id = ?`,
        [e1.id]
      )
    assert.deepEqual(ev.rows[0].changes.fullName, { from: 'Ana Silva', to: 'Ana M. Silva' })
    assert.deepEqual(ev.rows[0].changes.taxId, { from: '[RESERVADO]', to: '[RESERVADO]' })
    assert.notInclude(JSON.stringify(ev.rows), '009999999LA041')

    const suspended = ok(
      await o.api.post(`${H}/${e2.id}/status`, {
        expectedVersion: 1,
        status: 'SUSPENDED',
        reason: 'Baixa',
      }),
      200
    )
    assert.equal(suspended.status, 'SUSPENDED')
    ;(
      await o.api.post(`${H}/${e2.id}/status`, { expectedVersion: 2, status: 'TERMINATED' })
    ).assertStatus(422)
    const sameStatus = await o.api.post(`${H}/${e2.id}/status`, {
      expectedVersion: 2,
      status: 'SUSPENDED',
    })
    assert.equal(sameStatus.body().error.details[0].code, 'INVALID_TRANSITION')
    const list = ok(await o.api.get(`${H}?status=SUSPENDED`), 200)
    assert.deepEqual(
      list.map((e: any) => e.code),
      ['C002']
    )
  })

  test('âmbitos: chefia por departamento (com subdepartamentos), RH por entidade, próprio e dados pessoais', async ({
    client,
    assert,
  }) => {
    const o = await structure(client)
    const mk = (code: string, extra: object) =>
      o.api.post(H, { code, fullName: `Pessoa ${code}`, hireDate: '2026-01-10', ...extra })
    const e1 = ok(
      await mk('E1', { legalEntityId: o.leA.id, departmentId: o.d1.id, taxId: '111111111LA011' })
    )
    const e2 = ok(await mk('E2', { legalEntityId: o.leA.id, departmentId: o.d2.id }))
    const e3 = ok(await mk('E3', { legalEntityId: o.leB.id, departmentId: o.d3.id }))

    // Chefia do departamento D1 (inclui D2): só lê, sem dados pessoais.
    const boss = await scopedMember(client, o.s, 'chefia', ['hr.read'], 'DEPARTMENT', o.d1.id)
    const B = as(client, boss.session)
    const seen = ok(await B.get(H), 200)
    assert.sameMembers(
      seen.map((e: any) => e.code),
      ['E1', 'E2']
    )
    ;(await B.get(`${H}/${e3.id}`)).assertStatus(404)
    const card = ok(await B.get(`${H}/${e1.id}`), 200)
    assert.isFalse(card.sensitiveVisible)
    assert.isNull(card.taxId)
    assert.deepEqual(card.access, { manage: false, sensitive: false })
    const create = await B.post(H, {
      code: 'X1',
      fullName: 'Xavier',
      legalEntityId: o.leA.id,
      hireDate: '2026-01-10',
    })
    assert.equal(create.body().error.code, 'OUT_OF_SCOPE')
    // Listas nunca levam dados pessoais, nem para o administrador.
    const adminList = ok(await o.api.get(H), 200)
    assert.isTrue(adminList.every((e: any) => e.taxId === null && e.sensitiveVisible === false))

    // RH da entidade A: gere em A, não em B, e sem hr.sensitive não toca em dados pessoais.
    const hrA = await scopedMember(
      client,
      o.s,
      'rh_a',
      ['hr.read', 'hr.manage'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    const R = as(client, hrA.session)
    ok(
      await R.post(H, {
        code: 'E4',
        fullName: 'Nova',
        legalEntityId: o.leA.id,
        hireDate: '2026-01-10',
      })
    )
    const inB = await R.post(H, {
      code: 'E5',
      fullName: 'Nova',
      legalEntityId: o.leB.id,
      hireDate: '2026-01-10',
    })
    assert.equal(inB.body().error.code, 'OUT_OF_SCOPE')
    const personal = await R.patch(`${H}/${e1.id}`, { expectedVersion: 1, taxId: '222222222LA022' })
    personal.assertStatus(403)
    assert.equal(personal.body().error.code, 'SENSITIVE_FORBIDDEN')
    const move = await R.patch(`${H}/${e1.id}`, {
      expectedVersion: 1,
      legalEntityId: o.leB.id,
      departmentId: null,
    })
    assert.equal(move.body().error.code, 'OUT_OF_SCOPE')

    // O próprio: ficha ligada à membership, com hr.read + hr.sensitive em âmbito OWN.
    const self = await scopedMember(client, o.s, 'proprio', ['hr.read', 'hr.sensitive'], 'OWN')
    ok(await o.api.patch(`${H}/${e2.id}`, { expectedVersion: 1, membershipId: self.memberId }), 200)
    const S = as(client, self.session)
    const mine = ok(await S.get(H), 200)
    assert.deepEqual(
      mine.map((e: any) => e.code),
      ['E2']
    )
    assert.isTrue(ok(await S.get(`${H}/${e2.id}`), 200).sensitiveVisible)
    ;(await S.get(`${H}/${e1.id}`)).assertStatus(404)
  })

  test('anexos do colaborador seguem hr.sensitive', async ({ client }) => {
    const o = await structure(client)
    const e1 = ok(
      await o.api.post(H, {
        code: 'A1',
        fullName: 'Anexo',
        legalEntityId: o.leA.id,
        hireDate: '2026-01-10',
      })
    )
    const upload = (s: Session) =>
      client
        .post('/api/v1/attachments')
        .header('cookie', s.cookie)
        .header('x-xsrf-token', s.xsrf)
        .header('x-tenant-id', s.tenantId)
        .field('subjectType', 'employee')
        .field('subjectId', e1.id)
        .file('file', PDF, { filename: 'bi.pdf' })
    ;(await upload(o.s)).assertStatus(201)
    const reader = await scopedMember(client, o.s, 'leitor_rh', ['hr.read'], 'TENANT')
    ;(await upload(reader.session)).assertStatus(404)
    ;(
      await as(client, reader.session).get(
        `/api/v1/attachments?subjectType=employee&subjectId=${e1.id}`
      )
    ).assertStatus(404)
  })
})
