import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { dueLoanInstallments, recordLoanDeduction } from '#modules/hr/index'
import { addMonths } from '#modules/hr/domain/loans'
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
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
/** Mês corrente e seguintes, no formato AAAA-MM-01 (as regras não aceitam descontos em meses passados). */
const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`
const month = (n: number) => addMonths(thisMonth, n)

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

async function employee(api: any, le: any, d: any, suffix: string, contract: any = {}, extra = {}) {
  const e = ok(
    await api.post(`${H}/employees`, {
      code: `C${suffix}`,
      fullName: `Colaborador ${suffix}`,
      legalEntityId: le.id,
      departmentId: d.id,
      hireDate: '2026-01-05',
      ...extra,
    })
  )
  if (contract === null) return e
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
  ok(await api.post(`${H}/contracts/${c.id}/activate`, { expectedVersion: c.version }), 200)
  return e
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000706',
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
  const d2 = ok(
    await api.post('/api/v1/organization/departments', {
      code: 'D2',
      name: 'Vendas',
      legalEntityId: le.id,
    })
  )
  const e = await employee(api, le, d1, '001')
  const approver = await roleMember(
    client,
    s,
    'aprova_emp',
    ['hr.loans.read', 'hr.loans.approve'],
    'TENANT'
  )
  return { tenant, admin, s, api, le, d1, d2, e, approver, A: as(client, approver.session) }
}

async function submitted(o: any, employeeId: string, body: Record<string, unknown>) {
  const l = ok(await o.api.post(`${H}/employees/${employeeId}/loans`, body))
  return ok(await o.api.post(`${H}/loans/${l.id}/submit`, { expectedVersion: l.version }), 200)
}

test.group('RH | adiantamentos e empréstimos (7.6)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('pedido: validação, código, plano exacto ao cêntimo e nada retroactivo', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const L = `${H}/employees/${o.e.id}/loans`
    const bad = await o.api.post(L, {
      kind: 'ADVANCE',
      principal: '10.001',
      installmentsCount: 3,
      firstPeriod: '2026-13',
      reason: 'Adiantamento',
    })
    assert.equal(bad.status(), 422)
    assert.includeMembers(details(bad), ['INVALID_AMOUNT', 'INVALID', 'ADVANCE_SINGLE'])
    assert.include(details(await o.api.post(L, { kind: 'LOAN' })), 'REQUIRED')
    assert.include(
      details(
        await o.api.post(L, {
          kind: 'LOAN',
          principal: '0.02',
          installmentsCount: 3,
          firstPeriod: month(1),
          reason: 'Pouco',
        })
      ),
      'TOO_SMALL'
    )

    const loan = ok(
      await o.api.post(L, {
        kind: 'LOAN',
        principal: '100000',
        installmentsCount: 3,
        firstPeriod: month(1).slice(0, 7),
        reason: 'Empréstimo para habitação',
      })
    )
    const year = new Date().toISOString().slice(0, 4)
    assert.equal(loan.code, `EMP-${year}-0001`)
    assert.equal(loan.currency, 'AOA') // por omissão, a do contrato
    assert.equal(loan.status, 'DRAFT')
    assert.equal(loan.outstandingAmount, '100000.00')
    assert.deepEqual(
      loan.installments.map((i: any) => [i.duePeriod, i.amount, i.status]),
      [
        [month(1), '33333.33', 'PLANNED'],
        [month(2), '33333.33', 'PLANNED'],
        [month(3), '33333.34', 'PLANNED'],
      ]
    )
    const adv = ok(
      await o.api.post(L, {
        kind: 'ADVANCE',
        principal: '50000',
        installmentsCount: 1,
        firstPeriod: month(-1),
        reason: 'Adiantamento de salário',
      })
    )
    assert.equal(adv.code, `ADI-${year}-0001`)
    const r = await o.api.post(`${H}/loans/${adv.id}/submit`, { expectedVersion: adv.version })
    assert.include(details(r), 'NOT_RETROACTIVE')
    // Em rascunho, corrige-se; o tipo não muda.
    assert.include(
      details(
        await o.api.patch(`${H}/loans/${adv.id}`, { kind: 'LOAN', expectedVersion: adv.version })
      ),
      'IMMUTABLE'
    )
    const fixed = ok(
      await o.api.patch(`${H}/loans/${adv.id}`, {
        firstPeriod: thisMonth,
        expectedVersion: adv.version,
      }),
      200
    )
    assert.equal(
      code(await o.api.patch(`${H}/loans/${adv.id}`, { reason: 'x', expectedVersion: 0 })),
      'VERSION_CONFLICT'
    )
    const s = ok(
      await o.api.post(`${H}/loans/${adv.id}/submit`, { expectedVersion: fixed.version }),
      200
    )
    assert.equal(s.status, 'PENDING_APPROVAL')
    assert.equal(
      code(
        await o.api.patch(`${H}/loans/${adv.id}`, { reason: 'Outro', expectedVersion: s.version })
      ),
      'INVALID_STATE'
    )

    // Sem contrato não há salário onde descontar; nem para lá do fim de um contrato a termo.
    const noContract = await employee(o.api, o.le, o.d1, '002', null)
    const nc = ok(
      await o.api.post(`${H}/employees/${noContract.id}/loans`, {
        kind: 'LOAN',
        currency: 'AOA',
        principal: '1000',
        installmentsCount: 2,
        firstPeriod: month(1),
        reason: 'Sem contrato',
      })
    )
    assert.include(
      details(await o.api.post(`${H}/loans/${nc.id}/submit`, { expectedVersion: nc.version })),
      'NO_CONTRACT'
    )
    const fixedTerm = await employee(o.api, o.le, o.d1, '003', {
      contractType: 'FIXED_TERM',
      endDate: `${month(2).slice(0, 7)}-15`,
    })
    const ft = ok(
      await o.api.post(`${H}/employees/${fixedTerm.id}/loans`, {
        kind: 'LOAN',
        principal: '6000',
        installmentsCount: 6,
        firstPeriod: month(1),
        reason: 'Além do contrato',
      })
    )
    assert.include(
      details(await o.api.post(`${H}/loans/${ft.id}/submit`, { expectedVersion: ft.version })),
      'LOAN_BEYOND_CONTRACT'
    )
    const wrongCurrency = ok(
      await o.api.post(`${H}/employees/${o.e.id}/loans`, {
        kind: 'LOAN',
        currency: 'USD',
        principal: '100',
        installmentsCount: 1,
        firstPeriod: month(1),
        reason: 'Moeda errada',
      })
    )
    assert.include(
      details(
        await o.api.post(`${H}/loans/${wrongCurrency.id}/submit`, {
          expectedVersion: wrongCurrency.version,
        })
      ),
      'CURRENCY_MISMATCH'
    )
  })

  test('limites configurados com fonte: prestação máxima por mês somando os empréstimos activos', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const S = `${H}/settings`
    const current = ok(await o.api.get(S), 200)
    assert.include(
      details(
        await o.api.put(S, {
          loanMaxInstallmentPercent: '30',
          expectedVersion: current.version,
        })
      ),
      'REQUIRED'
    )
    assert.include(
      details(
        await o.api.put(S, {
          loanMaxInstallmentPercent: '130',
          loanPolicyReference: 'Regulamento interno',
          expectedVersion: current.version,
        })
      ),
      'INVALID'
    )
    const set = ok(
      await o.api.put(S, {
        loanMaxInstallmentPercent: '30',
        loanMaxInstallments: 12,
        loanPolicyReference: 'Regulamento interno de adiantamentos, art. 4.º',
        expectedVersion: current.version,
      }),
      200
    )
    assert.equal(set.loanMaxInstallmentPercent, '30.00')

    const base = {
      kind: 'LOAN',
      firstPeriod: month(1),
      reason: 'Empréstimo',
    }
    // 30% de 200 000 = 60 000 por mês.
    const tooBig = ok(
      await o.api.post(`${H}/employees/${o.e.id}/loans`, {
        ...base,
        principal: '200000',
        installmentsCount: 2,
      })
    )
    const r = await o.api.post(`${H}/loans/${tooBig.id}/submit`, {
      expectedVersion: tooBig.version,
    })
    assert.include(details(r), 'LIMIT_EXCEEDED')
    assert.match(r.body().error.details[0].message, /Regulamento interno/)
    const detail = ok(await o.api.get(`${H}/loans/${tooBig.id}`), 200)
    assert.include(
      detail.issues.map((i: any) => i.code),
      'LIMIT_EXCEEDED'
    )
    assert.equal(detail.limits.maxInstallments, 12)
    const many = ok(
      await o.api.post(`${H}/employees/${o.e.id}/loans`, {
        ...base,
        principal: '24000',
        installmentsCount: 24,
      })
    )
    assert.include(
      details(await o.api.post(`${H}/loans/${many.id}/submit`, { expectedVersion: many.version })),
      'TOO_MANY_INSTALLMENTS'
    )

    const first = await submitted(o, o.e.id, { ...base, principal: '120000', installmentsCount: 3 })
    // Enquanto o primeiro não está activo, o segundo cabe sozinho.
    const second = await submitted(o, o.e.id, { ...base, principal: '90000', installmentsCount: 3 })
    ok(
      await o.A.post(`${H}/loans/${first.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: first.version,
      }),
      200
    )
    // 40 000 + 30 000 > 60 000: o segundo já não se aprova.
    const stale = await o.A.post(`${H}/loans/${second.id}/decision`, {
      decision: 'APPROVE',
      expectedVersion: second.version,
    })
    assert.equal(stale.status(), 409)
    assert.equal(code(stale), 'STALE_LOAN')
    assert.include(details(stale), 'LIMIT_EXCEEDED')
  })

  test('aprovação segregada, plano criado na aprovação e liquidação sem duplicar descontos', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const loan = await submitted(o, o.e.id, {
      kind: 'LOAN',
      principal: '90000',
      installmentsCount: 3,
      firstPeriod: thisMonth,
      reason: 'Empréstimo pessoal',
    })
    assert.equal(
      code(
        await o.api.post(`${H}/loans/${loan.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: loan.version,
        })
      ),
      'SEGREGATION'
    )
    assert.lengthOf(ok(await o.api.get(`${H}/loans?toApprove=true`), 200), 0)
    assert.lengthOf(ok(await o.A.get(`${H}/loans?toApprove=true`), 200), 1)
    assert.include(
      details(
        await o.A.post(`${H}/loans/${loan.id}/decision`, {
          decision: 'REJECT',
          expectedVersion: loan.version,
        })
      ),
      'REQUIRED'
    )
    const active = ok(
      await o.A.post(`${H}/loans/${loan.id}/decision`, {
        decision: 'APPROVE',
        comment: 'De acordo',
        expectedVersion: loan.version,
      }),
      200
    )
    assert.equal(active.status, 'ACTIVE')
    assert.lengthOf(active.installments, 3)
    assert.isTrue(active.installments.every((i: any) => i.id && i.status === 'PENDING'))
    assert.equal(
      code(await o.api.post(`${H}/loans/${loan.id}/cancel`, { expectedVersion: active.version })),
      'INVALID_STATE'
    )

    // Processamento salarial (7.7): prestações do mês e registo idempotente do desconto.
    const ctx = (await o.api.get('/api/v1/context')).body().data
    const user = await owner().rawQuery(`select id from users where email = ?`, [o.admin.email])
    const context = {
      tenantId: ctx.tenant.id,
      userId: user.rows[0].id,
      membershipId: ctx.membershipId,
      requestId: 'teste',
    } as never
    const due = await runInTenant(context, (scope) => dueLoanInstallments(scope, o.e.id, thisMonth))
    assert.deepEqual(
      due.map((d) => [d.loanCode, d.sequence, d.amount, d.overdue]),
      [[active.code, 1, '30000.00', false]]
    )
    const inst = due[0].installmentId
    const done = await runInTenant(context, (scope) =>
      recordLoanDeduction(scope, inst, 'PROC-2026-11', thisMonth)
    )
    assert.isFalse(done.alreadyRecorded)
    const again = await runInTenant(context, (scope) =>
      recordLoanDeduction(scope, inst, 'PROC-2026-11', thisMonth)
    )
    assert.isTrue(again.alreadyRecorded)
    await assert.rejects(
      () =>
        runInTenant(context, (scope) => recordLoanDeduction(scope, inst, 'OUTRO-PROC', thisMonth)),
      /já não está por descontar/
    )
    // Dois meses depois, a segunda prestação aparece em atraso.
    const later = await runInTenant(context, (scope) =>
      dueLoanInstallments(scope, o.e.id, month(2))
    )
    assert.deepEqual(
      later.map((d) => [d.sequence, d.overdue]),
      [
        [2, true],
        [3, false],
      ]
    )

    let cur = ok(await o.api.get(`${H}/loans/${loan.id}`), 200)
    assert.equal(cur.paidAmount, '30000.00')
    assert.equal(cur.outstandingAmount, '60000.00')
    const P = (i: any) => `${H}/loans/${loan.id}/installments/${i.id}/payment`
    const today = new Date().toISOString().slice(0, 10)
    assert.equal(
      code(
        await o.api.post(P(cur.installments[0]), {
          reference: 'REC-1',
          paidOn: today,
          expectedVersion: cur.version,
        })
      ),
      'ALREADY_SETTLED'
    )
    assert.include(
      details(
        await o.api.post(P(cur.installments[1]), {
          reference: 'REC-1',
          paidOn: '2999-01-01',
          expectedVersion: cur.version,
        })
      ),
      'FUTURE'
    )
    // Quem só aprova não regista pagamentos.
    assert.equal(
      code(
        await o.A.post(P(cur.installments[1]), {
          reference: 'REC-1',
          paidOn: today,
          expectedVersion: cur.version,
        })
      ),
      'OUT_OF_SCOPE'
    )
    for (const i of cur.installments.slice(1)) {
      cur = ok(
        await o.api.post(P(i), {
          reference: `REC-${i.sequence}`,
          paidOn: today,
          note: 'Amortização antecipada',
          expectedVersion: cur.version,
        }),
        200
      )
    }
    cur = ok(await o.api.get(`${H}/loans/${loan.id}`), 200)
    assert.equal(cur.status, 'SETTLED')
    assert.equal(cur.outstandingAmount, '0.00')
    assert.deepEqual(
      cur.installments.map((i: any) => i.status),
      ['DEDUCTED', 'PAID', 'PAID']
    )
    const summary = ok(await o.api.get(`${H}/employees/${o.e.id}/loans`), 200)
    assert.isNull(summary.outstanding)
    assert.lengthOf(summary.items, 1)

    // Nunca liquidada sem rasto (garantido também na base de dados).
    await assert.rejects(() =>
      owner().rawQuery(
        `update employee_loan_installments set status = 'DEDUCTED', settlement_reference = null
          where id = ?`,
        [inst]
      )
    )
    // A auditoria regista as operações sem montantes.
    const events = await owner().rawQuery(
      `select action, changes::text as c, metadata::text as m from audit_events
        where entity_type = 'employee_loan' and entity_id = ? order by created_at`,
      [loan.id]
    )
    const actions = events.rows.map((x: any) => x.action)
    assert.includeMembers(actions, [
      'hr.loans.created',
      'hr.loans.pending_approval',
      'hr.loans.active',
      'hr.loans.installment_deducted',
      'hr.loans.installment_paid',
      'hr.loans.settled',
    ])
    for (const x of events.rows) assert.notMatch(`${x.c} ${x.m}`, /90000|30000/)
  })

  test('âmbito: outro departamento não vê; o próprio vê sem gerir nem aprovar', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const loan = ok(
      await o.api.post(`${H}/employees/${o.e.id}/loans`, {
        kind: 'ADVANCE',
        principal: '20000',
        installmentsCount: 1,
        firstPeriod: month(1),
        reason: 'Adiantamento',
      })
    )
    const other = await roleMember(
      client,
      o.s,
      'outro_dep',
      ['hr.loans.read', 'hr.loans.manage'],
      'DEPARTMENT',
      o.d2.id
    )
    const X = as(client, other.session)
    assert.equal((await X.get(`${H}/loans/${loan.id}`)).status(), 404)
    assert.equal((await X.get(`${H}/employees/${o.e.id}/loans`)).status(), 404)
    assert.lengthOf(ok(await X.get(`${H}/loans`), 200), 0)
    assert.equal(
      (
        await X.post(`${H}/employees/${o.e.id}/loans`, {
          kind: 'ADVANCE',
          principal: '1',
          installmentsCount: 1,
          firstPeriod: month(1),
          reason: 'Fora',
        })
      ).status(),
      404
    )

    const self = await roleMember(
      client,
      o.s,
      'proprio',
      ['hr.loans.read', 'hr.loans.approve'],
      'OWN'
    )
    ok(
      await o.api.patch(`${H}/employees/${o.e.id}`, {
        membershipId: self.memberId,
        expectedVersion: o.e.version,
      }),
      200
    )
    const S = as(client, self.session)
    const mine = ok(await S.get(`${H}/employees/${o.e.id}/loans`), 200)
    assert.isFalse(mine.access.manage)
    assert.isFalse(mine.access.approve)
    assert.lengthOf(ok(await S.get(`${H}/loans`), 200), 1)
    assert.equal(
      code(await S.post(`${H}/loans/${loan.id}/cancel`, { expectedVersion: loan.version })),
      'OUT_OF_SCOPE'
    )

    // Ninguém aprova o seu próprio empréstimo, mesmo com aprovação na empresa.
    ok(
      await o.api.patch(`${H}/employees/${o.e.id}`, {
        membershipId: o.approver.memberId,
        expectedVersion: o.e.version + 1,
      }),
      200
    )
    const s = ok(
      await o.api.post(`${H}/loans/${loan.id}/submit`, { expectedVersion: loan.version }),
      200
    )
    assert.isFalse(ok(await o.A.get(`${H}/loans/${loan.id}`), 200).access.approve)
    assert.equal(
      code(
        await o.A.post(`${H}/loans/${loan.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: s.version,
        })
      ),
      'SEGREGATION'
    )
    const cancelled = ok(
      await o.api.post(`${H}/loans/${loan.id}/cancel`, { expectedVersion: s.version }),
      200
    )
    assert.equal(cancelled.status, 'CANCELLED')
  })
})
