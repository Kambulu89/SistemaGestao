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
const T = `${H}/training`
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

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000999',
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
  const emp = async (c: string, d: any) =>
    ok(
      await api.post(`${H}/employees`, {
        code: c,
        fullName: `Colaborador ${c}`,
        legalEntityId: le.id,
        departmentId: d.id,
        hireDate: '2026-01-05',
      })
    )
  const e1 = await emp('C1', d1)
  const e2 = await emp('C2', d1)
  const e3 = await emp('C3', d2)
  const safety = ok(
    await api.post(`${T}/competencies`, { code: 'SEG', name: 'Segurança no trabalho' })
  )
  const excel = ok(await api.post(`${T}/competencies`, { code: 'XLS', name: 'Folha de cálculo' }))
  const course = ok(
    await api.post(`${T}/courses`, {
      code: 'SST',
      name: 'Segurança e saúde no trabalho',
      mode: 'EXTERNAL',
      provider: 'Centro de Formação X',
      durationHours: '16',
      assessed: true,
      issuesCertificate: true,
      certificateValidityMonths: 24,
      competencies: [
        { competencyId: safety.id, level: 3 },
        { competencyId: excel.id, level: 1 },
      ],
    })
  )
  return { tenant, admin, s, api, le, d1, d2, e1, e2, e3, safety, excel, course }
}

