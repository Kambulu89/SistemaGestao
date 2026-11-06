import { test } from '@japa/runner'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger as setupLedger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'

async function setup(client: any) {
  const L = await setupLedger(client)
  const cc = async (code: string) =>
    ok(
      await L.api.post('/api/v1/organization/cost-centers', {
        code,
        name: `Centro ${code}`,
        legalEntityId: L.le.id,
      })
    )
  const [ccA, ccB, ccC] = [await cc('CCA'), await cc('CCB'), await cc('CCC')]
  const c6 = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '6',
      name: 'Gastos',
      level: 'CLASS',
      nature: 'EXPENSE',
      parentId: null,
    })
  )
  const expense = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '62',
      name: 'Serviços',
      level: 'ACCOUNT',
      nature: 'EXPENSE',
      parentId: c6.id,
      postable: true,
    })
  )
  const strict = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '63',
      name: 'Com centro obrigatório',
      level: 'ACCOUNT',
      nature: 'EXPENSE',
      parentId: c6.id,
      postable: true,
      requiresCostCenter: true,
    })
  )
  const project = ok(await L.api.post(`${A}/dimensions`, { code: 'projecto', name: 'Projecto' }))
  const values = ok(
    await L.api.post(`${A}/dimensions/${project.id}/values`, { code: 'P1', name: 'Projecto 1' })
  )
  const all = ok(
    await L.api.post(`${A}/dimensions/${project.id}/values`, { code: 'P2', name: 'Projecto 2' })
  )
  const [p1, p2] = [values[0], all.find((v: any) => v.code === 'P2')]
  const role = await createRole(client, L.s, 'rev_an', [
    'accounting.read',
    'accounting.approve',
    'accounting.post',
  ])
  const reviewer = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
  const post = async (lines: Record<string, unknown>[], date = '2026-03-10') => {
    const d = ok(
      await L.api.post(`${A}/entries`, {
        legalEntityId: L.le.id,
        journalId: L.journal.id,
        entryDate: date,
        description: 'Gasto',
        lines,
      })
    )
    const s = ok(
      await L.api.post(`${A}/entries/${d.id}/submit`, { expectedVersion: d.version }),
      200
    )
    const a = ok(
      await reviewer.post(`${A}/entries/${d.id}/approve`, { expectedVersion: s.version }),
      200
    )
    return ok(await reviewer.post(`${A}/entries/${d.id}/post`, { expectedVersion: a.version }), 200)
  }
  return { ...L, ccA, ccB, ccC, expense, strict, project, p1, p2, post }
}

