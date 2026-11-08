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
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)

/** Entidade A com departamentos D1 (cargos P1, P2) e D2 (cargo P3); um colaborador admitido em 2026-01-05. */
async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000501',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const dept = (c: string, name: string) =>
    api.post('/api/v1/organization/departments', { code: c, name, legalEntityId: le.id })
  const d1 = ok(await dept('D1', 'Finanças'))
  const d2 = ok(await dept('D2', 'Operações'))
  const pos = (c: string, name: string, departmentId: string) =>
    api.post('/api/v1/organization/positions', { code: c, name, departmentId })
  const p1 = ok(await pos('P1', 'Técnico', d1.id))
  const p2 = ok(await pos('P2', 'Técnico sénior', d1.id))
  const p3 = ok(await pos('P3', 'Coordenador', d2.id))
  const e = ok(
    await api.post(`${H}/employees`, {
      code: 'C001',
      fullName: 'Ana Silva',
      legalEntityId: le.id,
      departmentId: d1.id,
      positionId: p1.id,
      hireDate: '2026-01-05',
    })
  )
  return { s, api, le, d1, d2, p1, p2, p3, e }
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

const contract = (extra: Record<string, unknown> = {}) => ({
  code: 'CT-001',
  contractType: 'FIXED_TERM',
  startDate: '2026-01-05',
  endDate: '2026-07-04',
  probationEndDate: '2026-02-04',
  weeklyHours: '40',
  workSchedule: 'Segunda a sexta, 08:00–17:00',
  currency: 'aoa',
  baseSalary: '250000',
  ...extra,
})

