import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  type Session,
} from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

const H = '/api/v1/hr'
const P = `${H}/payroll`
const R = `${H}/reports`
const owner = () => db.connection('owner')
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const day = (offset: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const YEAR = Number(day(0).slice(0, 4))

/** Valores de TESTE (não são a tabela oficial). */
const RULES = {
  code: 'TESTE',
  name: 'Regras de teste',
  currency: 'AOA',
  validFrom: '2020-01-01',
  inssEmployeeRate: '3',
  inssEmployerRate: '8',
  baseIrtSubject: true,
  baseInssSubject: true,
  irtBaseDeductsInss: true,
  dayBasis: 'FIXED_30',
  legalReference: 'Valores de teste do mecanismo — não são a tabela oficial',
  brackets: [
    { lower: '0', upper: '100000', fixedAmount: '0', rate: '0', excessOver: '0' },
    { lower: '100000.01', upper: null, fixedAmount: '0', rate: '10', excessOver: '100000' },
  ],
  testCases: [
    {
      description: 'Salário de 200 000',
      source: 'Exemplo de teste',
      baseSalary: '200000',
      expectedInssEmployee: '6000',
      expectedIrt: '9400',
    },
  ],
}

async function roleMember(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scopeType = 'TENANT',
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

/**
 * Chefe (com conta) → Ana (com conta, chefiada pelo chefe) → Bruno (chefiado pela Ana); Carla noutro departamento.
 * Tipo de ausência por dias de calendário; contrato a termo da Ana a acabar dentro de 60 dias.
 */
async function setup(client: any) {
  const L = await ledger(client)
  const api = L.api
  const dept = async (c: string) =>
    ok(
      await api.post('/api/v1/organization/departments', {
        code: c,
        name: `Dep ${c}`,
        legalEntityId: L.le.id,
      })
    )
  const d1 = await dept('D1')
  const d2 = await dept('D2')
  const sick = ok(
    await api.post(`${H}/leave/types`, {
      code: 'DOE',
      name: 'Doença',
      category: 'SICK',
      paid: true,
      deductsBalance: false,
      counting: 'CALENDAR_DAYS',
      confidential: true,
    })
  )
  const other = ok(
    await api.post(`${H}/leave/types`, {
      code: 'OUT',
      name: 'Formação externa',
      category: 'OTHER',
      paid: true,
      deductsBalance: false,
      counting: 'CALENDAR_DAYS',
    })
  )
  const bossM = await roleMember(client, L.s, 'chefe', [])
  const anaM = await roleMember(client, L.s, 'self', [])
  const employee = async (c: string, extra: Record<string, unknown>) =>
    ok(
      await api.post(`${H}/employees`, {
        code: c,
        fullName: `Pessoa ${c}`,
        legalEntityId: L.le.id,
        departmentId: d1.id,
        hireDate: `${YEAR - 1}-01-02`,
        ...extra,
      })
    )
  const boss = await employee('CH', { membershipId: bossM.memberId, fullName: 'Chefe Geral' })
  const ana = await employee('ANA', {
    membershipId: anaM.memberId,
    managerId: boss.id,
    fullName: 'Ana Equipa',
    taxId: '000111222LA333',
    bankIban: 'AO88004000003514200123456',
  })
  const bruno = await employee('BRU', { managerId: ana.id, fullName: 'Bruno Abaixo' })
  const carla = await employee('CAR', { departmentId: d2.id, fullName: 'Carla Fora' })
  const contract = async (e: any, extra: Record<string, unknown> = {}) => {
    const ct = ok(
      await api.post(`${H}/employees/${e.id}/contracts`, {
        code: `CT-${e.code}`,
        contractType: 'PERMANENT',
        startDate: e.hireDate,
        weeklyHours: '40',
        currency: 'AOA',
        baseSalary: '200000',
        ...extra,
      })
    )
    ok(await api.post(`${H}/contracts/${ct.id}/activate`, { expectedVersion: ct.version }), 200)
    return ct
  }
  await contract(boss)
  await contract(ana, { contractType: 'FIXED_TERM', endDate: day(45) })
  await contract(bruno)
  await contract(carla)
  return {
    ...L,
    d1,
    d2,
    sick,
    other,
    boss,
    ana,
    bruno,
    carla,
    BOSS: as(client, bossM.session),
    ANA: as(client, anaM.session),
  }
}

test.group('RH | portais e relatórios (7.12)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('o meu espaço: a própria ficha, contratos, IBAN mascarado e só contactos editáveis', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const me = ok(await o.ANA.get(`${H}/me`), 200)
    assert.equal(me.profile.fullName, 'Ana Equipa')
    assert.equal(me.profile.taxId, '000111222LA333') // os próprios dados pessoais
    assert.equal(me.profile.bankIban, '•••••••••••••••••••••3456')
    assert.lengthOf(me.contracts, 1)
    assert.equal(me.contracts[0].contractType, 'FIXED_TERM')
    assert.equal(me.currentTerms.baseSalary, '200000.00')
    assert.includeMembers(me.selfEditable, ['personalPhone', 'emergencyName'])

    assert.equal(
      code(await o.ANA.patch(`${H}/me`, { taxId: '999', expectedVersion: me.profile.version })),
      'NOT_SELF_EDITABLE'
    )
    assert.include(
      details(
        await o.ANA.patch(`${H}/me`, {
          personalEmail: 'não-é-email',
          expectedVersion: me.profile.version,
        })
      ),
      'INVALID_EMAIL'
    )
    const updated = ok(
      await o.ANA.patch(`${H}/me`, {
        personalPhone: '+244 923 000 000',
        emergencyName: 'Maria Contacto',
        expectedVersion: me.profile.version,
      }),
      200
    )
    assert.equal(updated.personalPhone, '+244 923 000 000')
    assert.equal(
      (
        await o.ANA.patch(`${H}/me`, { city: 'Luanda', expectedVersion: me.profile.version })
      ).status(),
      409
    )
    const a = await owner().rawQuery(
      `select changes::text as c from audit_events where action = 'hr.employee.self_updated' and entity_id = ?`,
      [o.ana.id]
    )
    assert.lengthOf(a.rows, 1)
    assert.notInclude(a.rows[0].c, '923')
    assert.include(a.rows[0].c, 'personalPhone')

    // Sem ficha ligada.
    const loose = await memberWithRoles(client, o.s, [])
    assert.equal(code(await as(client, loose.session).get(`${H}/me`)), 'NOT_LINKED')
    assert.equal(code(await as(client, loose.session).get(`${H}/team`)), 'NOT_LINKED')
  })

  test('a minha equipa: hierarquia, ausências mascaradas, quem pode decidir e alertas, sem salários', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const req = async (e: any, type: any, start: string, end: string) =>
      ok(
        await o.api.post(`${H}/leave/requests`, {
          employeeId: e.id,
          leaveTypeId: type.id,
          startDate: start,
          endDate: end,
        })
      )
    const sickAna = await req(o.ana, o.sick, day(0), day(2))
    ok(
      await o.BOSS.post(`${H}/leave/requests/${sickAna.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: sickAna.version,
      }),
      200
    )
    await req(o.ana, o.other, day(10), day(11)) // pendente da Ana (chefia directa: o chefe decide)
    await req(o.bruno, o.other, day(12), day(12)) // pendente do Bruno (chefia da Ana)

    const team = ok(await o.BOSS.get(`${H}/team`), 200)
    assert.deepEqual(
      team.members.map((m: any) => [m.fullName, m.depth]),
      [
        ['Ana Equipa', 1],
        ['Bruno Abaixo', 2],
      ]
    )
    assert.deepInclude(team.summary, { size: 2, direct: 1, absentToday: 1, toDecide: 1 })
    const ana = team.members[0]
    assert.equal(ana.absentToday.leaveType.name, 'Ausência justificada (confidencial)')
    assert.isNull(ana.absentToday.reason)
    assert.equal(ana.pendingRequests, 1)
    assert.deepEqual(
      ana.alerts.map((x: any) => x.kind),
      ['CONTRACT_END']
    )
    const decide = team.pending.map((p: any) => [p.employee.fullName, p.canDecide])
    assert.sameDeepMembers(decide, [
      ['Ana Equipa', true],
      ['Bruno Abaixo', false],
    ])
    const raw = JSON.stringify(team)
    for (const k of ['baseSalary', 'taxId', 'bankIban', '200000']) assert.notInclude(raw, k)

    // A Ana chefia o Bruno: vê-o e decide o pedido dele; a Carla não pertence a nenhuma equipa.
    const t2 = ok(await o.ANA.get(`${H}/team`), 200)
    assert.deepEqual(
      t2.members.map((m: any) => m.fullName),
      ['Bruno Abaixo']
    )
    assert.isTrue(t2.pending[0].canDecide)
    assert.notInclude(JSON.stringify(t2), 'Carla')
  })

  test('relatórios: efectivos, rotatividade, férias e folha; âmbito e permissões', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Sem permissão de relatórios.
    assert.equal((await o.ANA.get(`${R}/headcount`)).status(), 403)
    assert.equal((await o.ANA.get(`${R}/payroll?year=${YEAR}`)).status(), 403)

    let h = ok(await o.api.get(`${R}/headcount?date=${day(0)}`), 200)
    assert.equal(h.total, 4)
    assert.deepInclude(h.byDepartment, { key: o.d1.id, label: 'Dep D1', count: 3 })
    assert.deepInclude(h.byContractType, { key: 'FIXED_TERM', label: 'FIXED_TERM', count: 1 })
    assert.equal(ok(await o.api.get(`${R}/headcount?date=${YEAR - 2}-06-01`), 200).total, 0)
    assert.include(details(await o.api.get(`${R}/headcount?date=ontem`)), 'INVALID_DATE')

    // Uma saída aprovada (último dia no início do ano) conta na rotatividade.
    const lastDay = `${YEAR}-01-31`
    const t = ok(
      await o.api.post(`${H}/employees/${o.carla.id}/terminations`, {
        reason: 'RESIGNATION',
        details: 'Denúncia pelo trabalhador.',
        lastWorkingDay: lastDay,
        indemnityApplicable: false,
      })
    )
    const sub = ok(
      await o.api.post(`${H}/terminations/${t.id}/submit`, { expectedVersion: t.version }),
      200
    )
    const approver = await roleMember(client, o.s, 'aprova_ces', [
      'hr.terminations.read',
      'hr.terminations.approve',
    ])
    ok(
      await as(client, approver.session).post(`${H}/terminations/${t.id}/decision`, {
        approve: true,
        expectedVersion: sub.version,
      }),
      200
    )
    h = ok(await o.api.get(`${R}/headcount?date=${day(0)}`), 200)
    assert.equal(h.total, 3)
    assert.equal(h.exitsYearToDate, 1)
    const tv = ok(await o.api.get(`${R}/turnover?year=${YEAR}`), 200)
    assert.equal(tv.exits, 1)
    assert.deepInclude(tv.months[0], { start: 4, end: 4, exits: 1, rate: '25.00' })
    assert.deepInclude(tv.months[1], { start: 3, end: 3, exits: 0, rate: '0.00' })
    assert.deepEqual(tv.byInitiative, [{ key: 'EMPLOYEE', count: 1 }])
    assert.include(details(await o.api.get(`${R}/turnover?year=abc`)), 'INVALID')

    // Âmbito por departamento: só D1.
    const d1 = await roleMember(client, o.s, 'rel_d1', ['hr.reports.read'], 'DEPARTMENT', o.d1.id)
    const D1 = as(client, d1.session)
    assert.equal(ok(await D1.get(`${R}/headcount?date=${YEAR}-01-15`), 200).total, 3)
    const lv = ok(await D1.get(`${R}/leave?year=${YEAR}`), 200)
    assert.equal(lv.totals.employees, 3)
    assert.notInclude(JSON.stringify(lv), 'Carla')
    // Folha exige hr.payroll.read.
    assert.equal((await D1.get(`${R}/payroll?year=${YEAR}`)).status(), 403)

    // Folha: um lote regular fechado.
    const rs = ok(await o.api.post(`${P}/rule-sets`, RULES))
    const c = ok(
      await o.api.post(`${P}/rule-sets/${rs.id}/confirm`, {
        note: 'Conferido',
        expectedVersion: rs.version,
      }),
      200
    )
    ok(await o.api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: c.version }), 200)
    const payApprover = await roleMember(client, o.s, 'aprova_ps', [
      'hr.payroll.read',
      'hr.payroll.approve',
    ])
    const AP = as(client, payApprover.session)
    const act = (who: any, r: any, path: string, body: Record<string, unknown> = {}) =>
      who.post(`${P}/runs/${r.id}/${path}`, { ...body, expectedVersion: r.version })
    let run = ok(
      await o.api.post(`${P}/runs`, {
        legalEntityId: o.le.id,
        period: `${YEAR - 1}-12`,
        kind: 'REGULAR',
      })
    )
    run = ok(await act(o.api, run, 'calculate'), 200)
    run = ok(await act(o.api, run, 'submit'), 200)
    run = ok(await act(AP, run, 'decision', { decision: 'APPROVE' }), 200)
    run = ok(await act(o.api, run, 'close'), 200)
    const pr = ok(await o.api.get(`${R}/payroll?year=${YEAR - 1}`), 200)
    assert.lengthOf(pr.months, 1)
    assert.deepInclude(pr.totals[0], {
      currency: 'AOA',
      employees: 4,
      gross: '800000.00',
      inssEmployee: '24000.00',
      inssEmployer: '64000.00',
      irt: '37600.00',
    })
    assert.deepInclude(
      pr.byDepartment.map((x: any) => [x.departmentName, x.employees]),
      ['Dep D1', 3]
    )
    assert.lengthOf(ok(await o.api.get(`${R}/payroll?year=${YEAR}`), 200).months, 0)
    assert.equal(
      (
        await o.api.get(
          `${R}/payroll?year=${YEAR}&legalEntityId=00000000-0000-4000-8000-000000000000`
        )
      ).status(),
      404
    )
  })
})