test.group('contabilidade | analítica', (group) => {
  group.each.setup(() => cleanDatabase())

  test('dimensões e chaves: códigos únicos, valores activos, percentagens a somar 100', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    assert.equal(L.project.code, 'PROJECTO')
    ;(await L.api.post(`${A}/dimensions`, { code: 'PROJECTO', name: 'Outra' })).assertStatus(409)
    const bad = await L.api.post(`${A}/allocation-keys`, {
      legalEntityId: L.le.id,
      code: 'K1',
      name: 'Chave',
      lines: [{ percent: '60', costCenterId: L.ccA.id }, { percent: '30' }],
    })
    assert.sameMembers(
      bad.body().error.details.map((d: any) => d.code),
      ['NOT_100', 'EMPTY_TARGET']
    )
    const key = ok(
      await L.api.post(`${A}/allocation-keys`, {
        legalEntityId: L.le.id,
        code: 'K1',
        name: 'Rateio por áreas',
        lines: [
          { percent: '50', costCenterId: L.ccA.id, values: { [L.project.id]: L.p1.id } },
          { percent: '50', costCenterId: L.ccB.id, values: { [L.project.id]: L.p2.id } },
        ],
      })
    )
    assert.deepEqual(
      key.lines.map((l: any) => [l.percent, l.values[0].valueCode]),
      [
        ['50', 'P1'],
        ['50', 'P2'],
      ]
    )
    ok(
      await L.api.patch(`${A}/dimensions/${L.project.id}/values/${L.p2.id}`, {
        expectedVersion: L.p2.version,
        status: 'INACTIVE',
      }),
      200
    )
    const inactive = await L.api.post(`${A}/allocation-keys`, {
      legalEntityId: L.le.id,
      code: 'K2',
      name: 'Inactivo',
      lines: [{ percent: '100', values: [{ dimensionId: L.project.id, valueId: L.p2.id }] }],
    })
    assert.equal(inactive.body().error.details[0].code, 'VALUE_INACTIVE')
  })

  test('imputar um lançamento contabilizado: repartição exacta, relatório = razão, razão intacto', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const entry = await L.post([
      { accountId: L.expense.id, debit: '1000.01' },
      { accountId: L.cash.id, credit: '1000.01', costCenterId: L.ccC.id },
    ])
    const tbBefore = ok(await L.api.get(`${A}/trial-balance?fiscalYearId=${L.year.id}`), 200)
    const allocated = ok(
      await L.api.put(`${A}/entries/${entry.id}/lines/1/allocations`, {
        allocations: [
          { percent: '33.3333', costCenterId: L.ccA.id, values: { [L.project.id]: L.p1.id } },
          { percent: '33.3333', costCenterId: L.ccB.id, values: { [L.project.id]: L.p1.id } },
          { percent: '33.3334', costCenterId: L.ccC.id, values: { [L.project.id]: L.p2.id } },
        ],
      }),
      200
    )
    assert.lengthOf(allocated, 3)
    const byCenter = ok(await L.api.get(`${A}/analytics?fiscalYearId=${L.year.id}`), 200)
    assert.isTrue(byCenter.consistent)
    const row = (key: string | null) => byCenter.rows.find((r: any) => r.key === key)
    assert.equal(row(L.ccA.id).debit, '333.34')
    assert.equal(row(L.ccB.id).debit, '333.33')
    assert.deepInclude(row(L.ccC.id), { debit: '333.34', credit: '1000.01' })
    assert.deepInclude(byCenter.totals, { debit: '1000.01', credit: '1000.01' })
    assert.deepInclude(byCenter.ledger, { debit: '1000.01', credit: '1000.01' })

    const byProject = ok(
      await L.api.get(
        `${A}/analytics?fiscalYearId=${L.year.id}&groupBy=dimension&dimensionId=${L.project.id}&natures=EXPENSE`
      ),
      200
    )
    assert.deepEqual(
      byProject.rows.map((r: any) => [r.label, r.debit]),
      [
        ['P1 — Projecto 1', '666.67'],
        ['P2 — Projecto 2', '333.34'],
      ]
    )
    assert.isTrue(byProject.consistent)
    // A analítica não mexe no razão.
    const tbAfter = ok(await L.api.get(`${A}/trial-balance?fiscalYearId=${L.year.id}`), 200)
    assert.deepEqual(tbAfter.totals, tbBefore.totals)
    const events = (
      await L.api.get(`/api/v1/audit-events?entityType=journal_entry&entityId=${entry.id}`)
    ).body().data
    assert.include(
      events.map((e: any) => e.action),
      'journal_entry.allocated'
    )
  })

  test('chave aplicada a uma linha; conta que exige centro; rascunho alterado perde as imputações', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const key = ok(
      await L.api.post(`${A}/allocation-keys`, {
        legalEntityId: L.le.id,
        code: 'MEIO',
        name: 'Metade',
        lines: [
          { percent: '50', costCenterId: L.ccA.id },
          { percent: '50', values: { [L.project.id]: L.p1.id } },
        ],
      })
    )
    const entry = await L.post([
      { accountId: L.strict.id, debit: '10', costCenterId: L.ccA.id },
      { accountId: L.expense.id, debit: '10' },
      { accountId: L.cash.id, credit: '20' },
    ])
    const refused = await L.api.put(`${A}/entries/${entry.id}/lines/1/allocations`, {
      keyId: key.id,
    })
    assert.equal(refused.body().error.details[0].code, 'COST_CENTER_REQUIRED')
    const applied = ok(
      await L.api.put(`${A}/entries/${entry.id}/lines/2/allocations`, { keyId: key.id }),
      200
    )
    assert.deepEqual(
      applied.map((a: any) => [a.lineNo, a.percent]),
      [
        [2, '50'],
        [2, '50'],
      ]
    )
    ok(await L.api.put(`${A}/entries/${entry.id}/lines/2/allocations`, { allocations: [] }), 200)
    assert.lengthOf(ok(await L.api.get(`${A}/entries/${entry.id}/allocations`), 200), 0)
    ;(
      await L.api.put(`${A}/entries/${entry.id}/lines/9/allocations`, { allocations: [] })
    ).assertStatus(404)

    const draft = ok(
      await L.api.post(`${A}/entries`, {
        legalEntityId: L.le.id,
        journalId: L.journal.id,
        entryDate: '2026-03-11',
        description: 'Rascunho',
        lines: [
          { accountId: L.expense.id, debit: '5' },
          { accountId: L.cash.id, credit: '5' },
        ],
      })
    )
    ok(await L.api.put(`${A}/entries/${draft.id}/lines/1/allocations`, { keyId: key.id }), 200)
    ok(
      await L.api.patch(`${A}/entries/${draft.id}`, {
        expectedVersion: draft.version,
        lines: [
          { accountId: L.expense.id, debit: '6' },
          { accountId: L.cash.id, credit: '6' },
        ],
      }),
      200
    )
    assert.lengthOf(ok(await L.api.get(`${A}/entries/${draft.id}/allocations`), 200), 0)
  })

  test('permissões: ler não chega para imputar nem para o relatório', async ({ client }) => {
    const L = await setup(client)
    const entry = await L.post([
      { accountId: L.expense.id, debit: '1' },
      { accountId: L.cash.id, credit: '1' },
    ])
    const role = await createRole(client, L.s, 'leitor_an', ['accounting.read'])
    const R = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
    ;(await R.get(`${A}/entries/${entry.id}/allocations`)).assertStatus(200)
    ;(
      await R.put(`${A}/entries/${entry.id}/lines/1/allocations`, { allocations: [] })
    ).assertStatus(403)
    ;(await R.get(`${A}/analytics?fiscalYearId=${L.year.id}`)).assertStatus(403)
    ;(await R.post(`${A}/dimensions`, { code: 'X', name: 'X' })).assertStatus(403)
  })
})
