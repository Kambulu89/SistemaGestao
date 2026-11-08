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

/** Colaborador com contrato em vigor desde 2026-01-05 e salário base 200 000. */
async function employeeWithContract(api: any, le: any, d: any, codeSuffix: string, extra = {}) {
  const e = ok(
    await api.post(`${H}/employees`, {
      code: `C${codeSuffix}`,
      fullName: `Colaborador ${codeSuffix}`,
      legalEntityId: le.id,
      departmentId: d.id,
      hireDate: '2026-01-05',
      ...extra,
    })
  )
  const c = ok(
    await api.post(`${H}/employees/${e.id}/contracts`, {
      code: `CT-${codeSuffix}`,
      contractType: 'PERMANENT',
      startDate: '2026-01-05',
      weeklyHours: '40',
      currency: 'AOA',
      baseSalary: '200000',
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
      taxId: '5000000701',
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
  const comp = (body: Record<string, unknown>) => api.post(`${H}/pay-components`, body)
  const meal = ok(
    await comp({
      code: 'SUBALIM',
      name: 'Subsídio de alimentação',
      kind: 'EARNING',
      category: 'ALLOWANCE',
      calculation: 'FIXED',
    })
  )
  const bonus = ok(
    await comp({
      code: 'PREMIO',
      name: 'Prémio de desempenho',
      kind: 'EARNING',
      category: 'BONUS',
      calculation: 'PERCENT_OF_BASE',
    })
  )
  const overtime = ok(
    await comp({
      code: 'HEXTRA',
      name: 'Horas extra',
      kind: 'EARNING',
      category: 'OVERTIME',
      calculation: 'VARIABLE',
      recurring: false,
    })
  )
  const loan = ok(
    await comp({
      code: 'DESCONTO',
      name: 'Desconto acordado',
      kind: 'DEDUCTION',
      category: 'DEDUCTION',
      calculation: 'FIXED',
    })
  )
  const e = await employeeWithContract(api, le, d1, '001')
  const approver = await roleMember(
    client,
    s,
    'aprova_comp',
    ['hr.compensation.read', 'hr.compensation.approve'],
    'TENANT'
  )
  return {
    s,
    api,
    le,
    d1,
    d2,
    meal,
    bonus,
    overtime,
    loan,
    e,
    approver,
    A: as(client, approver.session),
  }
}

test.group('RH | compensação e benefícios (7.5)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('catálogo e incidência de IRT/INSS por vigência, com fonte e só de acréscimo', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    assert.include(
      details(
        await o.api.post(`${H}/pay-components`, {
          code: 'X',
          name: 'Errado',
          kind: 'EARNING',
          category: 'DEDUCTION',
          calculation: 'FIXED',
        })
      ),
      'INCONSISTENT'
    )
    assert.equal(
      code(
        await o.api.post(`${H}/pay-components`, {
          code: 'subalim',
          name: 'Outro',
          kind: 'EARNING',
          category: 'ALLOWANCE',
          calculation: 'FIXED',
        })
      ),
      'CODE_TAKEN'
    )
    const I = `${H}/pay-components/${o.meal.id}/incidences`
    assert.include(
      details(
        await o.api.post(I, { validFrom: '2026-01-01', irtSubject: true, inssSubject: true })
      ),
      'REQUIRED'
    )
    ok(
      await o.api.post(I, {
        validFrom: '2026-01-01',
        irtSubject: true,
        irtExemptAmount: '30000',
        inssSubject: false,
        legalReference: 'Regras a confirmar no Código do IRT em vigor (configuração da empresa).',
      })
    )
    assert.include(
      details(
        await o.api.post(I, {
          validFrom: '2026-01-01',
          irtSubject: false,
          inssSubject: false,
          legalReference: 'Outra fonte',
        })
      ),
      'NOT_AFTER_PREVIOUS'
    )
    const v2 = ok(
      await o.api.post(I, {
        validFrom: '2027-01-01',
        irtSubject: true,
        inssSubject: true,
        legalReference: 'Alteração legislativa',
      })
    )
    assert.deepEqual(
      v2.incidences.map((i: any) => [i.validFrom, i.irtSubject, i.irtExemptAmount, i.inssSubject]),
      [
        ['2027-01-01', true, null, true],
        ['2026-01-01', true, '30000.00', false],
      ]
    )
    // O catálogo mostra a incidência em vigor hoje (a de 2026, com a parte isenta).
    const listed = ok(await o.api.get(`${H}/pay-components`), 200).find(
      (c: any) => c.id === o.meal.id
    )
    assert.deepEqual(listed.currentIncidence, {
      irtSubject: true,
      inssSubject: false,
      irtExemptAmount: '30000.00',
    })
    // Um desconto não é rendimento sujeito.
    assert.include(
      details(
        await o.api.post(`${H}/pay-components/${o.loan.id}/incidences`, {
          validFrom: '2026-01-01',
          irtSubject: true,
          inssSubject: false,
          legalReference: 'x x x x x',
        })
      ),
      'INVALID'
    )
    // O cálculo não muda depois de usado em propostas.
    ok(
      await o.api.post(`${H}/employees/${o.e.id}/compensation/proposals`, {
        effectiveDate: '2026-02-01',
        reason: 'Admissão',
        lines: [{ componentId: o.meal.id, action: 'SET', amount: '25000' }],
      })
    )
    assert.include(
      details(
        await o.api.patch(`${H}/pay-components/${o.meal.id}`, {
          calculation: 'PERCENT_OF_BASE',
          expectedVersion: o.meal.version,
        })
      ),
      'IN_USE'
    )
    ok(
      await o.api.patch(`${H}/pay-components/${o.meal.id}`, {
        name: 'Subsídio de refeição',
        expectedVersion: o.meal.version,
      }),
      200
    )
    // Sem hr.compensation.settings não se configura.
    assert.equal((await o.A.post(`${H}/pay-components`, { code: 'Z' })).status(), 403)
    // O catálogo (sem valores) lê-se com qualquer permissão de compensação; sem nenhuma, não.
    assert.lengthOf(ok(await o.A.get(`${H}/pay-components`), 200), 4)
    const reader = await roleMember(client, o.s, 'so_rh', ['hr.read'], 'TENANT')
    assert.equal((await as(client, reader.session).get(`${H}/pay-components`)).status(), 403)
  })

  test('propostas: validação, segregação, aplicação com vigência, histórico e remuneração numa data', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    ok(
      await o.api.post(`${H}/pay-components/${o.meal.id}/incidences`, {
        validFrom: '2026-01-01',
        irtSubject: true,
        irtExemptAmount: '30000',
        inssSubject: false,
        legalReference: 'Fonte A',
      })
    )
    const P = `${H}/employees/${o.e.id}/compensation/proposals`
    const propose = (effectiveDate: string, lines: unknown[]) =>
      o.api.post(P, { effectiveDate, reason: 'Revisão anual', lines })
    assert.include(
      details(
        await propose('2026-02-01', [{ componentId: o.overtime.id, action: 'SET', amount: '1' }])
      ),
      'VARIABLE_COMPONENT'
    )
    assert.include(
      details(
        await propose('2026-02-01', [{ componentId: o.meal.id, action: 'SET', percent: '5' }])
      ),
      'INVALID_AMOUNT'
    )
    assert.include(
      details(
        await propose('2026-02-01', [{ componentId: o.bonus.id, action: 'SET', percent: '120' }])
      ),
      'INVALID_PERCENT'
    )
    assert.include(details(await propose('2026-02-01', [])), 'REQUIRED')
    // Sem contrato na data de efeito não se submete.
    const early = ok(
      await propose('2025-12-01', [{ componentId: o.meal.id, action: 'SET', amount: '1000' }])
    )
    assert.include(
      details(
        await o.api.post(`${H}/compensation/proposals/${early.id}/submit`, {
          expectedVersion: early.version,
        })
      ),
      'NO_CONTRACT'
    )
    ok(
      await o.api.post(`${H}/compensation/proposals/${early.id}/cancel`, {
        expectedVersion: early.version,
      }),
      200
    )

    const p1 = ok(
      await propose('2026-02-01', [
        { componentId: o.meal.id, action: 'SET', amount: '25000' },
        { componentId: o.bonus.id, action: 'SET', percent: '10' },
      ])
    )
    const s1 = ok(
      await o.api.post(`${H}/compensation/proposals/${p1.id}/submit`, {
        expectedVersion: p1.version,
      }),
      200
    )
    assert.equal(s1.status, 'PENDING_APPROVAL')
    assert.equal(
      code(
        await o.api.post(`${H}/compensation/proposals/${p1.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: s1.version,
        })
      ),
      'SEGREGATION'
    )
    assert.include(
      details(
        await o.A.post(`${H}/compensation/proposals/${p1.id}/decision`, {
          decision: 'REJECT',
          expectedVersion: s1.version,
        })
      ),
      'REQUIRED'
    )
    assert.equal(
      ok(
        await o.A.post(`${H}/compensation/proposals/${p1.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: s1.version,
        }),
        200
      ).status,
      'APPLIED'
    )

    const at = async (date: string) =>
      ok(await o.api.get(`${H}/employees/${o.e.id}/compensation?date=${date}`), 200).at
    assert.deepEqual((await at('2026-01-15')).lines, [])
    const march = await at('2026-03-01')
    assert.equal(march.baseSalary, '200000.00')
    assert.deepEqual(
      march.lines.map((l: any) => [
        l.code,
        l.amount,
        l.percent,
        l.incidence?.irtExemptAmount ?? null,
      ]),
      [
        ['PREMIO', '20000.00', '10.0000', null],
        ['SUBALIM', '25000.00', null, '30000.00'],
      ]
    )
    assert.isNull(march.lines[0].incidence) // sem incidência definida: o processamento terá de a resolver

    // Não retroage antes do período em vigor; só se remove o que existe.
    const retro = ok(
      await propose('2026-01-20', [{ componentId: o.meal.id, action: 'SET', amount: '1' }])
    )
    assert.include(
      details(
        await o.api.post(`${H}/compensation/proposals/${retro.id}/submit`, {
          expectedVersion: retro.version,
        })
      ),
      'NOT_AFTER_CURRENT'
    )
    const nothing = ok(await propose('2026-06-01', [{ componentId: o.loan.id, action: 'REMOVE' }]))
    assert.include(
      details(
        await o.api.post(`${H}/compensation/proposals/${nothing.id}/submit`, {
          expectedVersion: nothing.version,
        })
      ),
      'NOTHING_TO_REMOVE'
    )

    // Alteração e remoção a partir de 01/05.
    const p2 = ok(
      await propose('2026-05-01', [
        { componentId: o.meal.id, action: 'SET', amount: '30000' },
        { componentId: o.bonus.id, action: 'REMOVE' },
      ])
    )
    const s2 = ok(
      await o.api.post(`${H}/compensation/proposals/${p2.id}/submit`, {
        expectedVersion: p2.version,
      }),
      200
    )
    ok(
      await o.A.post(`${H}/compensation/proposals/${p2.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: s2.version,
      }),
      200
    )
    assert.deepEqual(
      (await at('2026-06-01')).lines.map((l: any) => [l.code, l.amount]),
      [['SUBALIM', '30000.00']]
    )
    assert.deepEqual(
      (await at('2026-04-30')).lines.map((l: any) => [l.code, l.amount]),
      [
        ['PREMIO', '20000.00'],
        ['SUBALIM', '25000.00'],
      ]
    )
    const summary = ok(await o.api.get(`${H}/employees/${o.e.id}/compensation`), 200)
    assert.deepEqual(
      summary.history.map((h: any) => [h.code, h.validFrom, h.validTo]),
      [
        ['PREMIO', '2026-02-01', '2026-04-30'],
        ['SUBALIM', '2026-05-01', null],
        ['SUBALIM', '2026-02-01', '2026-04-30'],
      ]
    )

    // Duas propostas sobre o mesmo componente: a segunda a ser aprovada já não se aplica.
    const a1 = ok(
      await propose('2026-07-01', [{ componentId: o.meal.id, action: 'SET', amount: '31000' }])
    )
    const a2 = ok(
      await propose('2026-06-15', [{ componentId: o.meal.id, action: 'SET', amount: '32000' }])
    )
    const sa1 = ok(
      await o.api.post(`${H}/compensation/proposals/${a1.id}/submit`, {
        expectedVersion: a1.version,
      }),
      200
    )
    const sa2 = ok(
      await o.api.post(`${H}/compensation/proposals/${a2.id}/submit`, {
        expectedVersion: a2.version,
      }),
      200
    )
    ok(
      await o.A.post(`${H}/compensation/proposals/${a1.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: sa1.version,
      }),
      200
    )
    assert.equal(
      code(
        await o.A.post(`${H}/compensation/proposals/${a2.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: sa2.version,
        })
      ),
      'STALE_PROPOSAL'
    )
    assert.lengthOf(ok(await o.A.get(`${H}/compensation/proposals?toApprove=true`), 200), 1)

    // Ninguém aprova a sua própria remuneração.
    const own = await employeeWithContract(o.api, o.le, o.d1, '002', {
      membershipId: o.approver.memberId,
    })
    const po = ok(
      await o.api.post(`${H}/employees/${own.id}/compensation/proposals`, {
        effectiveDate: '2026-03-01',
        reason: 'Aumento',
        lines: [{ componentId: o.meal.id, action: 'SET', amount: '1000' }],
      })
    )
    const so = ok(
      await o.api.post(`${H}/compensation/proposals/${po.id}/submit`, {
        expectedVersion: po.version,
      }),
      200
    )
    assert.equal(
      code(
        await o.A.post(`${H}/compensation/proposals/${po.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: so.version,
        })
      ),
      'SEGREGATION'
    )

    // A auditoria não leva valores.
    const ev = await db
      .connection('owner')
      .rawQuery(
        `select coalesce(metadata::text, '') || coalesce(changes::text, '') as t from audit_events where action like 'hr.compensation.%'`
      )
    const text = ev.rows.map((r: any) => r.t).join(' ')
    for (const v of ['25000', '30000', '31000', '20000']) assert.notInclude(text, v)
    assert.include(text, '[RESERVADO]')
  })

  test('âmbitos e workflow: leitura por permissão própria; decisão no workflow configurado', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const reader = await roleMember(client, o.s, 'leitor', ['hr.read'], 'TENANT')
    assert.equal(
      (await as(client, reader.session).get(`${H}/employees/${o.e.id}/compensation`)).status(),
      404
    )
    const otherDept = await roleMember(
      client,
      o.s,
      'gere_d2',
      ['hr.compensation.manage'],
      'DEPARTMENT',
      o.d2.id
    )
    assert.equal(
      (await as(client, otherDept.session).get(`${H}/employees/${o.e.id}/compensation`)).status(),
      404
    )
    const self = await roleMember(client, o.s, 'proprio', ['hr.compensation.read'], 'OWN')
    ok(
      await o.api.patch(`${H}/employees/${o.e.id}`, {
        membershipId: self.memberId,
        expectedVersion: o.e.version,
      }),
      200
    )
    const mine = ok(
      await as(client, self.session).get(`${H}/employees/${o.e.id}/compensation`),
      200
    )
    assert.isFalse(mine.access.manage)
    assert.equal(
      code(
        await as(client, self.session).post(`${H}/employees/${o.e.id}/compensation/proposals`, {
          effectiveDate: '2026-03-01',
          reason: 'Pedido',
          lines: [],
        })
      ),
      'OUT_OF_SCOPE'
    )

    // Workflow das propostas de compensação.
    const approverMember = await memberWithRoles(client, o.s, [])
    const wf = ok(
      await o.api.post('/api/v1/approvals/workflows', {
        code: 'COMP',
        name: 'Compensação',
        subjectType: 'compensation_proposal',
        steps: [
          {
            name: 'Direcção',
            approverType: 'MEMBER',
            approverMembershipId: approverMember.memberId,
          },
        ],
      })
    )
    ok(
      await o.api.post(`/api/v1/approvals/workflows/${wf.id}/publish`, {
        expectedVersion: wf.version,
      }),
      200
    )
    ok(await o.api.put(`${H}/settings`, { compensationWorkflowId: wf.id, expectedVersion: 0 }), 200)
    const p = ok(
      await o.api.post(`${H}/employees/${o.e.id}/compensation/proposals`, {
        effectiveDate: '2026-02-01',
        reason: 'Revisão',
        lines: [{ componentId: o.meal.id, action: 'SET', amount: '25000' }],
      })
    )
    const sub = ok(
      await o.api.post(`${H}/compensation/proposals/${p.id}/submit`, {
        expectedVersion: p.version,
      }),
      200
    )
    assert.isNotNull(sub.approvalRequestId)
    assert.equal(
      code(
        await o.A.post(`${H}/compensation/proposals/${p.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: sub.version,
        })
      ),
      'USE_APPROVAL_WORKFLOW'
    )
    ok(
      await as(client, approverMember.session).post(
        `/api/v1/approvals/requests/${sub.approvalRequestId}/decisions`,
        { decision: 'APPROVE' }
      ),
      200
    )
    const detail = ok(await o.api.get(`${H}/compensation/proposals/${p.id}`), 200)
    assert.equal(detail.status, 'APPLIED')
    assert.equal(detail.approvalMode, 'WORKFLOW')
    const at = ok(await o.api.get(`${H}/employees/${o.e.id}/compensation?date=2026-03-01`), 200).at
    assert.deepEqual(
      at.lines.map((l: any) => l.amount),
      ['25000.00']
    )
  })
})