test.group('RH | formação (7.10)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('catálogo: competências e cursos validados; só quem configura altera', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    assert.equal(
      code(await o.api.post(`${T}/competencies`, { code: 'seg', name: 'Outra' })),
      'CODE_TAKEN'
    )
    assert.lengthOf(o.course.competencies, 2)
    const bad = await o.api.post(`${T}/courses`, {
      code: 'X',
      name: 'Curso X',
      mode: 'PRESENCIAL',
      durationHours: '0',
      certificateValidityMonths: 12,
      competencies: [
        { competencyId: o.safety.id, level: 6 },
        { competencyId: o.safety.id, level: 2 },
      ],
    })
    assert.includeMembers(details(bad), ['INVALID', 'NO_CERTIFICATE', 'DUPLICATE'])
    ok(await o.api.patch(`${T}/competencies/${o.excel.id}`, { status: 'INACTIVE' }), 200)
    assert.include(
      details(
        await o.api.patch(`${T}/courses/${o.course.id}`, {
          competencies: [{ competencyId: o.excel.id, level: 2 }],
        })
      ),
      'INVALID'
    )
    const reader = await roleMember(client, o.s, 'leitor', ['hr.training.read'], 'TENANT')
    const R = as(client, reader.session)
    assert.lengthOf(ok(await R.get(`${T}/courses`), 200), 1)
    assert.equal((await R.post(`${T}/competencies`, { code: 'Z', name: 'Zzz' })).status(), 403)
    const nobody = await roleMember(client, o.s, 'nada', ['hr.read'], 'TENANT')
    assert.equal(code(await as(client, nobody.session).get(`${T}/courses`)), 'FORBIDDEN')
  })

  test('sessão: inscrições com capacidade, resultados, conclusão com competências, certificados e custos', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    assert.include(
      details(
        await o.api.post(`${T}/sessions`, {
          courseId: o.course.id,
          startsOn: '2026-10-02',
          endsOn: '2026-10-01',
          costTotal: '90000',
        })
      ),
      'RANGE'
    )
    let s = ok(
      await o.api.post(`${T}/sessions`, {
        courseId: o.course.id,
        startsOn: '2026-10-01',
        endsOn: '2026-10-02',
        location: 'Luanda',
        capacity: 2,
        currency: 'AOA',
        costTotal: '90000',
      })
    )
    assert.match(s.code, /^FOR-2026-0001$/)
    const enroll = (ids: string[]) =>
      o.api.post(`${T}/sessions/${s.id}/enrollments`, {
        employeeIds: ids,
        expectedVersion: s.version,
      })
    assert.include(details(await enroll([o.e1.id, o.e2.id, o.e3.id])), 'CAPACITY')
    s = ok(await enroll([o.e1.id, o.e2.id]), 200)
    assert.equal(s.participants, 2)
    assert.equal(s.costPerHead, '45000.00')
    // Mais um lugar: alarga-se a capacidade? Não há edição; nova inscrição recusada.
    assert.include(details(await enroll([o.e3.id])), 'CAPACITY')

    const result = (en: any, body: Record<string, unknown>) =>
      o.api.post(`${T}/enrollments/${en.id}/result`, { ...body, expectedVersion: en.version })
    const [a, b] = s.enrollments
    assert.include(details(await result(a, { status: 'ATTENDED' })), 'ASSESSED')
    assert.include(details(await result(a, { status: 'PASSED', score: '120' })), 'INVALID')
    s = ok(await result(a, { status: 'PASSED', score: '82.5', hoursAttended: '16' }), 200)
    // Falta o resultado do segundo: não se conclui.
    assert.include(
      details(await o.api.post(`${T}/sessions/${s.id}/complete`, { expectedVersion: s.version })),
      'NO_RESULT'
    )
    s = ok(
      await result(
        s.enrollments.find((x: any) => x.id === b.id),
        { status: 'FAILED', score: '40' }
      ),
      200
    )
    s = ok(await o.api.post(`${T}/sessions/${s.id}/complete`, { expectedVersion: s.version }), 200)
    assert.equal(s.status, 'COMPLETED')
    assert.isFalse(s.access.manage)
    assert.equal(
      code(await o.api.post(`${T}/sessions/${s.id}/complete`, { expectedVersion: s.version })),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update training_enrollments set status = 'PASSED' where session_id = ?`, [
        s.id,
      ])
    )

    // Só o aprovado recebe competências e certificado (com validade de 24 meses).
    const passed = ok(await o.api.get(`${H}/employees/${o.e1.id}/training`), 200)
    assert.deepEqual(passed.competencies.map((c: any) => [c.code, c.level, c.source]).sort(), [
      ['SEG', 3, 'TRAINING'],
      ['XLS', 1, 'TRAINING'],
    ])
    assert.lengthOf(passed.certificates, 1)
    assert.deepEqual(
      [
        passed.certificates[0].number,
        passed.certificates[0].issuedOn,
        passed.certificates[0].expiresOn,
      ],
      [`${s.code}-001`, '2026-10-02', '2028-10-02']
    )
    const failed = ok(await o.api.get(`${H}/employees/${o.e2.id}/training`), 200)
    assert.lengthOf(failed.competencies, 0)
    assert.lengthOf(failed.certificates, 0)
    assert.equal(failed.enrollments[0].status, 'FAILED')

    // Avaliação posterior: novo registo; o histórico mantém-se.
    ok(
      await o.api.post(`${H}/employees/${o.e1.id}/competencies`, {
        competencyId: o.safety.id,
        level: 4,
        acquiredOn: '2026-11-01',
        notes: 'Avaliação anual',
      })
    )
    const after = ok(await o.api.get(`${H}/employees/${o.e1.id}/training`), 200)
    assert.equal(after.competencies.find((c: any) => c.code === 'SEG').level, 4)
    assert.lengthOf(
      after.history.filter((h: any) => h.name === 'Segurança no trabalho'),
      2
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from employee_competencies where employee_id = ?`, [o.e1.id])
    )
    // Certificado externo, já expirado.
    assert.include(
      details(
        await o.api.post(`${H}/employees/${o.e2.id}/certificates`, {
          name: 'Primeiros socorros',
          issuer: 'Cruz Vermelha',
          issuedOn: '2024-01-10',
          expiresOn: '2023-01-10',
        })
      ),
      'RANGE'
    )
    ok(
      await o.api.post(`${H}/employees/${o.e2.id}/certificates`, {
        name: 'Primeiros socorros',
        issuer: 'Cruz Vermelha',
        issuedOn: '2024-01-10',
        expiresOn: '2025-01-10',
      })
    )
    const c2 = ok(await o.api.get(`${H}/employees/${o.e2.id}/training`), 200)
    assert.isTrue(c2.certificates[0].expired)

    // Custos do ano: 90 000 repartidos por dois participantes.
    const costs = ok(await o.api.get(`${T}/costs?year=2026`), 200)
    assert.deepEqual(
      costs.byCourse.map((c: any) => [c.code, c.participants, c.hours, c.cost]),
      [['SST', 2, '32.00', '90000.00']]
    )
    assert.deepEqual(
      costs.byDepartment.map((d: any) => [d.department, d.cost]),
      [['Dep D1', '90000.00']]
    )
  })

  test('âmbito: gestor de outro departamento não inscreve nem vê; o próprio vê a sua formação', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const s = ok(
      await o.api.post(`${T}/sessions`, {
        courseId: o.course.id,
        startsOn: '2026-12-01',
        endsOn: '2026-12-02',
      })
    )
    const m2 = await roleMember(
      client,
      o.s,
      'gere_d2',
      ['hr.training.manage'],
      'DEPARTMENT',
      o.d2.id
    )
    const M2 = as(client, m2.session)
    assert.include(
      details(
        await M2.post(`${T}/sessions/${s.id}/enrollments`, {
          employeeIds: [o.e1.id],
          expectedVersion: s.version,
        })
      ),
      'OUT_OF_SCOPE'
    )
    const after = ok(
      await M2.post(`${T}/sessions/${s.id}/enrollments`, {
        employeeIds: [o.e3.id],
        expectedVersion: s.version,
      }),
      200
    )
    assert.lengthOf(after.enrollments, 1)
    ok(
      await o.api.post(`${T}/sessions/${s.id}/enrollments`, {
        employeeIds: [o.e1.id],
        expectedVersion: after.version,
      }),
      200
    )
    // O gestor de D2 só vê a inscrição do seu departamento.
    assert.lengthOf(ok(await M2.get(`${T}/sessions/${s.id}`), 200).enrollments, 1)
    assert.equal((await M2.get(`${H}/employees/${o.e1.id}/training`)).status(), 404)
    // Resultados antes de começar: recusados.
    const en = ok(await o.api.get(`${T}/sessions/${s.id}`), 200).enrollments[0]
    assert.include(
      details(
        await o.api.post(`${T}/enrollments/${en.id}/result`, {
          status: 'PASSED',
          expectedVersion: en.version,
        })
      ),
      'NOT_STARTED'
    )
    const self = await roleMember(client, o.s, 'proprio', ['hr.training.read'], 'OWN')
    ok(
      await o.api.patch(`${H}/employees/${o.e1.id}`, {
        membershipId: self.memberId,
        expectedVersion: o.e1.version,
      }),
      200
    )
    const S = as(client, self.session)
    const mine = ok(await S.get(`${H}/employees/${o.e1.id}/training`), 200)
    assert.isFalse(mine.access.manage)
    assert.lengthOf(mine.enrollments, 1)
    assert.equal((await S.get(`${H}/employees/${o.e2.id}/training`)).status(), 404)
    assert.equal(
      code(
        await S.post(`${H}/employees/${o.e1.id}/certificates`, {
          name: 'X',
          issuer: 'Y',
          issuedOn: '2026-01-01',
        })
      ),
      'OUT_OF_SCOPE'
    )
  })
})
