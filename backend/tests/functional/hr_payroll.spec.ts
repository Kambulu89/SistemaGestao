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
const P = `${H}/payroll`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`

/** Valores de TESTE (não são a tabela oficial): só verificam o mecanismo. */
const RULES = {
  code: 'TESTE-2026',
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
    { lower: '100000.01', upper: '200000', fixedAmount: '0', rate: '10', excessOver: '100000' },
    { lower: '200000.01', upper: null, fixedAmount: '10000', rate: '20', excessOver: '200000' },
  ],
  // Casos com a mesma tabela de teste (calculados à mão).
  testCases: [
    {
      description: 'Só salário base',
      source: 'Exemplo de teste do mecanismo',
      baseSalary: '200000',
      expectedInssEmployee: '6000',
      expectedIrt: '9400',
      expectedInssEmployer: '16000',
      expectedNet: '184600',
    },
    {
      description: 'Base com abonos de incidências diferentes',
      source: 'Exemplo de teste do mecanismo',
      baseSalary: '200000',
      allowancesSubject: '10000',
      allowancesIrtOnly: '30000',
      allowancesExempt: '5000',
      expectedInssEmployee: '6300',
      expectedIrt: '16740',
      expectedInssEmployer: '16800',
      expectedNet: '221960',
    },
  ],
}

/** Cria, confirma e publica uma versão das regras. */
async function publishRules(api: any, body: Record<string, unknown> = RULES) {
  const rs = ok(await api.post(`${P}/rule-sets`, body))
  const c = ok(
    await api.post(`${P}/rule-sets/${rs.id}/confirm`, {
      note: 'Valores conferidos com a fonte indicada',
      expectedVersion: rs.version,
    }),
    200
  )
  return ok(await api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: c.version }), 200)
}

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

async function employee(api: any, le: any, suffix: string, contract: any = {}, extra = {}) {
  const e = ok(
    await api.post(`${H}/employees`, {
      code: `C${suffix}`,
      fullName: `Colaborador ${suffix}`,
      legalEntityId: le.id,
      hireDate: '2026-01-05',
      ...extra,
    })
  )
  const c = ok(
    await api.post(`${H}/employees/${e.id}/contracts`, {
      code: `CT-${suffix}`,
      contractType: 'PERMANENT',
      startDate: '2026-01-05',
      weeklyHours: '40',
      currency: 'AOA',
      baseSalary: '200000',
      ...contract,
    })
  )
  const active = ok(
    await api.post(`${H}/contracts/${c.id}/activate`, { expectedVersion: c.version }),
    200
  )
  return { ...e, contract: active }
}

async function setup(client: any, withRules = true) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const entity = (codeSuffix: string, taxId: string) =>
    api.post('/api/v1/organization/legal-entities', {
      code: `LE${codeSuffix}`,
      legalName: `Entidade ${codeSuffix}, Lda.`,
      taxId,
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  const le = ok(await entity('A', '5000000777'))
  const le2 = ok(await entity('B', '5000000778'))
  if (withRules) {
    await publishRules(api)
  }
  const overtime = ok(
    await api.post(`${H}/pay-components`, {
      code: 'HEXTRA',
      name: 'Horas extra',
      kind: 'EARNING',
      category: 'OVERTIME',
      calculation: 'VARIABLE',
      recurring: false,
    })
  )
  ok(
    await api.post(`${H}/pay-components/${overtime.id}/incidences`, {
      validFrom: '2026-01-01',
      irtSubject: true,
      inssSubject: true,
      legalReference: 'Incidência de teste',
    })
  )
  const e1 = await employee(api, le, '001')
  const approver = await roleMember(
    client,
    s,
    'aprova_ps',
    ['hr.payroll.read', 'hr.payroll.approve'],
    'TENANT'
  )
  return { tenant, admin, s, api, le, le2, overtime, e1, approver, A: as(client, approver.session) }
}

const run = (api: any, body: Record<string, unknown>) => api.post(`${P}/runs`, body)
const act = (api: any, r: any, path: string, body: Record<string, unknown> = {}) =>
  api.post(`${P}/runs/${r.id}/${path}`, { ...body, expectedVersion: r.version })

test.group('RH | processamento salarial (7.7)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('regras versionadas com fonte: validação, publicação e imutabilidade', async ({
    client,
    assert,
  }) => {
    const o = await setup(client, false)
    const bad = await o.api.post(`${P}/rule-sets`, {
      ...RULES,
      legalReference: '',
      brackets: [{ lower: '10', upper: '5', fixedAmount: '0', rate: '150', excessOver: '0' }],
    })
    assert.equal(bad.status(), 422)
    assert.includeMembers(details(bad), ['REQUIRED', 'GAP', 'RANGE', 'INVALID_PERCENT'])
    const rs = ok(await o.api.post(`${P}/rule-sets`, RULES))
    assert.equal(rs.status, 'DRAFT')
    assert.lengthOf(rs.brackets, 3)
    const edited = ok(
      await o.api.patch(`${P}/rule-sets/${rs.id}`, {
        inssEmployerRate: '8.5',
        expectedVersion: rs.version,
      }),
      200
    )
    assert.equal(edited.inssEmployerRate, '8.5000')
    // Os casos de teste deixam de dar o esperado (INSS patronal): não se confirma nem publica.
    const failing = await o.api.post(`${P}/rule-sets/${rs.id}/publish`, {
      expectedVersion: edited.version,
    })
    assert.equal(code(failing), 'CASES_FAILING')
    assert.match(
      failing.body().error.details[0].message,
      /INSS da empresa esperado 16 000,00, calculado 17 000,00/
    )
    const back = ok(
      await o.api.patch(`${P}/rule-sets/${rs.id}`, {
        inssEmployerRate: '8',
        expectedVersion: edited.version,
      }),
      200
    )
    assert.equal(
      code(await o.api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: back.version })),
      'NOT_CONFIRMED'
    )
    const confirmed = ok(
      await o.api.post(`${P}/rule-sets/${rs.id}/confirm`, {
        note: 'Conferido com a fonte',
        expectedVersion: back.version,
      }),
      200
    )
    assert.isNotNull(confirmed.confirmedAt)
    const pub = ok(
      await o.api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: confirmed.version }),
      200
    )
    assert.equal(pub.status, 'PUBLISHED')
    assert.equal(
      code(
        await o.api.patch(`${P}/rule-sets/${rs.id}`, { name: 'x', expectedVersion: pub.version })
      ),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update payroll_irt_brackets set rate = 1 where rule_set_id = ?`, [rs.id])
    )
    // Outra versão na mesma data não se publica.
    const twin0 = ok(await o.api.post(`${P}/rule-sets`, { ...RULES, code: 'TESTE-B' }))
    const twin = ok(
      await o.api.post(`${P}/rule-sets/${twin0.id}/confirm`, {
        note: 'Conferido com a fonte',
        expectedVersion: twin0.version,
      }),
      200
    )
    assert.equal(
      code(
        await o.api.post(`${P}/rule-sets/${twin.id}/publish`, { expectedVersion: twin.version })
      ),
      'VERSION_EXISTS'
    )
    ok(await o.api.delete(`${P}/rule-sets/${twin.id}`), 200)
    // Sem a permissão de configuração não se vêem nem mudam regras.
    const reader = await roleMember(client, o.s, 'leitor_ps', ['hr.payroll.read'], 'TENANT')
    assert.equal((await as(client, reader.session).get(`${P}/rule-sets`)).status(), 403)
  })

  test('lote regular: cálculo exacto, erros por colaborador, simulação repetível, aprovação, fecho', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const usd = await employee(o.api, o.le, '002', { currency: 'USD', baseSalary: '3000' })
    // Empréstimo aprovado (prestações a partir deste mês).
    const loanRole = await roleMember(
      client,
      o.s,
      'aprova_emp',
      ['hr.loans.read', 'hr.loans.approve'],
      'TENANT'
    )
    const loan = ok(
      await o.api.post(`${H}/employees/${o.e1.id}/loans`, {
        kind: 'LOAN',
        principal: '20000',
        installmentsCount: 2,
        firstPeriod: thisMonth,
        reason: 'Empréstimo',
      })
    )
    const sl = ok(
      await o.api.post(`${H}/loans/${loan.id}/submit`, { expectedVersion: loan.version }),
      200
    )
    ok(
      await as(client, loanRole.session).post(`${H}/loans/${loan.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: sl.version,
      }),
      200
    )

    let r = ok(
      await run(o.api, { legalEntityId: o.le.id, period: thisMonth.slice(0, 7), kind: 'REGULAR' })
    )
    assert.match(r.code, /^PS-\d{6}-001$/)
    assert.equal(
      code(
        await run(o.api, { legalEntityId: o.le.id, period: thisMonth.slice(0, 7), kind: 'REGULAR' })
      ),
      'REGULAR_EXISTS'
    )
    // Só componentes variáveis entram no regular.
    r = ok(
      await o.api.put(`${P}/runs/${r.id}/inputs`, {
        employeeId: o.e1.id,
        componentId: o.overtime.id,
        amount: '10000',
        expectedVersion: r.version,
      }),
      200
    )
    r = ok(await act(o.api, r, 'calculate'), 200)
    assert.equal(r.status, 'CALCULATED')
    assert.equal(r.employeesCount, 2)
    assert.equal(r.errorsCount, 1)
    const err = r.results.find((x: any) => x.employee.id === usd.id)
    assert.equal(err.status, 'ERROR')
    assert.equal(err.errors[0].code, 'NO_RULE_SET')
    const mine = r.results.find((x: any) => x.employee.id === o.e1.id)
    // 200 000 + 10 000 horas extra = 210 000; INSS 3% = 6 300; base IRT 203 700 → 10 000 + 3 700 × 20% = 10 740
    assert.equal(mine.gross, '210000.00')
    assert.equal(mine.inssEmployee, '6300.00')
    assert.equal(mine.irt, '10740.00')
    assert.equal(mine.loans, '10000.00')
    assert.equal(mine.net, '182960.00')
    assert.equal(mine.inssEmployer, '16800.00')
    assert.equal(mine.employerCost, '226800.00')
    const detail = ok(await o.api.get(`${P}/runs/${r.id}/results/${mine.id}`), 200)
    assert.includeMembers(
      detail.lines.map((l: any) => l.source),
      ['BASE', 'COMPONENT', 'INSS', 'IRT', 'LOAN', 'INSS_EMPLOYER']
    )
    assert.equal(detail.snapshot.rules.code, 'TESTE-2026')
    assert.equal(detail.snapshot.contract.baseSalary, '200000.00')

    assert.equal(code(await act(o.api, r, 'submit')), 'RUN_HAS_ERRORS')
    r = ok(
      await o.api.post(`${P}/runs/${r.id}/exclusions`, {
        employeeId: usd.id,
        excluded: true,
        expectedVersion: r.version,
      }),
      200
    )
    assert.equal(r.status, 'DRAFT')
    r = ok(await act(o.api, r, 'calculate'), 200)
    const hash1 = (
      await owner().rawQuery(`select inputs_hash from payroll_runs where id = ?`, [r.id])
    ).rows[0].inputs_hash
    r = ok(await act(o.api, r, 'calculate'), 200)
    const hash2 = (
      await owner().rawQuery(`select inputs_hash from payroll_runs where id = ?`, [r.id])
    ).rows[0].inputs_hash
    assert.equal(hash1, hash2) // a simulação é repetível
    assert.equal(r.errorsCount, 0)
    assert.equal(r.totals.net, '182960.00')
    // Calcular não tem efeitos: a prestação continua por descontar.
    const inst = await owner().rawQuery(
      `select status from employee_loan_installments where loan_id = ? order by sequence`,
      [loan.id]
    )
    assert.deepEqual(
      inst.rows.map((x: any) => x.status),
      ['PENDING', 'PENDING']
    )

    r = ok(await act(o.api, r, 'submit'), 200)
    assert.equal(r.status, 'PENDING_APPROVAL')
    await assert.rejects(() =>
      owner().rawQuery(`update payroll_results set net = 0 where run_id = ?`, [r.id])
    )
    assert.equal(code(await act(o.api, r, 'decision', { decision: 'APPROVE' })), 'SEGREGATION')
    assert.include(details(await act(o.A, r, 'decision', { decision: 'REJECT' })), 'REQUIRED')
    r = ok(await act(o.A, r, 'decision', { decision: 'REJECT', comment: 'Rever horas extra' }), 200)
    assert.equal(r.status, 'CALCULATED')
    r = ok(await act(o.api, r, 'submit'), 200)
    r = ok(await act(o.A, r, 'decision', { decision: 'APPROVE' }), 200)
    assert.equal(r.status, 'APPROVED')
    assert.equal(code(await act(o.api, r, 'cancel')), 'INVALID_STATE')
    r = ok(await act(o.api, r, 'close'), 200)
    assert.equal(r.status, 'CLOSED')

    // O fecho descontou a prestação do mês, com a referência do lote, uma só vez.
    const after = await owner().rawQuery(
      `select status, settlement_reference from employee_loan_installments where loan_id = ? order by sequence`,
      [loan.id]
    )
    assert.deepEqual(after.rows[0], { status: 'DEDUCTED', settlement_reference: r.code })
    assert.equal(after.rows[1].status, 'PENDING')
    // O mês fechou: nada novo nele; o lote fechado não muda.
    assert.equal(
      code(
        await run(o.api, { legalEntityId: o.le.id, period: thisMonth.slice(0, 7), kind: 'EXTRA' })
      ),
      'PERIOD_CLOSED'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update payroll_runs set description = 'x' where id = ?`, [r.id])
    )
    const periods = ok(await o.api.get(`${P}/periods?legalEntityId=${o.le.id}`), 200)
    assert.equal(periods[0].status, 'CLOSED')
    // Auditoria sem montantes individuais.
    const events = await owner().rawQuery(
      `select action, metadata::text as m from audit_events where entity_type = 'payroll_run' and entity_id = ?`,
      [r.id]
    )
    assert.includeMembers(
      events.rows.map((x: any) => x.action),
      [
        'hr.payroll.run_created',
        'hr.payroll.run_calculated',
        'hr.payroll.run_pending_approval',
        'hr.payroll.run_approved',
        'hr.payroll.run_closed',
      ]
    )
    for (const x of events.rows) assert.notMatch(x.m, /182960|210000/)
  })

  test('dados que mudam depois do cálculo obrigam a recalcular (STALE_RUN)', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    let r = ok(await run(o.api, { legalEntityId: o.le.id, period: '2026-10', kind: 'REGULAR' }))
    r = ok(await act(o.api, r, 'calculate'), 200)
    // Uma adenda de remuneração com efeito no mês muda os dados.
    ok(
      await o.api.post(`${H}/contracts/${o.e1.contract.id}/amendments`, {
        kind: 'CHANGE',
        effectiveDate: '2026-10-01',
        baseSalary: '210000',
        reason: 'Revisão',
        expectedVersion: o.e1.contract.version,
      })
    )
    assert.equal(code(await act(o.api, r, 'submit')), 'STALE_RUN')
    r = ok(await act(o.api, r, 'calculate'), 200)
    assert.equal(r.results[0].gross, '210000.00')
    ok(await act(o.api, r, 'submit'), 200)
  })

  test('mês incompleto, retroactivo de um mês fechado e processamento extra', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Janeiro: contrato desde 05/01 → 27 de 31 dias.
    let jan = ok(await run(o.api, { legalEntityId: o.le.id, period: '2026-01', kind: 'REGULAR' }))
    jan = ok(await act(o.api, jan, 'calculate'), 200)
    assert.equal(jan.results[0].gross, '174193.55') // 200 000 × 27/31
    // Setembro fechado com 200 000.
    let sep = ok(await run(o.api, { legalEntityId: o.le.id, period: '2026-09', kind: 'REGULAR' }))
    sep = ok(await act(o.api, sep, 'calculate'), 200)
    sep = ok(await act(o.api, sep, 'submit'), 200)
    sep = ok(await act(o.A, sep, 'decision', { decision: 'APPROVE' }), 200)
    sep = ok(await act(o.api, sep, 'close'), 200)
    // Aumento com efeito em setembro, decidido depois do fecho: rectifica-se num retroactivo de outubro.
    ok(
      await o.api.post(`${H}/contracts/${o.e1.contract.id}/amendments`, {
        kind: 'CHANGE',
        effectiveDate: '2026-09-01',
        baseSalary: '220000',
        reason: 'Revisão com efeito a setembro',
        expectedVersion: o.e1.contract.version,
      })
    )
    assert.include(
      details(
        await run(o.api, {
          legalEntityId: o.le.id,
          period: '2026-10',
          kind: 'RETRO',
          targetPeriod: '2026-10',
        })
      ),
      'NOT_CLOSED'
    )
    let retro = ok(
      await run(o.api, {
        legalEntityId: o.le.id,
        period: '2026-10',
        kind: 'RETRO',
        targetPeriod: '2026-09',
      })
    )
    assert.equal(retro.targetPeriod, '2026-09-01')
    retro = ok(await act(o.api, retro, 'calculate'), 200)
    const d = retro.results[0]
    assert.equal(d.gross, '20000.00')
    assert.equal(d.inssEmployee, '600.00')
    // IRT: base 213 400 contra 194 000 → (10 000 + 13 400 × 20%) − (9 400) = 3 280
    assert.equal(d.irt, '3280.00')
    assert.equal(d.net, '16120.00')
    const lines = ok(await o.api.get(`${P}/runs/${retro.id}/results/${d.id}`), 200).lines
    assert.isTrue(lines.every((l: any) => l.name.startsWith('Diferença: ')))
    retro = ok(await act(o.api, retro, 'submit'), 200)
    retro = ok(await act(o.A, retro, 'decision', { decision: 'APPROVE' }), 200)
    retro = ok(await act(o.api, retro, 'close'), 200)
    // Um segundo retroactivo já não encontra diferenças.
    let again = ok(
      await run(o.api, {
        legalEntityId: o.le.id,
        period: '2026-10',
        kind: 'RETRO',
        targetPeriod: '2026-09',
      })
    )
    again = ok(await act(o.api, again, 'calculate'), 200)
    assert.equal(again.employeesCount, 0)

    // Extra: só o que se lança no lote (qualquer componente), com INSS e IRT sobre esse valor.
    const bonus = ok(
      await o.api.post(`${H}/pay-components`, {
        code: 'GRATIF',
        name: 'Gratificação',
        kind: 'EARNING',
        category: 'BONUS',
        calculation: 'FIXED',
      })
    )
    ok(
      await o.api.post(`${H}/pay-components/${bonus.id}/incidences`, {
        validFrom: '2026-01-01',
        irtSubject: true,
        inssSubject: false,
        legalReference: 'Incidência de teste',
      })
    )
    let extra = ok(
      await run(o.api, {
        legalEntityId: o.le.id,
        period: '2026-10',
        kind: 'EXTRA',
        description: 'Gratificação',
      })
    )
    extra = ok(
      await o.api.put(`${P}/runs/${extra.id}/inputs`, {
        employeeId: o.e1.id,
        componentId: bonus.id,
        amount: '150000',
        expectedVersion: extra.version,
      }),
      200
    )
    extra = ok(await act(o.api, extra, 'calculate'), 200)
    assert.equal(extra.employeesCount, 1)
    const x = extra.results[0]
    assert.equal(x.gross, '150000.00')
    assert.equal(x.inssEmployee, '0.00')
    assert.equal(x.irt, '5000.00') // (150 000 − 100 000) × 10%
    // O colaborador de outra entidade legal não entra neste lote.
    const other = await employee(o.api, o.le2, '009')
    assert.include(
      details(
        await o.api.put(`${P}/runs/${extra.id}/inputs`, {
          employeeId: other.id,
          componentId: bonus.id,
          amount: '1',
          expectedVersion: extra.version,
        })
      ),
      'OTHER_LEGAL_ENTITY'
    )
  })

  test('âmbito por entidade legal e segregação', async ({ client, assert }) => {
    const o = await setup(client)
    const r = ok(await run(o.api, { legalEntityId: o.le.id, period: '2026-10', kind: 'REGULAR' }))
    const other = await roleMember(
      client,
      o.s,
      'ps_outra',
      ['hr.payroll.read', 'hr.payroll.manage'],
      'LEGAL_ENTITY',
      o.le2.id
    )
    const X = as(client, other.session)
    assert.equal((await X.get(`${P}/runs/${r.id}`)).status(), 404)
    assert.lengthOf(ok(await X.get(`${P}/runs`), 200), 0)
    assert.equal(
      code(await run(X, { legalEntityId: o.le.id, period: '2026-10', kind: 'EXTRA' })),
      'OUT_OF_SCOPE'
    )
    ok(await run(X, { legalEntityId: o.le2.id, period: '2026-10', kind: 'EXTRA' }))

    // Um aprovador com o próprio recibo no lote não o aprova.
    ok(
      await o.api.patch(`${H}/employees/${o.e1.id}`, {
        membershipId: o.approver.memberId,
        expectedVersion: o.e1.version,
      }),
      200
    )
    let c = ok(await act(o.api, r, 'calculate'), 200)
    c = ok(await act(o.api, c, 'submit'), 200)
    assert.isFalse(ok(await o.A.get(`${P}/runs/${r.id}`), 200).access.approve)
    assert.equal(code(await act(o.A, c, 'decision', { decision: 'APPROVE' })), 'SEGREGATION')
    // Quem só aprova não calcula nem fecha.
    assert.equal(code(await act(o.A, c, 'close')), 'OUT_OF_SCOPE')
  })
})
