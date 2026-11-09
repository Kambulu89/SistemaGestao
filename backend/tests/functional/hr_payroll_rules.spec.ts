import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { cleanDatabase, as, signIn, tenantWithAdmin } from '#tests/support/fixtures'

const H = '/api/v1/hr'
const P = `${H}/payroll`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)

/** Valores de TESTE (não são a tabela oficial). */
const BASE = {
  name: 'Regras de teste',
  currency: 'AOA',
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
}
const CASE = {
  description: 'Salário de 200 000',
  source: 'Exemplo de teste do mecanismo',
  baseSalary: '200000',
  expectedInssEmployee: '6000',
  expectedIrt: '9400',
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  return as(client, s)
}

test.group('RH | IRT/INSS: casos de teste, confirmação e validade (7.8)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('casos com fonte obrigatória; sem casos não se confirma; a edição apaga a confirmação', async ({
    client,
    assert,
  }) => {
    const api = await setup(client)
    const bad = await api.post(`${P}/rule-sets`, {
      ...BASE,
      code: 'R1',
      validFrom: '2026-01-01',
      testCases: [{ description: 'x', source: '', baseSalary: 'abc', expectedIrt: '1' }],
    })
    assert.equal(bad.status(), 422)
    assert.includeMembers(details(bad), ['LENGTH', 'INVALID_AMOUNT', 'REQUIRED'])
    const empty = ok(
      await api.post(`${P}/rule-sets`, { ...BASE, code: 'R1', validFrom: '2026-01-01' })
    )
    assert.equal(
      code(
        await api.post(`${P}/rule-sets/${empty.id}/confirm`, {
          note: 'Conferido',
          expectedVersion: empty.version,
        })
      ),
      'NO_TEST_CASES'
    )
    let r = ok(
      await api.patch(`${P}/rule-sets/${empty.id}`, {
        testCases: [CASE, { ...CASE, description: 'Errado', expectedIrt: '9500' }],
        expectedVersion: empty.version,
      }),
      200
    )
    const v = ok(await api.post(`${P}/rule-sets/${r.id}/verify`), 200)
    assert.equal(v.total, 2)
    assert.equal(v.passed, 1)
    assert.deepEqual(v.results[1].mismatches, [
      { field: 'irt', expected: '9500.00', actual: '9400.00' },
    ])
    assert.equal(
      code(
        await api.post(`${P}/rule-sets/${r.id}/confirm`, {
          note: 'Conferido',
          expectedVersion: r.version,
        })
      ),
      'CASES_FAILING'
    )
    r = ok(
      await api.patch(`${P}/rule-sets/${r.id}`, {
        testCases: [CASE],
        expectedVersion: r.version,
      }),
      200
    )
    assert.include(
      details(
        await api.post(`${P}/rule-sets/${r.id}/confirm`, { note: '  ', expectedVersion: r.version })
      ),
      'REQUIRED'
    )
    r = ok(
      await api.post(`${P}/rule-sets/${r.id}/confirm`, {
        note: 'Conferido com o diploma publicado',
        expectedVersion: r.version,
      }),
      200
    )
    assert.equal(r.confirmationNote, 'Conferido com o diploma publicado')
    assert.isNotNull(r.confirmedBy)
    // Mudar o que quer que seja apaga a confirmação.
    r = ok(
      await api.patch(`${P}/rule-sets/${r.id}`, { name: 'Outro nome', expectedVersion: r.version }),
      200
    )
    assert.isNull(r.confirmedAt)
    assert.equal(
      code(await api.post(`${P}/rule-sets/${r.id}/publish`, { expectedVersion: r.version })),
      'NOT_CONFIRMED'
    )
    r = ok(
      await api.post(`${P}/rule-sets/${r.id}/confirm`, {
        note: 'Conferido de novo',
        expectedVersion: r.version,
      }),
      200
    )
    r = ok(await api.post(`${P}/rule-sets/${r.id}/publish`, { expectedVersion: r.version }), 200)
    // Publicados, os casos ficam como estavam.
    await assert.rejects(() =>
      owner().rawQuery(
        `update payroll_rule_test_cases set expected_irt = 1 where rule_set_id = ?`,
        [r.id]
      )
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from payroll_rule_test_cases where rule_set_id = ?`, [r.id])
    )
    const events = await owner().rawQuery(
      `select action from audit_events where entity_type = 'payroll_rule_set' and entity_id = ?`,
      [r.id]
    )
    assert.includeMembers(
      events.rows.map((x: any) => x.action),
      ['hr.payroll.rules_created', 'hr.payroll.rules_confirmed', 'hr.payroll.rules_published']
    )
  })

  test('simulador: recibo de um exemplo com as regras, sem gravar', async ({ client, assert }) => {
    const api = await setup(client)
    const r = ok(await api.post(`${P}/rule-sets`, { ...BASE, code: 'R1', validFrom: '2026-01-01' }))
    const sim = ok(
      await api.post(`${P}/rule-sets/${r.id}/simulate`, {
        baseSalary: '150000',
        allowancesIrtOnly: '20000',
        allowancesExempt: '1000,50',
      }),
      200
    )
    // INSS 3% de 150 000 = 4 500; base IRT 150 000 + 20 000 − 4 500 = 165 500 → 6 550
    assert.equal(sim.totals.gross, '171000.50')
    assert.equal(sim.totals.inssEmployee, '4500.00')
    assert.equal(sim.totals.irtBase, '165500.00')
    assert.equal(sim.totals.irt, '6550.00')
    assert.equal(sim.totals.net, '159950.50')
    assert.include(
      details(await api.post(`${P}/rule-sets/${r.id}/simulate`, { baseSalary: 'x' })),
      'INVALID_AMOUNT'
    )
  })

  test('validade: depois do fim, sem versão seguinte, o processamento não usa regras antigas', async ({
    client,
    assert,
  }) => {
    const api = await setup(client)
    const le = ok(
      await api.post('/api/v1/organization/legal-entities', {
        code: 'LEA',
        legalName: 'Entidade A, Lda.',
        taxId: '5000000888',
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    )
    assert.include(
      details(
        await api.post(`${P}/rule-sets`, {
          ...BASE,
          code: 'R0',
          validFrom: '2026-06-01',
          validTo: '2026-05-31',
        })
      ),
      'RANGE'
    )
    const rs = ok(
      await api.post(`${P}/rule-sets`, {
        ...BASE,
        code: 'R1',
        validFrom: '2026-01-01',
        validTo: '2026-06-30',
        testCases: [CASE],
      })
    )
    assert.equal(rs.validTo, '2026-06-30')
    const c = ok(
      await api.post(`${P}/rule-sets/${rs.id}/confirm`, {
        note: 'Conferido',
        expectedVersion: rs.version,
      }),
      200
    )
    ok(await api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: c.version }), 200)
    const e = ok(
      await api.post(`${H}/employees`, {
        code: 'C1',
        fullName: 'Colaborador 1',
        legalEntityId: le.id,
        hireDate: '2026-01-05',
      })
    )
    const ct = ok(
      await api.post(`${H}/employees/${e.id}/contracts`, {
        code: 'CT-1',
        contractType: 'PERMANENT',
        startDate: '2026-01-05',
        weeklyHours: '40',
        currency: 'AOA',
        baseSalary: '200000',
      })
    )
    ok(await api.post(`${H}/contracts/${ct.id}/activate`, { expectedVersion: ct.version }), 200)
    const calc = async (period: string) => {
      const r = ok(await api.post(`${P}/runs`, { legalEntityId: le.id, period, kind: 'REGULAR' }))
      return ok(await api.post(`${P}/runs/${r.id}/calculate`, { expectedVersion: r.version }), 200)
    }
    const june = await calc('2026-06')
    assert.equal(june.results[0].status, 'OK')
    const july = await calc('2026-07')
    assert.equal(july.results[0].errors[0].code, 'NO_RULE_SET')
  })
})
