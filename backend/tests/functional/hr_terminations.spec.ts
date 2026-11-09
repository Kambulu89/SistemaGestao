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
const T = `${H}/terminations`
const owner = () => db.connection('owner')
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)

/** Valores de TESTE (não são a tabela oficial). */
const RULES = {
  code: 'TESTE',
  name: 'Regras de teste',
  currency: 'AOA',
  validFrom: '2026-01-01',
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

/** Regras publicadas, componentes da liquidação, um colaborador com contrato e outubro processado e fechado. */
async function setup(client: any) {
  const L = await ledger(client)
  const api = L.api
  const rs = ok(await api.post(`${P}/rule-sets`, RULES))
  const c = ok(
    await api.post(`${P}/rule-sets/${rs.id}/confirm`, {
      note: 'Conferido',
      expectedVersion: rs.version,
    }),
    200
  )
  ok(await api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: c.version }), 200)
  const component = async (
    c2: string,
    kind: string,
    category: string,
    irt: boolean,
    inss: boolean
  ) => {
    const pc = ok(
      await api.post(`${H}/pay-components`, {
        code: c2,
        name: `Componente ${c2}`,
        kind,
        category,
        calculation: 'VARIABLE',
        recurring: false,
      })
    )
    ok(
      await api.post(`${H}/pay-components/${pc.id}/incidences`, {
        validFrom: '2026-01-01',
        irtSubject: irt,
        inssSubject: inss,
        legalReference: 'Incidência de teste',
      })
    )
    return pc
  }
  const vacation = await component('FERIAS', 'EARNING', 'OTHER', true, true)
  const indemnity = await component('INDEMN', 'EARNING', 'OTHER', false, false)
  const deduction = await component('DESCAV', 'DEDUCTION', 'DEDUCTION', false, false)
  const dept = async (c2: string) =>
    ok(
      await api.post('/api/v1/organization/departments', {
        code: c2,
        name: `Dep ${c2}`,
        legalEntityId: L.le.id,
      })
    )
  const d1 = await dept('D1')
  const d2 = await dept('D2')
  const employee = async (
    c2: string,
    departmentId: string,
    extra: Record<string, unknown> = {}
  ) => {
    const e = ok(
      await api.post(`${H}/employees`, {
        code: c2,
        fullName: `Colaborador ${c2}`,
        legalEntityId: L.le.id,
        departmentId,
        hireDate: '2026-01-05',
        ...extra,
      })
    )
    const ct = ok(
      await api.post(`${H}/employees/${e.id}/contracts`, {
        code: `CT-${c2}`,
        contractType: 'PERMANENT',
        startDate: '2026-01-05',
        weeklyHours: '40',
        currency: 'AOA',
        baseSalary: '200000',
      })
    )
    ok(await api.post(`${H}/contracts/${ct.id}/activate`, { expectedVersion: ct.version }), 200)
    return { ...e, contractId: ct.id as string }
  }
  const e1 = await employee('C1', d1.id)
  const payApprover = await roleMember(client, L.s, 'aprova_ps', [
    'hr.payroll.read',
    'hr.payroll.approve',
  ])
  const AP = as(client, payApprover.session)
  const act = (who: any, r: any, path: string, body: Record<string, unknown> = {}) =>
    who.post(`${P}/runs/${r.id}/${path}`, { ...body, expectedVersion: r.version })
  let run = ok(
    await api.post(`${P}/runs`, { legalEntityId: L.le.id, period: '2026-10', kind: 'REGULAR' })
  )
  run = ok(await act(api, run, 'calculate'), 200)
  run = ok(await act(api, run, 'submit'), 200)
  run = ok(await act(AP, run, 'decision', { decision: 'APPROVE' }), 200)
  run = ok(await act(api, run, 'close'), 200)
  const approver = await roleMember(client, L.s, 'aprova_ces', [
    'hr.terminations.read',
    'hr.terminations.approve',
  ])
  return {
    ...L,
    vacation,
    indemnity,
    deduction,
    d1,
    d2,
    employee,
    e1,
    AP,
    act,
    approver,
    TA: as(client, approver.session),
  }
}