test.group('RH | contratos e carreira (7.3)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('contrato: rascunho, activação, adendas sem retroactividade, renovação, suspensão e termo', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const C = `${H}/employees/${o.e.id}/contracts`
    // Validação: termo obrigatório a termo certo, não antes da admissão, período experimental dentro do contrato.
    assert.include(details(await o.api.post(C, contract({ endDate: null }))), 'REQUIRED')
    assert.include(
      details(await o.api.post(C, contract({ startDate: '2026-01-01' }))),
      'BEFORE_HIRE'
    )
    assert.include(
      details(await o.api.post(C, contract({ probationEndDate: '2026-08-01' }))),
      'AFTER_END'
    )
    assert.include(details(await o.api.post(C, contract({ weeklyHours: '200' }))), 'INVALID')
    const c = ok(await o.api.post(C, contract()))
    assert.equal(c.status, 'DRAFT')
    assert.equal(c.baseSalary, '250000.00')
    assert.equal(c.weeklyHours, '40.00')
    assert.equal(c.currency, 'AOA')
    assert.equal(code(await o.api.post(C, contract())), 'CODE_TAKEN')
    let v = ok(
      await o.api.patch(`${H}/contracts/${c.id}`, {
        notes: 'Primeiro contrato',
        expectedVersion: c.version,
      }),
      200
    )

    // Activar; depois só por adenda.
    v = ok(await o.api.post(`${H}/contracts/${c.id}/activate`, { expectedVersion: v.version }), 200)
    assert.equal(v.status, 'ACTIVE')
    assert.equal(
      code(
        await o.api.patch(`${H}/contracts/${c.id}`, { baseSalary: '1', expectedVersion: v.version })
      ),
      'INVALID_STATE'
    )
    // Outro contrato em vigor ao mesmo tempo: recusado.
    const other = ok(await o.api.post(C, contract({ code: 'CT-002', startDate: '2026-02-01' })))
    assert.equal(
      code(
        await o.api.post(`${H}/contracts/${other.id}/activate`, { expectedVersion: other.version })
      ),
      'CONTRACT_OPEN'
    )
    ok(
      await o.api.post(`${H}/contracts/${other.id}/cancel`, { expectedVersion: other.version }),
      200
    )

    // Adenda de remuneração e horas; não pode ser anterior à última.
    v = ok(
      await o.api.post(`${H}/contracts/${c.id}/amendments`, {
        kind: 'CHANGE',
        effectiveDate: '2026-03-01',
        baseSalary: '300000',
        weeklyHours: '37.5',
        reason: 'Revisão salarial anual',
        expectedVersion: v.version,
      })
    )
    assert.equal(v.currentTerms.baseSalary, '300000.00')
    assert.equal(v.currentTerms.weeklyHours, '37.50')
    assert.equal(v.baseSalary, '250000.00')
    const retro = await o.api.post(`${H}/contracts/${c.id}/amendments`, {
      kind: 'CHANGE',
      effectiveDate: '2026-02-01',
      baseSalary: '1',
      reason: 'Correcção',
      expectedVersion: v.version,
    })
    assert.include(details(retro), 'NOT_RETROACTIVE')
    assert.include(
      details(
        await o.api.post(`${H}/contracts/${c.id}/amendments`, {
          kind: 'CHANGE',
          effectiveDate: '2026-04-01',
          reason: 'Sem alterações',
          expectedVersion: v.version,
        })
      ),
      'NO_CHANGE'
    )
    // Renovação: tem de estender o termo.
    assert.include(
      details(
        await o.api.post(`${H}/contracts/${c.id}/amendments`, {
          kind: 'RENEWAL',
          effectiveDate: '2026-07-01',
          endDate: '2026-06-30',
          reason: 'Renovação',
          expectedVersion: v.version,
        })
      ),
      'NOT_EXTENDED'
    )
    v = ok(
      await o.api.post(`${H}/contracts/${c.id}/amendments`, {
        kind: 'RENEWAL',
        effectiveDate: '2026-07-01',
        endDate: '2027-01-04',
        reason: 'Renovação por seis meses',
        expectedVersion: v.version,
      })
    )
    assert.equal(v.renewalCount, 1)
    assert.equal(v.currentTerms.endDate, '2027-01-04')
    assert.equal(v.endDate, '2026-07-04')

    // Suspensão exige motivo; retoma não antes da suspensão.
    assert.include(
      details(
        await o.api.post(`${H}/contracts/${c.id}/suspend`, {
          date: '2026-08-01',
          expectedVersion: v.version,
        })
      ),
      'REQUIRED'
    )
    v = ok(
      await o.api.post(`${H}/contracts/${c.id}/suspend`, {
        date: '2026-08-01',
        reason: 'Licença sem vencimento',
        expectedVersion: v.version,
      }),
      200
    )
    assert.equal(v.status, 'SUSPENDED')
    assert.equal(v.suspendedFrom, '2026-08-01')
    assert.include(
      details(
        await o.api.post(`${H}/contracts/${c.id}/resume`, {
          date: '2026-07-15',
          expectedVersion: v.version,
        })
      ),
      'BEFORE_SUSPENSION'
    )
    v = ok(
      await o.api.post(`${H}/contracts/${c.id}/resume`, {
        date: '2026-09-01',
        expectedVersion: v.version,
      }),
      200
    )
    assert.equal(v.status, 'ACTIVE')
    v = ok(
      await o.api.post(`${H}/contracts/${c.id}/terminate`, {
        date: '2026-10-31',
        reason: 'Acordo entre as partes',
        expectedVersion: v.version,
      }),
      200
    )
    assert.equal(v.status, 'ENDED')
    assert.equal(v.terminationDate, '2026-10-31')

    // Novo contrato: não pode sobrepor-se ao anterior.
    const next = ok(
      await o.api.post(
        C,
        contract({
          code: 'CT-003',
          contractType: 'PERMANENT',
          endDate: null,
          startDate: '2026-10-15',
          probationEndDate: null,
        })
      )
    )
    assert.equal(
      code(
        await o.api.post(`${H}/contracts/${next.id}/activate`, { expectedVersion: next.version })
      ),
      'CONTRACT_OVERLAP'
    )
    const n2 = ok(
      await o.api.patch(`${H}/contracts/${next.id}`, {
        startDate: '2026-11-01',
        expectedVersion: next.version,
      }),
      200
    )
    ok(await o.api.post(`${H}/contracts/${next.id}/activate`, { expectedVersion: n2.version }), 200)
    // Contrato sem termo não aceita data de termo por adenda.
    const n3 = ok(await o.api.get(`${H}/contracts/${next.id}`), 200)
    assert.include(
      details(
        await o.api.post(`${H}/contracts/${next.id}/amendments`, {
          kind: 'CHANGE',
          effectiveDate: '2026-11-01',
          endDate: '2027-11-01',
          reason: 'Termo',
          expectedVersion: n3.version,
        })
      ),
      'PERMANENT'
    )

    // Histórico e lista.
    const detail = ok(await o.api.get(`${H}/contracts/${c.id}`), 200)
    assert.deepEqual(
      detail.events.map((e: any) => e.kind),
      ['ACTIVATED', 'AMENDED', 'RENEWED', 'SUSPENDED', 'RESUMED', 'TERMINATED']
    )
    assert.lengthOf(detail.amendments, 2)
    const list = ok(await o.api.get(C), 200)
    assert.deepEqual(
      list.items.map((x: any) => x.code),
      ['CT-003', 'CT-002', 'CT-001']
    )
    // A remuneração não fica na auditoria.
    const ev = await db
      .connection('owner')
      .rawQuery(`select changes::text as c from audit_events where action like 'hr.contract.%'`)
    const text = ev.rows.map((r: any) => r.c ?? '').join(' ')
    assert.notInclude(text, '250000')
    assert.notInclude(text, '300000')
    assert.include(text, '[RESERVADO]')
  })

  test('âmbitos: contratos exigem hr.contracts.*; o próprio vê o seu com âmbito OWN', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const c = ok(await o.api.post(`${H}/employees/${o.e.id}/contracts`, contract()))
    // Quem só lê fichas não vê contratos.
    const reader = await scopedMember(client, o.s, 'leitor', ['hr.read'], 'TENANT')
    const R = as(client, reader.session)
    assert.equal((await R.get(`${H}/employees/${o.e.id}/contracts`)).status(), 404)
    assert.equal((await R.get(`${H}/contracts/${c.id}`)).status(), 404)
    // Quem vê contratos mas não os gere: lê, não altera.
    const cRead = await scopedMember(
      client,
      o.s,
      'le_contratos',
      ['hr.contracts.read'],
      'DEPARTMENT',
      o.d1.id
    )
    const CR = as(client, cRead.session)
    assert.equal(ok(await CR.get(`${H}/contracts/${c.id}`), 200).access.manage, false)
    assert.equal(
      code(await CR.post(`${H}/contracts/${c.id}/activate`, { expectedVersion: c.version })),
      'OUT_OF_SCOPE'
    )
    // Gestor de contratos de outro departamento não vê.
    const other = await scopedMember(
      client,
      o.s,
      'gere_d2',
      ['hr.contracts.manage'],
      'DEPARTMENT',
      o.d2.id
    )
    assert.equal((await as(client, other.session).get(`${H}/contracts/${c.id}`)).status(), 404)
    // O próprio, com âmbito OWN.
    const self = await scopedMember(client, o.s, 'proprio', ['hr.contracts.read'], 'OWN')
    ok(
      await o.api.patch(`${H}/employees/${o.e.id}`, {
        membershipId: self.memberId,
        expectedVersion: o.e.version,
      }),
      200
    )
    const mine = ok(await as(client, self.session).get(`${H}/employees/${o.e.id}/contracts`), 200)
    assert.lengthOf(mine.items, 1)
    assert.isFalse(mine.canManage)
  })

  test('carreira: histórico com vigência, transferência, promoção, colocação só por movimento', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const A = `${H}/employees/${o.e.id}/assignments`
    let list = ok(await o.api.get(A), 200)
    assert.lengthOf(list.items, 1)
    assert.equal(list.items[0].kind, 'HIRE')
    assert.equal(list.items[0].validFrom, '2026-01-05')
    assert.isNull(list.items[0].validTo)

    // A ficha já não muda a colocação.
    const patch = await o.api.patch(`${H}/employees/${o.e.id}`, {
      departmentId: o.d2.id,
      positionId: null,
      expectedVersion: o.e.version,
    })
    assert.include(details(patch), 'USE_MOVEMENT')

    const move = (body: Record<string, unknown>, version: number) =>
      o.api.post(A, { reason: 'Reorganização da área', expectedVersion: version, ...body })
    assert.include(
      details(
        await move(
          { kind: 'TRANSFER', effectiveDate: day(5), departmentId: o.d2.id, positionId: o.p3.id },
          1
        )
      ),
      'FUTURE_DATE'
    )
    assert.include(
      details(
        await move(
          {
            kind: 'TRANSFER',
            effectiveDate: '2026-01-05',
            departmentId: o.d2.id,
            positionId: o.p3.id,
          },
          1
        )
      ),
      'NOT_AFTER_CURRENT'
    )
    assert.include(
      details(
        await move(
          {
            kind: 'PROMOTION',
            effectiveDate: '2026-03-01',
            costCenterId: null,
            managerId: null,
            departmentId: o.d1.id,
          },
          1
        )
      ),
      'NO_CHANGE'
    )
    assert.include(
      details(
        await move({ kind: 'TRANSFER', effectiveDate: '2026-03-01', departmentId: o.d2.id }, 1)
      ),
      'OTHER_DEPARTMENT'
    )
    assert.include(
      details(
        await move({ kind: 'TRANSFER', effectiveDate: '2026-03-01', legalEntityId: o.d2.id }, 1)
      ),
      'USE_NEW_CONTRACT'
    )
    assert.equal(
      (
        await move(
          {
            kind: 'TRANSFER',
            effectiveDate: '2026-03-01',
            departmentId: o.d2.id,
            positionId: o.p3.id,
          },
          9
        )
      ).status(),
      409
    )

    // Promoção no mesmo departamento.
    const promo = ok(
      await move({ kind: 'PROMOTION', effectiveDate: '2026-04-01', positionId: o.p2.id }, 1)
    )
    assert.equal(promo.items[0].kind, 'PROMOTION')
    assert.equal(promo.items[1].validTo, '2026-03-31')
    assert.include(
      details(
        await move(
          {
            kind: 'PROMOTION',
            effectiveDate: '2026-05-01',
            departmentId: o.d1.id,
            managerId: null,
            costCenterId: null,
            branchId: null,
          },
          promo.employeeVersion
        )
      ),
      'NO_CHANGE'
    )
    assert.include(
      details(
        await move(
          { kind: 'PROMOTION', effectiveDate: '2026-05-01', positionId: o.p2.id, managerId: null },
          promo.employeeVersion
        )
      ),
      'NO_CHANGE'
    )
    // Transferência para outro departamento e cargo.
    const t = ok(
      await move(
        {
          kind: 'TRANSFER',
          effectiveDate: '2026-06-01',
          departmentId: o.d2.id,
          positionId: o.p3.id,
        },
        promo.employeeVersion
      )
    )
    assert.deepEqual(
      t.items.map((x: any) => [x.kind, x.validFrom, x.validTo, x.positionName]),
      [
        ['TRANSFER', '2026-06-01', null, 'Coordenador'],
        ['PROMOTION', '2026-04-01', '2026-05-31', 'Técnico sénior'],
        ['HIRE', '2026-01-05', '2026-03-31', 'Técnico'],
      ]
    )
    const e = ok(await o.api.get(`${H}/employees/${o.e.id}`), 200)
    assert.equal(e.departmentId, o.d2.id)
    assert.equal(e.positionId, o.p3.id)
    assert.equal(e.version, t.employeeVersion)

    // Superior: sem ciclos também por movimento.
    const boss = ok(
      await o.api.post(`${H}/employees`, {
        code: 'C002',
        fullName: 'Bruno Costa',
        legalEntityId: o.le.id,
        departmentId: o.d2.id,
        managerId: o.e.id,
        hireDate: '2026-02-01',
      })
    )
    assert.include(
      details(
        await move({ kind: 'CHANGE', effectiveDate: '2026-07-01', managerId: boss.id }, e.version)
      ),
      'CYCLE'
    )

    // Colaborador anterior ao 7.3 (sem histórico): o primeiro movimento abre o período de admissão.
    await db
      .connection('owner')
      .rawQuery(`delete from employment_assignments where employee_id = ?`, [boss.id])
    const b = ok(await o.api.get(`${H}/employees/${boss.id}`), 200)
    const legacy = ok(
      await o.api.post(`${H}/employees/${boss.id}/assignments`, {
        kind: 'CHANGE',
        effectiveDate: '2026-05-01',
        managerId: null,
        reason: 'Passa a reportar à direcção',
        expectedVersion: b.version,
      })
    )
    assert.deepEqual(
      legacy.items.map((x: any) => [x.kind, x.validFrom, x.validTo]),
      [
        ['CHANGE', '2026-05-01', null],
        ['HIRE', '2026-02-01', '2026-04-30'],
      ]
    )
    // Quem só lê não movimenta.
    const reader = await scopedMember(client, o.s, 'leitor', ['hr.read'], 'TENANT')
    assert.equal(
      code(
        await as(client, reader.session).post(A, {
          kind: 'CHANGE',
          effectiveDate: '2026-08-01',
          managerId: null,
          reason: 'x y z',
          expectedVersion: e.version,
        })
      ),
      'OUT_OF_SCOPE'
    )
    const audits = await db
      .connection('owner')
      .rawQuery(
        `select action from audit_events where action in ('hr.employee.promotion','hr.employee.transfer')`
      )
    assert.lengthOf(audits.rows, 2)
  })
})
