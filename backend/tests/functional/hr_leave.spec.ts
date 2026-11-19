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
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')

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
  if (permissions.length) {
    const role = await createRole(client, admin, roleCode, permissions)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: role.id,
        scopeType,
        ...(scopeId ? { scopeId } : {}),
      }),
      200
    )
  }
  return m
}

const policy = (calendarId: string, extra: Record<string, unknown> = {}) => ({
  code: 'FERIAS',
  name: 'Férias — regime geral',
  calendarId,
  annualDays: '22',
  firstYearRule: 'PROPORTIONAL_MONTHS',
  rounding: 'HALF_DAY_UP',
  carryoverMaxDays: '5',
  legalReference: 'Política interna; valores a confirmar na Lei Geral do Trabalho em vigor.',
  validFrom: '2025-01-01',
  ...extra,
})

/** Empresa com calendário (feriado 2026-03-03), política publicada, tipos, chefe e colaborador com conta. */
async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000601',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const d1 = ok(
    await api.post('/api/v1/organization/departments', {
      code: 'D1',
      name: 'Operações',
      legalEntityId: le.id,
    })
  )
  const cal = ok(
    await api.post('/api/v1/calendars', { code: 'LDA', name: 'Luanda', countryCode: 'AO' })
  )
  ok(
    await api.post(`/api/v1/calendars/${cal.id}/holidays`, {
      date: '2026-03-03',
      name: 'Feriado de teste',
      kind: 'COMPANY',
    })
  )
  const p = ok(await api.post(`${H}/leave/policies`, policy(cal.id)))
  ok(await api.post(`${H}/leave/policies/${p.id}/publish`, { expectedVersion: p.version }), 200)
  const vac = ok(
    await api.post(`${H}/leave/types`, {
      code: 'FER',
      name: 'Férias',
      category: 'VACATION',
      paid: true,
      deductsBalance: true,
      counting: 'WORKING_DAYS',
    })
  )
  const sick = ok(
    await api.post(`${H}/leave/types`, {
      code: 'DOE',
      name: 'Doença',
      category: 'SICK',
      paid: true,
      deductsBalance: false,
      counting: 'CALENDAR_DAYS',
      requiresDocument: true,
      confidential: true,
    })
  )
  const bossMember = await roleMember(client, s, 'chefe', [], 'TENANT')
  const workerMember = await roleMember(client, s, 'self_service', ['hr.leave.request'], 'OWN')
  const boss = ok(
    await api.post(`${H}/employees`, {
      code: 'C001',
      fullName: 'Bruno Chefe',
      legalEntityId: le.id,
      departmentId: d1.id,
      hireDate: '2020-01-01',
      membershipId: bossMember.memberId,
    })
  )
  const worker = ok(
    await api.post(`${H}/employees`, {
      code: 'C002',
      fullName: 'Wanda Colaboradora',
      legalEntityId: le.id,
      departmentId: d1.id,
      managerId: boss.id,
      hireDate: '2025-03-15',
      membershipId: workerMember.memberId,
    })
  )
  return {
    s,
    api,
    le,
    d1,
    cal,
    policy: p,
    vac,
    sick,
    boss,
    worker,
    B: as(client, bossMember.session),
    W: as(client, workerMember.session),
    workerMember,
    bossMember,
  }
}

const balance = async (api: any, employeeId: string, year: number) =>
  ok(await api.get(`${H}/employees/${employeeId}/leave?year=${year}`), 200).balance

