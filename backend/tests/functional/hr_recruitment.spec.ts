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

const R = '/api/v1/hr'

const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)

/** Duas entidades legais; em A um departamento com cargo, em B um departamento com cargo. */
async function structure(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = (c: string, taxId: string) =>
    api.post('/api/v1/organization/legal-entities', {
      code: c,
      legalName: `Entidade ${c}, Lda.`,
      taxId,
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  const leA = ok(await le('LEA', '5000000401'))
  const leB = ok(await le('LEB', '5000000402'))
  const dA = ok(
    await api.post('/api/v1/organization/departments', {
      code: 'DA',
      name: 'Finanças',
      legalEntityId: leA.id,
    })
  )
  const dB = ok(
    await api.post('/api/v1/organization/departments', {
      code: 'DB',
      name: 'Vendas',
      legalEntityId: leB.id,
    })
  )
  const pA = ok(
    await api.post('/api/v1/organization/positions', {
      code: 'PA',
      name: 'Contabilista',
      departmentId: dA.id,
    })
  )
  const pB = ok(
    await api.post('/api/v1/organization/positions', {
      code: 'PB',
      name: 'Vendedor',
      departmentId: dB.id,
    })
  )
  return { s, api, leA, leB, dA, dB, pA, pB }
}

async function scopedMember(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scopeType: string,
  scopeId?: string
) {
  const role = await createRole(client, admin, roleCode, permissions)
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

const requisition = (
  o: Awaited<ReturnType<typeof structure>>,
  extra: Record<string, unknown> = {}
) => ({
  code: 'V-001',
  title: 'Contabilista sénior',
  legalEntityId: o.leA.id,
  departmentId: o.dA.id,
  positionId: o.pA.id,
  requirements: 'Licenciatura em contabilidade; 5 anos de experiência.',
  quantity: 1,
  deadline: day(30),
  currency: 'aoa',
  salaryMin: '150000',
  salaryMax: '250000.00',
  ...extra,
})

/** Vaga aberta por decisão directa (o admin pede, o aprovador aprova). */
async function openRequisition(
  client: any,
  o: Awaited<ReturnType<typeof structure>>,
  approver: Session,
  extra: Record<string, unknown> = {}
) {
  const r = ok(await o.api.post(`${R}/requisitions`, requisition(o, extra)))
  const sub = ok(
    await o.api.post(`${R}/requisitions/${r.id}/submit`, { expectedVersion: r.version }),
    200
  )
  return ok(
    await as(client, approver).post(`${R}/requisitions/${r.id}/decision`, {
      decision: 'APPROVE',
      expectedVersion: sub.version,
    }),
    200
  )
}

/** Proposta aceite numa candidatura nova à vaga. */
async function acceptedOffer(
  client: any,
  o: Awaited<ReturnType<typeof structure>>,
  approver: Session,
  requisitionId: string,
  name: string
) {
  const c = ok(await o.api.post(`${R}/candidates`, { fullName: name, phone: '+244 923 000 111' }))
  const a = ok(await o.api.post(`${R}/applications`, { requisitionId, candidateId: c.id }))
  const app = ok(
    await o.api.post(`${R}/applications/${a.id}/stage`, {
      stage: 'SCREENING',
      expectedVersion: a.version,
    }),
    200
  )
  void app
  const offer = ok(
    await o.api.post(`${R}/applications/${a.id}/offers`, { salary: '180000', startDate: day(14) })
  )
  const sub = ok(
    await o.api.post(`${R}/offers/${offer.id}/submit`, { expectedVersion: offer.version }),
    200
  )
  const appr = ok(
    await as(client, approver).post(`${R}/offers/${offer.id}/decision`, {
      decision: 'APPROVE',
      expectedVersion: sub.version,
    }),
    200
  )
  return ok(
    await o.api.post(`${R}/offers/${offer.id}/response`, {
      accepted: true,
      expectedVersion: appr.version,
    }),
    200
  )
}

test.group('RH | recrutamento e onboarding (7.2)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('fluxo completo: vaga, candidatura, entrevista, avaliação, proposta, contratação e checklist', async ({
    client,
    assert,
  }) => {
    const o = await structure(client)
    const approver = await scopedMember(
      client,
      o.s,
      'aprova_rh',
      ['hr.recruitment.approve'],
      'TENANT'
    )
    const interviewer = await memberWithRoles(client, o.s, [])

    // Vaga: remuneração autorizada coerente e colocação da mesma entidade.
    const bad = await o.api.post(`${R}/requisitions`, requisition(o, { salaryMin: '300000' }))
    assert.equal(bad.status(), 422)
    assert.include(
      bad.body().error.details.map((d: any) => d.code),
      'RANGE'
    )
    const otherLe = await o.api.post(`${R}/requisitions`, requisition(o, { positionId: o.pB.id }))
    assert.include(
      otherLe.body().error.details.map((d: any) => d.code),
      'OTHER_DEPARTMENT'
    )
    const r = ok(await o.api.post(`${R}/requisitions`, requisition(o)))
    assert.equal(r.currency, 'AOA')
    assert.equal(r.salaryMin, '150000.00')
    assert.equal(r.status, 'DRAFT')
    assert.equal(code(await o.api.post(`${R}/requisitions`, requisition(o))), 'CODE_TAKEN')

    // Aprovação directa: quem pede não aprova; recusar exige motivo e devolve a rascunho.
    let v = ok(
      await o.api.post(`${R}/requisitions/${r.id}/submit`, { expectedVersion: r.version }),
      200
    )
    assert.equal(v.status, 'PENDING_APPROVAL')
    const self = await o.api.post(`${R}/requisitions/${r.id}/decision`, {
      decision: 'APPROVE',
      expectedVersion: v.version,
    })
    assert.equal(self.status(), 403)
    assert.equal(code(self), 'SEGREGATION')
    const ap = as(client, approver.session)
    assert.equal(
      (
        await ap.post(`${R}/requisitions/${r.id}/decision`, {
          decision: 'REJECT',
          expectedVersion: v.version,
        })
      ).status(),
      422
    )
    v = ok(
      await ap.post(`${R}/requisitions/${r.id}/decision`, {
        decision: 'REJECT',
        reason: 'Rever a remuneração',
        expectedVersion: v.version,
      }),
      200
    )
    assert.equal(v.status, 'DRAFT')
    assert.equal(v.rejectionReason, 'Rever a remuneração')
    v = ok(
      await o.api.post(`${R}/requisitions/${r.id}/submit`, { expectedVersion: v.version }),
      200
    )
    v = ok(
      await ap.post(`${R}/requisitions/${r.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: v.version,
      }),
      200
    )
    assert.equal(v.status, 'OPEN')
    // Uma vaga aberta já não se altera.
    assert.equal(
      code(
        await o.api.patch(`${R}/requisitions/${r.id}`, {
          title: 'Outro',
          expectedVersion: v.version,
        })
      ),
      'INVALID_STATE'
    )

    // Candidato e candidatura (uma por vaga); email único sem distinguir maiúsculas.
    const c = ok(
      await o.api.post(`${R}/candidates`, {
        fullName: 'Beatriz Neto',
        email: 'Beatriz.Neto@exemplo.ao',
        phone: '+244 923 111 222',
        source: 'Site',
      })
    )
    assert.equal(c.email, 'beatriz.neto@exemplo.ao')
    assert.equal(
      code(
        await o.api.post(`${R}/candidates`, { fullName: 'Outra', email: 'BEATRIZ.NETO@exemplo.ao' })
      ),
      'EMAIL_TAKEN'
    )
    assert.equal((await o.api.post(`${R}/candidates`, { fullName: 'Sem contacto' })).status(), 422)
    const a = ok(await o.api.post(`${R}/applications`, { requisitionId: r.id, candidateId: c.id }))
    assert.equal(a.stage, 'APPLIED')
    assert.equal(
      code(await o.api.post(`${R}/applications`, { requisitionId: r.id, candidateId: c.id })),
      'ALREADY_APPLIED'
    )

    // Entrevista: o entrevistador (sem permissões de RH) vê só a sua e avalia depois de realizada.
    const i = ok(
      await o.api.post(`${R}/applications/${a.id}/interviews`, {
        scheduledAt: `${day(2)}T10:00:00+01:00`,
        durationMinutes: 45,
        mode: 'VIDEO',
        location: 'Sala virtual',
        interviewerMembershipId: interviewer.memberId,
      })
    )
    assert.equal(i.interviewer.membershipId, interviewer.memberId)
    const iv = as(client, interviewer.session)
    const mine = ok(await iv.get(`${R}/interviews/mine`), 200)
    assert.lengthOf(mine, 1)
    assert.equal(mine[0].candidateName, 'Beatriz Neto')
    assert.equal((await iv.get(`${R}/applications/${a.id}`)).status(), 404)
    assert.equal((await iv.get(`${R}/requisitions/${r.id}`)).status(), 404)
    const early = await iv.post(`${R}/applications/${a.id}/evaluations`, {
      interviewId: i.id,
      score: 4,
      recommendation: 'HIRE',
    })
    assert.equal(code(early), 'INVALID_STATE')
    assert.equal(
      (
        await iv.patch(`${R}/interviews/${i.id}`, { location: 'Outra', expectedVersion: i.version })
      ).status(),
      403
    )
    ok(
      await iv.patch(`${R}/interviews/${i.id}`, { status: 'DONE', expectedVersion: i.version }),
      200
    )
    ok(
      await iv.post(`${R}/applications/${a.id}/evaluations`, {
        interviewId: i.id,
        score: 4,
        recommendation: 'HIRE',
        comments: 'Boa comunicação.',
      })
    )
    assert.equal(
      code(
        await iv.post(`${R}/applications/${a.id}/evaluations`, {
          interviewId: i.id,
          score: 5,
          recommendation: 'HIRE',
        })
      ),
      'ALREADY_EVALUATED'
    )
    assert.equal(
      (
        await iv.post(`${R}/applications/${a.id}/evaluations`, { score: 5, recommendation: 'HIRE' })
      ).status(),
      404
    )

    // Proposta: dentro da remuneração autorizada; uma em curso por candidatura.
    const out = await o.api.post(`${R}/applications/${a.id}/offers`, {
      salary: '300000',
      startDate: day(14),
    })
    assert.include(
      out.body().error.details.map((d: any) => d.code),
      'OUT_OF_RANGE'
    )
    const offer = ok(
      await o.api.post(`${R}/applications/${a.id}/offers`, {
        salary: '200000.5',
        startDate: day(14),
        expiresOn: day(7),
        conditions: 'Subsídio de transporte conforme política.',
      })
    )
    assert.equal(offer.salary, '200000.50')
    assert.equal(offer.currency, 'AOA')
    assert.equal(
      code(
        await o.api.post(`${R}/applications/${a.id}/offers`, {
          salary: '200000',
          startDate: day(14),
        })
      ),
      'OFFER_IN_PROGRESS'
    )
    let detail = ok(await o.api.get(`${R}/applications/${a.id}`), 200)
    assert.equal(detail.stage, 'OFFER')
    assert.equal(detail.averageScore, '4.00')
    assert.lengthOf(detail.evaluations, 1)

    let of = ok(
      await o.api.post(`${R}/offers/${offer.id}/submit`, { expectedVersion: offer.version }),
      200
    )
    assert.equal(
      code(
        await o.api.post(`${R}/offers/${offer.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: of.version,
        })
      ),
      'SEGREGATION'
    )
    of = ok(
      await ap.post(`${R}/offers/${offer.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: of.version,
      }),
      200
    )
    assert.equal(of.status, 'APPROVED')
    assert.equal(
      code(
        await o.api.post(`${R}/offers/${offer.id}/hire`, {
          code: 'C100',
          expectedVersion: of.version,
        })
      ),
      'INVALID_STATE'
    )
    of = ok(
      await o.api.post(`${R}/offers/${offer.id}/response`, {
        accepted: true,
        expectedVersion: of.version,
      }),
      200
    )
    assert.equal(of.status, 'ACCEPTED')

    // Contratação: colaborador com a colocação da vaga e o nome do candidato, checklist e vaga preenchida.
    const badList = await o.api.post(`${R}/offers/${offer.id}/hire`, {
      code: 'C100',
      expectedVersion: of.version,
      checklist: [{ category: 'XPTO', title: 'x' }],
    })
    assert.equal(badList.status(), 422)
    const hired = ok(
      await o.api.post(`${R}/offers/${offer.id}/hire`, {
        code: 'C100',
        workEmail: 'beatriz@empresa.ao',
        expectedVersion: of.version,
        checklist: [
          { category: 'DOCUMENTS', title: 'Cópia do BI e NIF' },
          {
            category: 'ACCOUNT',
            title: 'Criar conta de email',
            assigneeMembershipId: interviewer.memberId,
          },
          { category: 'EQUIPMENT', title: 'Entregar portátil', dueDate: day(14) },
        ],
      })
    )
    assert.equal(hired.offer.status, 'HIRED')
    const emp = ok(await o.api.get(`${R}/employees/${hired.employeeId}`), 200)
    assert.equal(emp.fullName, 'Beatriz Neto')
    assert.equal(emp.positionId, o.pA.id)
    assert.equal(emp.departmentId, o.dA.id)
    assert.equal(emp.hireDate, day(14))
    assert.equal(emp.personalEmail, 'beatriz.neto@exemplo.ao')
    assert.equal(emp.status, 'ACTIVE')
    detail = ok(await o.api.get(`${R}/applications/${a.id}`), 200)
    assert.equal(detail.stage, 'HIRED')
    assert.equal(detail.employeeId, hired.employeeId)
    assert.equal(ok(await o.api.get(`${R}/requisitions/${r.id}`), 200).status, 'FILLED')
    // Repetir a contratação não cria outro colaborador.
    assert.equal(
      (
        await o.api.post(`${R}/offers/${offer.id}/hire`, {
          code: 'C101',
          expectedVersion: hired.offer.version,
        })
      ).status(),
      409
    )
    const count = await db.connection('owner').rawQuery(`select count(*)::int as n from employees`)
    assert.equal(count.rows[0].n, 1)

    // Onboarding: o responsável conclui a sua tarefa, mas não a altera nem vê as outras sem permissão.
    const list = ok(await o.api.get(`${R}/employees/${hired.employeeId}/onboarding`), 200)
    assert.equal(list.total, 3)
    assert.equal(list.done, 0)
    assert.deepEqual(
      list.items.map((t: any) => t.category),
      ['DOCUMENTS', 'ACCOUNT', 'EQUIPMENT']
    )
    const task = list.items.find((t: any) => t.category === 'ACCOUNT')
    assert.equal(
      (
        await iv.patch(`${R}/onboarding-tasks/${task.id}`, {
          title: 'Outra',
          expectedVersion: task.version,
        })
      ).status(),
      403
    )
    const done = ok(
      await iv.patch(`${R}/onboarding-tasks/${task.id}`, {
        status: 'DONE',
        expectedVersion: task.version,
      }),
      200
    )
    assert.equal(done.status, 'DONE')
    assert.isNotNull(done.completedAt)
    assert.equal((await iv.get(`${R}/employees/${hired.employeeId}/onboarding`)).status(), 404)
    ok(
      await o.api.post(`${R}/employees/${hired.employeeId}/onboarding`, {
        category: 'ACCESS',
        title: 'Acesso ao ERP',
      })
    )
    assert.equal(ok(await o.api.get(`${R}/employees/${hired.employeeId}/onboarding`), 200).total, 4)

    // Auditoria do processo; os contactos do candidato não ficam na auditoria.
    const actions = await db.connection('owner')
      .rawQuery(`select action, coalesce(metadata::text, '') || coalesce(changes::text, '') as body
      from audit_events where action like 'hr.%'`)
    const names = actions.rows.map((x: any) => x.action)
    for (const action of [
      'hr.requisition.created',
      'hr.requisition.rejected',
      'hr.requisition.approved',
      'hr.candidate.created',
      'hr.interview.scheduled',
      'hr.evaluation.created',
      'hr.offer.approved',
      'hr.offer.accepted',
      'hr.offer.hired',
      'hr.application.hired',
      'hr.requisition.filled',
      'hr.employee.created',
      'hr.onboarding.task_updated',
    ])
      assert.include(names, action)
    const candidateAudit = actions.rows.filter((x: any) => x.action.startsWith('hr.candidate'))
    for (const row of candidateAudit) {
      assert.notInclude(row.body, 'beatriz.neto@exemplo.ao')
      assert.notInclude(row.body, '923 111 222')
    }
  })

  test('workflow de aprovação: vaga e proposta decididas no workflow; decisão directa recusada', async ({
    client,
    assert,
  }) => {
    const o = await structure(client)
    const approver = await memberWithRoles(client, o.s, [])
    const wf = async (c: string, subjectType: string) => {
      const w = ok(
        await o.api.post('/api/v1/approvals/workflows', {
          code: c,
          name: `Workflow ${c}`,
          subjectType,
          steps: [
            { name: 'Direcção', approverType: 'MEMBER', approverMembershipId: approver.memberId },
          ],
        })
      )
      return ok(
        await o.api.post(`/api/v1/approvals/workflows/${w.id}/publish`, {
          expectedVersion: w.version,
        }),
        200
      )
    }
    const wReq = await wf('VAGAS', 'job_requisition')
    const wOffer = await wf('PROPOSTAS', 'job_offer')
    const wManual = await wf('MANUAL', 'manual')

    // Só workflows publicados do tipo certo.
    const wrong = await o.api.put(`${R}/settings`, {
      requisitionWorkflowId: wManual.id,
      expectedVersion: 0,
    })
    assert.equal(wrong.status(), 422)
    let settings = ok(
      await o.api.put(`${R}/settings`, {
        requisitionWorkflowId: wReq.id,
        offerWorkflowId: wOffer.id,
        expectedVersion: 0,
      }),
      200
    )
    assert.equal(settings.version, 1)
    assert.equal(
      (await o.api.put(`${R}/settings`, { offerWorkflowId: null, expectedVersion: 0 })).status(),
      409
    )

    const decide = (requestId: string, decision: string) =>
      as(client, approver.session).post(`/api/v1/approvals/requests/${requestId}/decisions`, {
        decision,
        comment: decision === 'REJECT' ? 'Sem orçamento' : undefined,
      })

    // Vaga recusada no workflow volta a rascunho; submetida de novo e aprovada fica aberta.
    const r = ok(await o.api.post(`${R}/requisitions`, requisition(o)))
    let v = ok(
      await o.api.post(`${R}/requisitions/${r.id}/submit`, { expectedVersion: r.version }),
      200
    )
    assert.isNotNull(v.approvalRequestId)
    const tenantAdmin = await scopedMember(
      client,
      o.s,
      'aprova_rh',
      ['hr.recruitment.approve'],
      'TENANT'
    )
    assert.equal(
      code(
        await as(client, tenantAdmin.session).post(`${R}/requisitions/${r.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: v.version,
        })
      ),
      'USE_APPROVAL_WORKFLOW'
    )
    ;(await decide(v.approvalRequestId, 'REJECT')).assertStatus(200)
    v = ok(await o.api.get(`${R}/requisitions/${r.id}`), 200)
    assert.equal(v.status, 'DRAFT')
    assert.equal(v.rejectionReason, 'Recusada no workflow de aprovação.')
    assert.equal(v.approvalMode, 'WORKFLOW')
    v = ok(
      await o.api.post(`${R}/requisitions/${r.id}/submit`, { expectedVersion: v.version }),
      200
    )
    ;(await decide(v.approvalRequestId, 'APPROVE')).assertStatus(200)
    v = ok(await o.api.get(`${R}/requisitions/${r.id}`), 200)
    assert.equal(v.status, 'OPEN')

    // Proposta aprovada no workflow.
    const c = ok(
      await o.api.post(`${R}/candidates`, { fullName: 'Carlos Dias', email: 'carlos@exemplo.ao' })
    )
    const a = ok(await o.api.post(`${R}/applications`, { requisitionId: r.id, candidateId: c.id }))
    ok(
      await o.api.post(`${R}/applications/${a.id}/stage`, {
        stage: 'SCREENING',
        expectedVersion: a.version,
      }),
      200
    )
    const offer = ok(
      await o.api.post(`${R}/applications/${a.id}/offers`, { salary: '160000', startDate: day(10) })
    )
    const sub = ok(
      await o.api.post(`${R}/offers/${offer.id}/submit`, { expectedVersion: offer.version }),
      200
    )
    assert.isNotNull(sub.approvalRequestId)
    ;(await decide(sub.approvalRequestId, 'APPROVE')).assertStatus(200)
    const detail = ok(await o.api.get(`${R}/applications/${a.id}`), 200)
    assert.equal(detail.offers[0].status, 'APPROVED')
    assert.equal(detail.offerApprovalMode, 'WORKFLOW')

    // Recusar a candidatura cancela a proposta em curso.
    const rej = ok(
      await o.api.post(`${R}/applications/${a.id}/stage`, {
        stage: 'REJECTED',
        reason: 'Desistiu do processo',
        expectedVersion: detail.version,
      }),
      200
    )
    assert.equal(rej.stage, 'REJECTED')
    const after = ok(await o.api.get(`${R}/applications/${a.id}`), 200)
    assert.equal(after.offers[0].status, 'CANCELLED')
    settings = ok(await o.api.get(`${R}/settings`), 200)
    assert.equal(settings.requisitionWorkflowId, wReq.id)
  })

  test('âmbitos: recrutador por departamento, aprovador por entidade, contratar exige hr.manage', async ({
    client,
    assert,
  }) => {
    const o = await structure(client)
    const approverA = await scopedMember(
      client,
      o.s,
      'aprova_a',
      ['hr.recruitment.approve'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    const approverB = await scopedMember(
      client,
      o.s,
      'aprova_b',
      ['hr.recruitment.approve'],
      'LEGAL_ENTITY',
      o.leB.id
    )
    const recruiter = await scopedMember(
      client,
      o.s,
      'recrutador_a',
      ['hr.recruitment.read', 'hr.recruitment.manage'],
      'DEPARTMENT',
      o.dA.id
    )
    const rec = as(client, recruiter.session)

    // O recrutador cria vagas só no seu departamento.
    const outside = await rec.post(
      `${R}/requisitions`,
      requisition(o, {
        code: 'V-B',
        legalEntityId: o.leB.id,
        departmentId: o.dB.id,
        positionId: o.pB.id,
      })
    )
    assert.equal(code(outside), 'OUT_OF_SCOPE')
    const rA = ok(await rec.post(`${R}/requisitions`, requisition(o, { code: 'V-A' })))
    const subA = ok(
      await rec.post(`${R}/requisitions/${rA.id}/submit`, { expectedVersion: rA.version }),
      200
    )
    // O aprovador de outra entidade não vê a vaga; o da entidade aprova.
    assert.equal(
      (await as(client, approverB.session).get(`${R}/requisitions/${rA.id}`)).status(),
      404
    )
    ok(
      await as(client, approverA.session).post(`${R}/requisitions/${rA.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: subA.version,
      }),
      200
    )
    // Vaga da entidade B (do admin) não aparece ao recrutador.
    const rB = await openRequisition(client, o, approverB.session, {
      code: 'V-B',
      legalEntityId: o.leB.id,
      departmentId: o.dB.id,
      positionId: o.pB.id,
    })
    const list = ok(await rec.get(`${R}/requisitions`), 200)
    assert.deepEqual(
      list.map((x: any) => x.code),
      ['V-A']
    )
    assert.equal((await rec.get(`${R}/requisitions/${rB.id}`)).status(), 404)

    // Candidatos: o recrutador vê os seus e os das vagas que vê; não os de outras vagas.
    const cB = ok(
      await o.api.post(`${R}/candidates`, { fullName: 'Daniel B', email: 'daniel@exemplo.ao' })
    )
    ok(await o.api.post(`${R}/applications`, { requisitionId: rB.id, candidateId: cB.id }))
    const cA = ok(
      await rec.post(`${R}/candidates`, { fullName: 'Elisa A', email: 'elisa@exemplo.ao' })
    )
    assert.equal((await rec.get(`${R}/candidates/${cB.id}`)).status(), 404)
    assert.deepEqual(
      ok(await rec.get(`${R}/candidates`), 200).map((x: any) => x.fullName),
      ['Elisa A']
    )
    assert.equal(
      code(await rec.post(`${R}/applications`, { requisitionId: rB.id, candidateId: cA.id })),
      'VALIDATION_ERROR'
    )
    assert.equal(ok(await rec.get(`${R}/applications`), 200).length, 0)

    // Proposta aceite na vaga A; contratar exige hr.manage (criação da ficha): o recrutador não pode.
    const a = ok(await rec.post(`${R}/applications`, { requisitionId: rA.id, candidateId: cA.id }))
    ok(
      await rec.post(`${R}/applications/${a.id}/stage`, {
        stage: 'SCREENING',
        expectedVersion: a.version,
      }),
      200
    )
    const offer = ok(
      await rec.post(`${R}/applications/${a.id}/offers`, { salary: '200000', startDate: day(5) })
    )
    const sub = ok(
      await rec.post(`${R}/offers/${offer.id}/submit`, { expectedVersion: offer.version }),
      200
    )
    assert.equal(
      (
        await as(client, approverB.session).post(`${R}/offers/${offer.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: sub.version,
        })
      ).status(),
      404
    )
    const appr = ok(
      await as(client, approverA.session).post(`${R}/offers/${offer.id}/decision`, {
        decision: 'APPROVE',
        expectedVersion: sub.version,
      }),
      200
    )
    const acc = ok(
      await rec.post(`${R}/offers/${offer.id}/response`, {
        accepted: true,
        expectedVersion: appr.version,
      }),
      200
    )
    const noHr = await rec.post(`${R}/offers/${offer.id}/hire`, {
      code: 'C200',
      expectedVersion: acc.version,
    })
    assert.equal(noHr.status(), 403)
    assert.equal(code(noHr), 'OUT_OF_SCOPE')
    // Nada ficou a meio: a proposta continua aceite.
    assert.equal(ok(await rec.get(`${R}/applications/${a.id}`), 200).offers[0].status, 'ACCEPTED')
    ok(
      await o.api.post(`${R}/offers/${offer.id}/hire`, {
        code: 'C200',
        expectedVersion: acc.version,
      })
    )
    // Sem hr.sensitive o recrutador não teria copiado contactos; o admin tem, por isso copia.
    void signIn
  })

  test('concorrência: duas contratações para o último posto, só uma entra', async ({
    client,
    assert,
  }) => {
    const o = await structure(client)
    const approver = await scopedMember(
      client,
      o.s,
      'aprova_rh',
      ['hr.recruitment.approve'],
      'TENANT'
    )
    const r = await openRequisition(client, o, approver.session)
    const o1 = await acceptedOffer(client, o, approver.session, r.id, 'Fernando Um')
    const o2 = await acceptedOffer(client, o, approver.session, r.id, 'Gabriela Dois')
    const [h1, h2] = await Promise.all([
      o.api.post(`${R}/offers/${o1.id}/hire`, { code: 'C301', expectedVersion: o1.version }),
      o.api.post(`${R}/offers/${o2.id}/hire`, { code: 'C302', expectedVersion: o2.version }),
    ])
    const statuses = [h1.status(), h2.status()].sort()
    assert.deepEqual(statuses, [201, 409])
    const loser = h1.status() === 409 ? h1 : h2
    assert.include(['REQUISITION_NOT_OPEN', 'REQUISITION_FILLED'], code(loser))
    const n = await db.connection('owner').rawQuery(`select count(*)::int as n from employees`)
    assert.equal(n.rows[0].n, 1)
    assert.equal(ok(await o.api.get(`${R}/requisitions/${r.id}`), 200).hiredCount, 1)
  })
})