const BASE = {
  reason: 'DISMISSAL_OBJECTIVE',
  details: 'Extinção do posto de trabalho por reorganização do departamento.',
  noticeGivenOn: '2026-10-01',
  lastWorkingDay: '2026-11-30',
  noticeRequiredDays: 60,
  noticeBasis: 'Cláusula 9.ª do contrato (dado de teste)',
  indemnityApplicable: true,
  indemnityBasis: 'Base legal e critério indicados pela empresa (dado de teste)',
}

test.group('RH | cessação (7.11)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('cessação completa: aviso, férias, indemnização com base legal, aprovação com efeitos, lote e conclusão', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const create = (body: Record<string, unknown>) =>
      o.api.post(`${H}/employees/${o.e1.id}/terminations`, body)
    assert.includeMembers(
      details(
        await create({
          ...BASE,
          reason: 'FUGA',
          noticeBasis: null,
          indemnityBasis: null,
          noticeGivenOn: '2026-12-15',
        })
      ),
      ['INVALID', 'REQUIRED', 'AFTER_LAST_DAY']
    )
    let t = ok(await create(BASE))
    assert.match(t.code, /^CES-\d{4}-0001$/)
    assert.equal(t.status, 'DRAFT')
    assert.equal(t.initiative, 'EMPLOYER')
    assert.deepEqual(t.facts.notice, { required: 60, given: 61, shortfall: 0 })
    assert.deepEqual(
      [t.facts.service.years, t.facts.service.months, t.facts.service.days],
      [0, 10, 26]
    )
    assert.equal(t.facts.contract.baseSalary, '200000.00')
    assert.sameMembers(
      t.tasks.map((k: any) => k.category),
      ['EQUIPMENT', 'DOCUMENTS']
    )
    assert.equal(code(await create(BASE)), 'TERMINATION_EXISTS')

    // Saldo de férias: a sugestão proporcional vem do direito do ano (aqui sem política: 0).
    ok(
      await o.api.post(`${H}/employees/${o.e1.id}/leave/adjustments`, {
        year: 2026,
        days: '10',
        reason: 'Saldo de teste',
      })
    )
    t = ok(await o.api.get(`${T}/${t.id}`), 200)
    assert.equal(t.facts.vacation.balance, '10.00')
    assert.equal(t.facts.vacation.daysInYear, 365)
    assert.equal(t.facts.pendingPay.regularRun, null)

    // Submeter sem a linha da indemnização marcada como aplicável.
    assert.include(
      details(await o.api.post(`${T}/${t.id}/submit`, { expectedVersion: t.version })),
      'INDEMNITY_MISSING'
    )
    const line = (body: Record<string, unknown>) =>
      o.api.post(`${T}/${t.id}/lines`, { ...body, expectedVersion: t.version })
    assert.include(
      details(
        await line({
          kind: 'INDEMNITY',
          componentId: o.deduction.id,
          description: 'Indemnização',
          amount: '400000',
          basis: 'Critério da empresa',
        })
      ),
      'KIND_MISMATCH'
    )
    assert.include(
      details(
        await line({
          kind: 'UNUSED_VACATION',
          componentId: o.vacation.id,
          description: 'Férias não gozadas',
          quantity: '10',
          rate: '6666.6667',
          amount: '66666.00',
          basis: 'Salário base / 30 (critério da empresa)',
        })
      ),
      'AMOUNT_MISMATCH'
    )
    t = ok(
      await line({
        kind: 'UNUSED_VACATION',
        componentId: o.vacation.id,
        description: 'Férias não gozadas',
        quantity: '10',
        rate: '6666.6667',
        amount: '66666.67',
        basis: 'Salário base / 30 (critério da empresa)',
      }),
      200
    )
    t = ok(
      await line({
        kind: 'INDEMNITY',
        componentId: o.indemnity.id,
        description: 'Indemnização',
        amount: '400000',
        basis: 'Critério indicado na base legal',
      }),
      200
    )
    assert.deepEqual(t.totals, { earnings: '466666.67', deductions: '0.00', net: '466666.67' })
    // Sem indemnização aplicável não se pode ter a linha.
    assert.include(
      details(
        await o.api.patch(`${T}/${t.id}`, {
          indemnityApplicable: false,
          expectedVersion: t.version,
        })
      ),
      'INDEMNITY_LINES'
    )

    t = ok(await o.api.post(`${T}/${t.id}/submit`, { expectedVersion: t.version }), 200)
    assert.equal(t.status, 'PENDING_APPROVAL')
    assert.equal(code(await line({ kind: 'OTHER_EARNING' })), 'INVALID_STATE')
    // Quem preparou não decide; quem aprova vê o processo.
    assert.equal(
      code(
        await o.api.post(`${T}/${t.id}/decision`, { approve: true, expectedVersion: t.version })
      ),
      'SEGREGATION'
    )
    const seen = ok(await o.TA.get(`${T}/${t.id}`), 200)
    assert.isTrue(seen.access.approve)
    assert.isFalse(seen.access.manage)
    // Devolver exige nota; volta a rascunho.
    assert.include(
      details(
        await o.TA.post(`${T}/${t.id}/decision`, { approve: false, expectedVersion: t.version })
      ),
      'REQUIRED'
    )
    t = ok(
      await o.TA.post(`${T}/${t.id}/decision`, {
        approve: false,
        note: 'Confirmar a base da indemnização',
        expectedVersion: t.version,
      }),
      200
    )
    assert.equal(t.status, 'DRAFT')
    assert.equal(t.decisionNote, 'Confirmar a base da indemnização')
    t = ok(await o.api.post(`${T}/${t.id}/submit`, { expectedVersion: t.version }), 200)
    t = ok(
      await o.TA.post(`${T}/${t.id}/decision`, {
        approve: true,
        note: 'Conferido',
        expectedVersion: t.version,
      }),
      200
    )
    assert.equal(t.status, 'APPROVED')
    assert.equal(t.employee.status, 'TERMINATED')

    // Efeitos: contrato terminado no último dia, colocação fechada, saldo de férias encerrado.
    const contract = ok(await o.api.get(`${H}/contracts/${o.e1.contractId}`), 200)
    assert.equal(contract.status, 'ENDED')
    assert.equal(contract.terminationDate, '2026-11-30')
    assert.equal(t.facts.vacation.balance, '0.00')
    const assignment = await owner().rawQuery(
      `select valid_to::text as v from employment_assignments where employee_id = ? order by valid_from desc limit 1`,
      [o.e1.id]
    )
    assert.equal(assignment.rows[0].v, '2026-11-30')
    // Aprovado não muda (nem na base de dados).
    assert.equal(
      code(
        await o.api.patch(`${T}/${t.id}`, { details: 'Outra coisa', expectedVersion: t.version })
      ),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update employee_terminations set reason = 'OTHER' where id = ?`, [t.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(
        `update termination_settlement_lines set amount = 1 where termination_id = ?`,
        [t.id]
      )
    )
    assert.equal(
      code(await o.api.post(`${H}/employees/${o.e1.id}/terminations`, BASE)),
      'INVALID_STATE'
    )

    // Concluir antes da liquidação e da checklist.
    assert.includeMembers(
      details(await o.api.post(`${T}/${t.id}/complete`, { expectedVersion: t.version })),
      ['TASKS_PENDING', 'SETTLEMENT_OPEN']
    )
    // Lote EXTRA da liquidação (no mês do último dia), com os valores do processo.
    t = ok(await o.api.post(`${T}/${t.id}/settlement`, { expectedVersion: t.version }), 200)
    assert.match(t.settlementRun.code, /^PS-202611-\d{3}$/)
    assert.equal(
      code(await o.api.post(`${T}/${t.id}/settlement`, { expectedVersion: t.version })),
      'INVALID_STATE'
    )
    let run = ok(await o.api.get(`${P}/runs/${t.settlementRun.id}`), 200)
    assert.equal(run.kind, 'EXTRA')
    assert.equal(
      code(
        await o.api.put(`${P}/runs/${run.id}/inputs`, {
          employeeId: o.e1.id,
          componentId: o.vacation.id,
          amount: '1',
          expectedVersion: run.version,
        })
      ),
      'SETTLEMENT_RUN'
    )
    run = ok(await o.act(o.api, run, 'calculate'), 200)
    const result = run.results.find((r: any) => r.employee.id === o.e1.id)
    assert.equal(result.gross, '466666.67')
    run = ok(await o.act(o.api, run, 'submit'), 200)
    run = ok(await o.act(o.AP, run, 'decision', { decision: 'APPROVE' }), 200)
    run = ok(await o.act(o.api, run, 'close'), 200)

    // Checklist: tarefa adicionada e todas tratadas.
    t = ok(
      await o.api.post(`${T}/${t.id}/tasks`, {
        category: 'ACCESS',
        title: 'Desactivar o cartão de acesso ao edifício',
        expectedVersion: (await o.api.get(`${T}/${t.id}`)).body().data.version,
      }),
      200
    )
    for (const k of t.tasks)
      t = ok(
        await o.api.patch(`${H}/termination-tasks/${k.id}`, {
          status: 'DONE',
          notes: 'Feito',
          expectedVersion: k.version,
        }),
        200
      )
    t = ok(await o.api.post(`${T}/${t.id}/complete`, { expectedVersion: t.version }), 200)
    assert.equal(t.status, 'SETTLED')
    assert.equal(
      code(
        await o.api.patch(`${H}/termination-tasks/${t.tasks[0].id}`, {
          status: 'PENDING',
          expectedVersion: t.tasks[0].version,
        })
      ),
      'INVALID_STATE'
    )

    // Auditoria sem montantes.
    const a = await owner().rawQuery(
      `select action, metadata::text as m from audit_events where entity_type = 'employee_termination'
         and entity_id = ? order by created_at`,
      [t.id]
    )
    const actions = a.rows.map((x: any) => x.action)
    assert.includeMembers(actions, [
      'hr.termination.created',
      'hr.termination.line_added',
      'hr.termination.submitted',
      'hr.termination.returned',
      'hr.termination.approved',
      'hr.termination.settlement_generated',
      'hr.termination.settled',
    ])
    assert.notInclude(a.rows.map((x: any) => x.m).join(' '), '400000')
  })

  test('âmbito, o próprio e acesso da conta na checklist', async ({ client, assert }) => {
    const o = await setup(client)
    const subject = await memberWithRoles(client, o.s, [])
    const e2 = await o.employee('C2', o.d2.id, { membershipId: subject.memberId })
    // Gestor do departamento D1 não vê nem cria no D2.
    const d1 = await roleMember(
      client,
      o.s,
      'ces_d1',
      ['hr.terminations.read', 'hr.terminations.manage'],
      'DEPARTMENT',
      o.d1.id
    )
    const D1 = as(client, d1.session)
    assert.equal((await D1.post(`${H}/employees/${e2.id}/terminations`, BASE)).status(), 404)
    // Ninguém trata a própria cessação.
    const self = await roleMember(client, o.s, 'ces_all', [
      'hr.terminations.read',
      'hr.terminations.manage',
    ])
    const selfEmp = await o.employee('C3', o.d1.id, { membershipId: self.memberId })
    assert.equal(
      code(await as(client, self.session).post(`${H}/employees/${selfEmp.id}/terminations`, BASE)),
      'SELF_TERMINATION'
    )
    // Sem permissões: lista vazia.
    const nobody = await memberWithRoles(client, o.s, [])
    assert.lengthOf(ok(await as(client, nobody.session).get(T), 200), 0)

    let t = ok(
      await o.api.post(`${H}/employees/${e2.id}/terminations`, {
        ...BASE,
        reason: 'RESIGNATION',
        indemnityApplicable: false,
        indemnityBasis: null,
      })
    )
    assert.equal(t.initiative, 'EMPLOYEE')
    const access = t.tasks.find((k: any) => k.kind === 'SYSTEM_ACCESS')
    assert.exists(access)
    assert.equal(
      code(
        await o.api.patch(`${H}/termination-tasks/${access.id}`, {
          status: 'DONE',
          expectedVersion: access.version,
        })
      ),
      'ACCESS_ACTIVE'
    )
    // Uma tarefa de sistema só "não se aplica" com justificação.
    assert.include(
      details(
        await o.api.patch(`${H}/termination-tasks/${access.id}`, {
          status: 'NOT_APPLICABLE',
          expectedVersion: access.version,
        })
      ),
      'REQUIRED'
    )
    const m = ok(await o.api.get(`/api/v1/members/${subject.memberId}`), 200)
    ok(
      await o.api.post(`/api/v1/members/${subject.memberId}/suspend`, {
        expectedVersion: m.version,
      }),
      200
    )
    t = ok(
      await o.api.patch(`${H}/termination-tasks/${access.id}`, {
        status: 'DONE',
        expectedVersion: access.version,
      }),
      200
    )
    assert.equal(t.tasks.find((k: any) => k.id === access.id).status, 'DONE')
  })

  test('bloqueios: processo disciplinar, mês posterior fechado; cancelar e recomeçar', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const create = (body: Record<string, unknown>) =>
      o.api.post(`${H}/employees/${o.e1.id}/terminations`, body)
    const plain = { ...BASE, indemnityApplicable: false, indemnityBasis: null }
    assert.include(
      details(await create({ ...plain, reason: 'DISMISSAL_DISCIPLINARY' })),
      'REQUIRED'
    )
    const dc = ok(
      await o.api.post(`${H}/employees/${o.e1.id}/discipline/cases`, {
        category: 'CONDUCT',
        occurredOn: '2026-09-01',
        summary: 'Conduta',
        description: 'Descrição suficiente dos factos para o teste.',
      })
    )
    let t = ok(
      await create({ ...plain, reason: 'DISMISSAL_DISCIPLINARY', disciplinaryCaseId: dc.id })
    )
    assert.equal(t.disciplinaryCase.code, dc.code)
    assert.include(
      t.blockers.map((b: any) => b.code),
      'CASE_NOT_DECIDED'
    )
    assert.include(
      details(await o.api.post(`${T}/${t.id}/submit`, { expectedVersion: t.version })),
      'CASE_NOT_DECIDED'
    )
    // Último dia antes de um mês já fechado com este colaborador.
    t = ok(
      await o.api.patch(`${T}/${t.id}`, {
        reason: 'MUTUAL_AGREEMENT',
        noticeGivenOn: null,
        lastWorkingDay: '2026-09-30',
        expectedVersion: t.version,
      }),
      200
    )
    assert.isNull(t.disciplinaryCase)
    assert.include(
      details(await o.api.post(`${T}/${t.id}/submit`, { expectedVersion: t.version })),
      'PROCESSED_AFTER'
    )
    // Cancelar exige motivo; depois pode abrir-se outro processo.
    assert.include(
      details(await o.api.post(`${T}/${t.id}/cancel`, { expectedVersion: t.version })),
      'REQUIRED'
    )
    ok(
      await o.api.post(`${T}/${t.id}/cancel`, {
        reason: 'Acordo desfeito',
        expectedVersion: t.version,
      }),
      200
    )
    await assert.rejects(() =>
      owner().rawQuery(`update employee_terminations set details = 'x' where id = ?`, [t.id])
    )
    const again = ok(await create(plain))
    assert.match(again.code, /-0002$/)
    const list = await o.api.get(`${T}?employeeId=${o.e1.id}`)
    assert.equal(list.body().meta.total, 2)
  })
})