test.group('RH | férias e ausências (7.4)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('política versionada com fonte legal; tipos de ausência', async ({ client, assert }) => {
    const o = await setup(client)
    assert.include(
      details(
        await o.api.post(
          `${H}/leave/policies`,
          policy(o.cal.id, { code: 'X', legalReference: null })
        )
      ),
      'REQUIRED'
    )
    assert.include(
      details(
        await o.api.post(
          `${H}/leave/policies`,
          policy(o.cal.id, { code: 'Y', firstYearRule: 'DAYS_PER_MONTH' })
        )
      ),
      'REQUIRED'
    )
    const v1 = ok(await o.api.get(`${H}/leave/policies/${o.policy.id}`), 200)
    assert.equal(v1.status, 'ACTIVE')
    assert.equal(
      code(
        await o.api.patch(`${H}/leave/policies/${v1.id}`, {
          annualDays: '30',
          expectedVersion: v1.version,
        })
      ),
      'INVALID_STATE'
    )
    // Nova versão: não pode começar antes da actual; depois de publicada fecha a anterior na véspera.
    const v2 = ok(
      await o.api.post(`${H}/leave/policies`, { fromId: v1.id, validFrom: '2025-01-01' })
    )
    assert.equal(v2.policyVersion, 2)
    assert.equal(v2.status, 'DRAFT')
    assert.include(
      details(
        await o.api.post(`${H}/leave/policies/${v2.id}/publish`, { expectedVersion: v2.version })
      ),
      'NOT_AFTER_PREVIOUS'
    )
    const v2b = ok(
      await o.api.patch(`${H}/leave/policies/${v2.id}`, {
        validFrom: '2026-01-01',
        annualDays: '24',
        expectedVersion: v2.version,
      }),
      200
    )
    ok(
      await o.api.post(`${H}/leave/policies/${v2.id}/publish`, { expectedVersion: v2b.version }),
      200
    )
    const list = ok(await o.api.get(`${H}/leave/policies`), 200)
    assert.deepEqual(
      list.map((x: any) => [x.policyVersion, x.status, x.validFrom, x.validTo]),
      [
        [2, 'ACTIVE', '2026-01-01', null],
        [1, 'RETIRED', '2025-01-01', '2025-12-31'],
      ]
    )
    // Outra política para o mesmo âmbito: conflito.
    const other = ok(
      await o.api.post(
        `${H}/leave/policies`,
        policy(o.cal.id, { code: 'OUTRA', validFrom: '2026-06-01' })
      )
    )
    assert.equal(
      code(
        await o.api.post(`${H}/leave/policies/${other.id}/publish`, {
          expectedVersion: other.version,
        })
      ),
      'POLICY_CONFLICT'
    )
    assert.equal(
      code(
        await o.api.post(`${H}/leave/types`, {
          code: 'FER',
          name: 'Outra',
          category: 'VACATION',
          paid: true,
          deductsBalance: true,
          counting: 'WORKING_DAYS',
        })
      ),
      'CODE_TAKEN'
    )
    // Sem hr.leave.settings não se configura (o colaborador só lê os tipos).
    assert.equal((await o.W.post(`${H}/leave/types`, { code: 'Z' })).status(), 403)
    assert.lengthOf(ok(await o.W.get(`${H}/leave/types`), 200), 2)
  })

  test('direitos (proporcionais, idempotentes, transporte), pedidos, aprovação da chefia e saldo', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Nova versão 2026 com 24 dias.
    const v2 = ok(
      await o.api.post(`${H}/leave/policies`, {
        fromId: o.policy.id,
        validFrom: '2026-01-01',
        annualDays: '24',
      })
    )
    ok(
      await o.api.post(`${H}/leave/policies/${v2.id}/publish`, { expectedVersion: v2.version }),
      200
    )

    // 2025: admitida a 15/03 → 9 meses completos → 22 × 9/12 = 16,5.
    let run = ok(await o.api.post(`${H}/leave/accruals`, { year: 2025 }), 200)
    assert.equal(run.created, 2)
    assert.equal((await balance(o.api, o.worker.id, 2025)).accrued, '16.50')
    assert.equal((await balance(o.api, o.boss.id, 2025)).accrued, '22.00')
    run = ok(await o.api.post(`${H}/leave/accruals`, { year: 2025 }), 200)
    assert.deepEqual([run.created, run.adjusted, run.unchanged], [0, 0, 2])
    assert.equal(code(await o.B.post(`${H}/leave/accruals`, { year: 2025 })), 'OUT_OF_SCOPE')

    // A colaboradora pede 10 dias úteis em 2025; a chefia aprova.
    const r1 = ok(
      await o.W.post(`${H}/leave/requests`, {
        employeeId: o.worker.id,
        leaveTypeId: o.vac.id,
        startDate: '2025-06-02',
        endDate: '2025-06-13',
      })
    )
    assert.equal(r1.days, '10.00')
    assert.equal(r1.status, 'PENDING')
    assert.equal((await balance(o.api, o.worker.id, 2025)).available, '6.50')
    assert.equal(
      (
        await o.W.post(`${H}/leave/requests/${r1.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: r1.version,
        })
      ).status(),
      403
    )
    ok(
      await o.B.post(`${H}/leave/requests/${r1.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: r1.version,
      }),
      200
    )
    let b25 = await balance(o.api, o.worker.id, 2025)
    assert.deepEqual([b25.taken, b25.pending, b25.balance], ['10.00', '0.00', '6.50'])

    // 2026: 24 dias e transporte de 5 (máximo); 1,5 expira em 2025.
    ok(await o.api.post(`${H}/leave/accruals`, { year: 2026, employeeIds: [o.worker.id] }), 200)
    b25 = await balance(o.api, o.worker.id, 2025)
    assert.deepEqual([b25.expired, b25.balance], ['1.50', '5.00'])
    let b26 = await balance(o.api, o.worker.id, 2026)
    assert.deepEqual([b26.accrued, b26.carriedOver, b26.balance], ['24.00', '5.00', '29.00'])

    // Contagem com o calendário: segunda a sexta com feriado na terça → 4 dias.
    const pv = ok(
      await o.W.post(`${H}/leave/requests/preview`, {
        employeeId: o.worker.id,
        leaveTypeId: o.vac.id,
        startDate: '2026-03-02',
        endDate: '2026-03-06',
      }),
      200
    )
    assert.equal(pv.days, '4.00')
    const req = (startDate: string, endDate: string, extra: Record<string, unknown> = {}) =>
      o.W.post(`${H}/leave/requests`, {
        employeeId: o.worker.id,
        leaveTypeId: o.vac.id,
        startDate,
        endDate,
        ...extra,
      })
    const r2 = ok(await req('2026-03-02', '2026-03-06'))
    assert.equal(r2.days, '4.00')
    assert.equal(code(await req('2026-03-05', '2026-03-10')), 'OVERLAP')
    assert.include(details(await req('2026-12-28', '2027-01-05')), 'CROSS_YEAR')
    assert.include(details(await req('2026-03-07', '2026-03-08')), 'ZERO_DAYS')
    assert.include(details(await req('2026-05-04', '2026-07-31')), 'INSUFFICIENT_BALANCE')
    // Outra pessoa não regista por conta da colaboradora sem hr.leave.manage.
    assert.equal(
      code(
        await o.B.post(`${H}/leave/requests`, {
          employeeId: o.worker.id,
          leaveTypeId: o.vac.id,
          startDate: '2026-04-06',
          endDate: '2026-04-07',
        })
      ),
      'OUT_OF_SCOPE'
    )
    // Recusar exige motivo.
    assert.include(
      details(
        await o.B.post(`${H}/leave/requests/${r2.id}/decision`, {
          decision: 'REJECT',
          expectedVersion: r2.version,
        })
      ),
      'REQUIRED'
    )
    // Pedido registado pelo RH (admin): o admin não o decide; a chefia sim.
    const r3 = ok(
      await o.api.post(`${H}/leave/requests`, {
        employeeId: o.worker.id,
        leaveTypeId: o.vac.id,
        startDate: '2026-04-06',
        endDate: '2026-04-10',
      })
    )
    assert.equal(
      code(
        await o.api.post(`${H}/leave/requests/${r3.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: r3.version,
        })
      ),
      'SEGREGATION'
    )
    const a3 = ok(
      await o.B.post(`${H}/leave/requests/${r3.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: r3.version,
      }),
      200
    )
    b26 = await balance(o.api, o.worker.id, 2026)
    assert.deepEqual([b26.taken, b26.pending, b26.available], ['5.00', '4.00', '20.00'])
    // Aprovado: só quem gere cancela, com motivo, e os dias voltam.
    assert.equal(
      code(await o.W.post(`${H}/leave/requests/${r3.id}/cancel`, { expectedVersion: a3.version })),
      'OUT_OF_SCOPE'
    )
    assert.include(
      details(
        await o.api.post(`${H}/leave/requests/${r3.id}/cancel`, { expectedVersion: a3.version })
      ),
      'REQUIRED'
    )
    ok(
      await o.api.post(`${H}/leave/requests/${r3.id}/cancel`, {
        reason: 'Serviço urgente',
        expectedVersion: a3.version,
      }),
      200
    )
    // Pendente: a própria cancela.
    ok(await o.W.post(`${H}/leave/requests/${r2.id}/cancel`, { expectedVersion: r2.version }), 200)
    b26 = await balance(o.api, o.worker.id, 2026)
    assert.deepEqual([b26.taken, b26.pending, b26.available], ['0.00', '0.00', '29.00'])
    // Ajuste manual com motivo.
    assert.include(
      details(
        await o.api.post(`${H}/employees/${o.worker.id}/leave/adjustments`, {
          year: 2026,
          days: '1',
        })
      ),
      'REQUIRED'
    )
    ok(
      await o.api.post(`${H}/employees/${o.worker.id}/leave/adjustments`, {
        year: 2026,
        days: '-1.5',
        reason: 'Acerto acordado',
      })
    )
    assert.equal((await balance(o.api, o.worker.id, 2026)).balance, '27.50')

    // Self-service: a própria encontra a sua ficha e o saldo; quem não tem ficha recebe 404.
    const me = ok(await o.W.get(`${H}/leave/me?year=2026`), 200)
    assert.equal(me.employee.id, o.worker.id)
    assert.equal(me.balance.balance, '27.50')
    assert.isTrue(me.access.request)
    assert.equal(code(await o.api.get(`${H}/leave/me`)), 'NOT_LINKED')
    // Listas: a chefia vê os pedidos da equipa para decidir; a colaboradora os seus.
    ok(await req('2026-06-01', '2026-06-02'))
    const toApprove = ok(await o.B.get(`${H}/leave/requests?toApprove=true`), 200)
    assert.lengthOf(toApprove, 1)
    assert.lengthOf(ok(await o.W.get(`${H}/leave/requests?mine=true`), 200), 4)
    assert.lengthOf(ok(await o.W.get(`${H}/leave/requests?toApprove=true`), 200), 0)
    // Conta-corrente só de acréscimo (gozo e reversão por pedido).
    const sum = ok(await o.api.get(`${H}/employees/${o.worker.id}/leave?year=2026`), 200)
    assert.deepEqual(
      sum.ledger.map((l: any) => [l.kind, l.days]),
      [
        ['ACCRUAL', '24.00'],
        ['CARRYOVER', '5.00'],
        ['TAKEN', '-5.00'],
        ['REVERSAL', '5.00'],
        ['ADJUSTMENT', '-1.50'],
      ]
    )
  })

  test('confidencialidade médica: a chefia decide sem ver o tipo nem o motivo; justificativo só para a própria', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const r = ok(
      await o.W.post(`${H}/leave/requests`, {
        employeeId: o.worker.id,
        leaveTypeId: o.sick.id,
        startDate: '2026-04-04',
        endDate: '2026-04-06',
        reason: 'Gripe com febre',
      })
    )
    assert.equal(r.days, '3.00')
    assert.equal(r.leaveType.code, 'DOE')
    const seen = ok(await o.B.get(`${H}/leave/requests/${r.id}`), 200)
    assert.equal(seen.leaveType.name, 'Ausência justificada (confidencial)')
    assert.isNull(seen.leaveType.code)
    assert.isNull(seen.reason)
    assert.isFalse(seen.access.documents)
    assert.isTrue(seen.access.approve)
    ok(
      await o.B.post(`${H}/leave/requests/${r.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: r.version,
      }),
      200
    )
    // Não desconta férias.
    assert.equal((await balance(o.api, o.worker.id, 2026)).taken, '0.00')
    // Quem tem hr.sensitive (admin) vê.
    assert.equal(ok(await o.api.get(`${H}/leave/requests/${r.id}`), 200).reason, 'Gripe com febre')
    // Justificativo: a própria carrega; a chefia não vê nem carrega.
    const upload = (sess: Session) =>
      client
        .post('/api/v1/attachments')
        .header('cookie', sess.cookie)
        .header('x-xsrf-token', sess.xsrf)
        .header('x-tenant-id', sess.tenantId)
        .field('subjectType', 'leave_request')
        .field('subjectId', r.id)
        .file('file', PDF, { filename: 'atestado.pdf', contentType: 'application/pdf' })
    assert.equal((await upload(o.workerMember.session)).status(), 201)
    assert.equal((await upload(o.bossMember.session)).status(), 404)
    // A auditoria não regista o tipo confidencial nem o motivo.
    const ev = await db
      .connection('owner')
      .rawQuery(`select metadata::text as m from audit_events where action = 'hr.leave.requested'`)
    assert.include(ev.rows[0].m, '[RESERVADO]')
    assert.notInclude(ev.rows[0].m, 'DOE')
    assert.notInclude(ev.rows[0].m, 'Gripe')
    // Um leitor de outro departamento não vê.
    const d2 = ok(
      await o.api.post('/api/v1/organization/departments', {
        code: 'D2',
        name: 'Outro',
        legalEntityId: o.le.id,
      })
    )
    const reader = await roleMember(
      client,
      o.s,
      'leitor_d2',
      ['hr.leave.read'],
      'DEPARTMENT',
      d2.id
    )
    assert.equal(
      (await as(client, reader.session).get(`${H}/leave/requests/${r.id}`)).status(),
      404
    )
    assert.lengthOf(ok(await as(client, reader.session).get(`${H}/leave/requests`), 200), 0)
  })
})
