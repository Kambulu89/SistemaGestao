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

/*
 * Regressão do ciclo inteiro de RH (7.13): contrato → empréstimo → processamento regular com desconto da prestação →
 * pagamento → cessação com férias → liquidação por lote extra → checklist (empréstimo liquidado) → conclusão →
 * relatórios. Cruza 7.3, 7.4, 7.6, 7.7, 7.9, 7.11 e 7.12 e prova que nada é descontado ou contado duas vezes.
 */

const H = '/api/v1/hr'
const P = `${H}/payroll`
const T = `${H}/terminations`
const owner = () => db.connection('owner')
const now = new Date()
const YEAR = now.getUTCFullYear()
const MONTH = now.toISOString().slice(0, 7)
const lastDayOfMonth = new Date(Date.UTC(YEAR, now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
const TODAY = now.toISOString().slice(0, 10)

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

async function roleMember(client: any, admin: Session, roleCode: string, permissions: string[]) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'TENANT',
    }),
    200
  )
  return as(client, m.session)
}

test.group('RH | regressão do ciclo completo (7.13)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('admissão → empréstimo → salário → pagamento → cessação → liquidação → relatórios', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const api = L.api
    const PAY = await roleMember(client, L.s, 'ps', ['hr.payroll.read', 'hr.payroll.approve'])
    const LOAN = await roleMember(client, L.s, 'emp', ['hr.loans.read', 'hr.loans.approve'])
    const TERM = await roleMember(client, L.s, 'ces', [
      'hr.terminations.read',
      'hr.terminations.approve',
    ])

    // Regras, componente de férias e colaborador com contrato.
    const rs = ok(await api.post(`${P}/rule-sets`, RULES))
    const conf = ok(
      await api.post(`${P}/rule-sets/${rs.id}/confirm`, {
        note: 'Conferido',
        expectedVersion: rs.version,
      }),
      200
    )
    ok(await api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: conf.version }), 200)
    const vac = ok(
      await api.post(`${H}/pay-components`, {
        code: 'FERCES',
        name: 'Férias na cessação',
        kind: 'EARNING',
        category: 'OTHER',
        calculation: 'VARIABLE',
        recurring: false,
      })
    )
    ok(
      await api.post(`${H}/pay-components/${vac.id}/incidences`, {
        validFrom: '2020-01-01',
        irtSubject: true,
        inssSubject: true,
        legalReference: 'Incidência de teste',
      })
    )
    const e = ok(
      await api.post(`${H}/employees`, {
        code: 'CICLO',
        fullName: 'Célia Ciclo',
        legalEntityId: L.le.id,
        hireDate: `${YEAR}-01-05`,
      })
    )
    const ct = ok(
      await api.post(`${H}/employees/${e.id}/contracts`, {
        code: 'CT-CICLO',
        contractType: 'PERMANENT',
        startDate: `${YEAR}-01-05`,
        weeklyHours: '40',
        currency: 'AOA',
        baseSalary: '200000',
      })
    )
    ok(await api.post(`${H}/contracts/${ct.id}/activate`, { expectedVersion: ct.version }), 200)

    // Empréstimo de 90 000 em 3 prestações a começar neste mês.
    let loan = ok(
      await api.post(`${H}/employees/${e.id}/loans`, {
        kind: 'LOAN',
        principal: '90000',
        installmentsCount: 3,
        firstPeriod: MONTH,
        reason: 'Empréstimo pessoal',
      })
    )
    loan = ok(
      await api.post(`${H}/loans/${loan.id}/submit`, { expectedVersion: loan.version }),
      200
    )
    loan = ok(
      await LOAN.post(`${H}/loans/${loan.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: loan.version,
      }),
      200
    )
    assert.equal(loan.status, 'ACTIVE')

    // Processamento regular do mês: desconta a prestação uma vez.
    const act = (who: any, r: any, path: string, body: Record<string, unknown> = {}) =>
      who.post(`${P}/runs/${r.id}/${path}`, { ...body, expectedVersion: r.version })
    const close = async (r: any) => {
      r = ok(await act(api, r, 'calculate'), 200)
      assert.equal(r.errorsCount, 0, JSON.stringify(r.results?.[0]?.errors))
      r = ok(await act(api, r, 'submit'), 200)
      r = ok(await act(PAY, r, 'decision', { decision: 'APPROVE' }), 200)
      return ok(await act(api, r, 'close'), 200)
    }
    let run = ok(
      await api.post(`${P}/runs`, { legalEntityId: L.le.id, period: MONTH, kind: 'REGULAR' })
    )
    run = await close(run)
    const res = run.results.find((x: any) => x.employee.id === e.id)
    assert.equal(res.gross, '200000.00')
    assert.equal(res.loans, '30000.00')
    assert.equal(res.net, '154600.00') // 200 000 − 6 000 INSS − 9 400 IRT − 30 000 prestação
    loan = ok(await api.get(`${H}/loans/${loan.id}`), 200)
    assert.equal(loan.outstandingAmount, '60000.00')

    // Pagamento do líquido.
    const pay = ok(await api.get(`${P}/runs/${run.id}/payments`), 200)
    const net = pay.obligations.find((o: any) => o.kind === 'NET_PAY')
    ok(
      await api.post(`${P}/obligations/${net.id}/payments`, {
        amount: net.amount,
        paidOn: TODAY,
        reference: 'TRF-CICLO',
        expectedVersion: net.version,
      })
    )

    // Cessação no último dia do mês (já processado e fechado), com 5 dias de férias pagos.
    ok(
      await api.post(`${H}/employees/${e.id}/leave/adjustments`, {
        year: YEAR,
        days: '5',
        reason: 'Saldo de teste',
      })
    )
    let t = ok(
      await api.post(`${H}/employees/${e.id}/terminations`, {
        reason: 'MUTUAL_AGREEMENT',
        details: 'Acordo de cessação.',
        lastWorkingDay: lastDayOfMonth,
        indemnityApplicable: false,
      })
    )
    t = ok(
      await api.post(`${T}/${t.id}/lines`, {
        kind: 'UNUSED_VACATION',
        componentId: vac.id,
        description: 'Férias não gozadas',
        quantity: '5',
        rate: '10000',
        amount: '50000',
        basis: 'Critério da empresa (teste)',
        expectedVersion: t.version,
      }),
      200
    )
    t = ok(await api.post(`${T}/${t.id}/submit`, { expectedVersion: t.version }), 200)
    t = ok(
      await TERM.post(`${T}/${t.id}/decision`, { approve: true, expectedVersion: t.version }),
      200
    )
    assert.equal(t.status, 'APPROVED')
    assert.equal(t.facts.vacation.balance, '0.00')
    assert.exists(t.tasks.find((k: any) => k.kind === 'LOANS'))
    // Terminado: sem novo empréstimo nem contrato.
    assert.equal(
      (
        await api.post(`${H}/employees/${e.id}/loans`, {
          kind: 'ADVANCE',
          principal: '1000',
          installmentsCount: 1,
          firstPeriod: MONTH,
          reason: 'Depois da saída',
        })
      ).status(),
      409
    )

    // Liquidação: o mês do último dia está fechado → o lote vai para o mês seguinte, com as condições do contrato.
    t = ok(await api.post(`${T}/${t.id}/settlement`, { expectedVersion: t.version }), 200)
    let settle = ok(await api.get(`${P}/runs/${t.settlementRun.id}`), 200)
    assert.equal(settle.kind, 'EXTRA')
    assert.notEqual(settle.period.slice(0, 7), MONTH)
    settle = await close(settle)
    const sres = settle.results[0]
    assert.equal(sres.gross, '50000.00')
    assert.equal(sres.loans, '0.00') // o lote extra não desconta prestações

    // Checklist: o empréstimo só fica tratado depois de liquidado.
    const loansTask = () => t.tasks.find((k: any) => k.kind === 'LOANS')
    let k = loansTask()
    assert.equal(
      (
        await api.patch(`${H}/termination-tasks/${k.id}`, {
          status: 'DONE',
          expectedVersion: k.version,
        })
      ).body().error.code,
      'LOANS_OUTSTANDING'
    )
    loan = ok(await api.get(`${H}/loans/${loan.id}`), 200)
    for (const i of loan.installments.filter((x: any) => x.status === 'PENDING')) {
      const fresh = ok(await api.get(`${H}/loans/${loan.id}`), 200)
      ok(
        await api.post(`${H}/loans/${loan.id}/installments/${i.id}/payment`, {
          reference: `REC-${i.sequence ?? i.id.slice(0, 4)}`,
          paidOn: TODAY,
          expectedVersion: fresh.version,
        }),
        200
      )
    }
    loan = ok(await api.get(`${H}/loans/${loan.id}`), 200)
    assert.equal(loan.status, 'SETTLED')
    t = ok(await api.get(`${T}/${t.id}`), 200)
    for (k of t.tasks)
      t = ok(
        await api.patch(`${H}/termination-tasks/${k.id}`, {
          status: 'DONE',
          expectedVersion: k.version,
        }),
        200
      )
    t = ok(await api.post(`${T}/${t.id}/complete`, { expectedVersion: t.version }), 200)
    assert.equal(t.status, 'SETTLED')

    // Relatórios coerentes com tudo o que aconteceu.
    const tv = ok(await api.get(`${H}/reports/turnover?year=${YEAR}`), 200)
    assert.equal(tv.exits, 1)
    assert.equal(tv.hires, 1)
    const hc = ok(await api.get(`${H}/reports/headcount?date=${lastDayOfMonth}`), 200)
    assert.equal(hc.total, 1) // o último dia conta
    const pr = ok(await api.get(`${H}/reports/payroll?year=${settle.period.slice(0, 4)}`), 200)
    const kinds = pr.byKind.map((x: any) => [x.kind, x.gross])
    if (settle.period.slice(0, 4) === String(YEAR))
      assert.sameDeepMembers(kinds, [
        ['EXTRA', '50000.00'],
        ['REGULAR', '200000.00'],
      ])
    else assert.deepEqual(kinds, [['EXTRA', '50000.00']])

    // Prestações descontadas uma única vez (uma no salário, duas pagas à parte).
    const inst = await owner().rawQuery(
      `select status, count(*)::int as n from employee_loan_installments where loan_id = ? group by status order by status`,
      [loan.id]
    )
    assert.deepEqual(
      inst.rows.map((x: any) => [x.status, x.n]),
      [
        ['DEDUCTED', 1],
        ['PAID', 2],
      ]
    )
  })
})
