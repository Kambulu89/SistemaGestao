import { test } from '@japa/runner'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger as setupLedger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'

/**
 * Plano: 111 caixa, 112 clientes, 113 banco (devedor ou descoberto), 22 fornecedores, 51 capital, 62 gastos, 71
 * vendas. Movimentos contabilizados: capital 1 000, venda 500 a crédito, gasto 200 pago, gasto 100 a fornecedor e
 * gasto 50 por descoberto. Saldos: caixa 800, clientes 500, banco −50, fornecedores −100, capital −1 000, gastos 350,
 * vendas −500; resultado 150.
 */
async function setup(client: any) {
  const L = await setupLedger(client)
  const account = async (code: string, level: string, nature: string, parentId: string | null) =>
    ok(
      await L.api.post(`${A}/accounts`, {
        chartId: L.chart.id,
        code,
        name: `Conta ${code}`,
        level,
        nature,
        parentId,
        ...(level === 'CLASS' ? {} : { postable: true }),
      })
    )
  const clients = await account('112', 'SUBACCOUNT', 'ASSET', L.c11.id)
  const bank = await account('113', 'SUBACCOUNT', 'ASSET', L.c11.id)
  const c2 = await account('2', 'CLASS', 'LIABILITY', null)
  const suppliers = await account('22', 'ACCOUNT', 'LIABILITY', c2.id)
  const c5 = await account('5', 'CLASS', 'EQUITY', null)
  const capital = await account('51', 'ACCOUNT', 'EQUITY', c5.id)
  const c6 = await account('6', 'CLASS', 'EXPENSE', null)
  const expenses = await account('62', 'ACCOUNT', 'EXPENSE', c6.id)
  const role = await createRole(client, L.s, 'rev_dem', [
    'accounting.read',
    'accounting.approve',
    'accounting.post',
  ])
  const reviewer = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
  const post = async (debit: string, credit: string, amount: string) => {
    const e = ok(
      await L.api.post(`${A}/entries`, {
        legalEntityId: L.le.id,
        journalId: L.journal.id,
        entryDate: '2026-03-10',
        description: 'Movimento',
        lines: [
          { accountId: debit, debit: amount },
          { accountId: credit, credit: amount },
        ],
      })
    )
    const s = ok(
      await L.api.post(`${A}/entries/${e.id}/submit`, { expectedVersion: e.version }),
      200
    )
    const a = ok(
      await reviewer.post(`${A}/entries/${e.id}/approve`, { expectedVersion: s.version }),
      200
    )
    ok(await reviewer.post(`${A}/entries/${e.id}/post`, { expectedVersion: a.version }), 200)
  }
  await post(L.cash.id, capital.id, '1000.00')
  await post(clients.id, L.sales.id, '500.00')
  await post(expenses.id, L.cash.id, '200.00')
  await post(expenses.id, suppliers.id, '100.00')
  await post(expenses.id, bank.id, '50.00')
  return { ...L, clients, bank, suppliers, capital, expenses }
}

const balanceSheet = (chartId: string, withOverdraft = true) => ({
  chartId,
  code: 'BAL',
  name: 'Balanço',
  kind: 'BALANCE_SHEET',
  checkA: 'TA',
  checkB: 'TCP',
  lines: [
    { kind: 'HEADER', label: 'ACTIVO' },
    {
      kind: 'ACCOUNTS',
      code: 'A1',
      label: 'Caixa e bancos',
      sign: 1,
      noteRef: '3',
      mappings: [
        { prefix: '111', rule: 'ANY' },
        { prefix: '113', rule: 'DEBIT' },
      ],
    },
    { kind: 'ACCOUNTS', code: 'A2', label: 'Clientes', sign: 1, mappings: [{ prefix: '112' }] },
    { kind: 'TOTAL', code: 'TA', label: 'Total do activo', formula: 'A1+A2' },
    { kind: 'HEADER', label: 'CAPITAL PRÓPRIO E PASSIVO' },
    { kind: 'ACCOUNTS', code: 'C1', label: 'Capital', sign: -1, mappings: [{ prefix: '5' }] },
    { kind: 'NET_INCOME', code: 'RL', label: 'Resultado líquido do período', sign: -1 },
    { kind: 'TOTAL', code: 'TC', label: 'Total do capital próprio', formula: 'C1+RL' },
    { kind: 'ACCOUNTS', code: 'P1', label: 'Fornecedores', sign: -1, mappings: [{ prefix: '22' }] },
    {
      kind: 'ACCOUNTS',
      code: 'P2',
      label: 'Descobertos bancários',
      sign: -1,
      mappings: withOverdraft ? [{ prefix: '113', rule: 'CREDIT' }] : [],
    },
    { kind: 'TOTAL', code: 'TP', label: 'Total do passivo', formula: 'P1+P2' },
    { kind: 'TOTAL', code: 'TCP', label: 'Total do capital próprio e passivo', formula: 'TC+TP' },
  ],
})

test.group('contabilidade | demonstrações financeiras', (group) => {
  group.each.setup(() => cleanDatabase())

  test('modelos: validação, versões publicadas imutáveis e só um rascunho por código', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const ambiguous = balanceSheet(L.chart.id)
    ambiguous.lines[2].mappings = [{ prefix: '111', rule: 'DEBIT' } as never]
    const bad = await L.api.post(`${A}/statement-templates`, ambiguous)
    assert.equal(bad.status(), 422)
    assert.include(
      bad.body().error.details.map((d: any) => d.code),
      'AMBIGUOUS'
    )
    const noCheck = await L.api.post(`${A}/statement-templates`, {
      ...balanceSheet(L.chart.id),
      checkB: null,
    })
    assert.equal(noCheck.body().error.details[0].path, 'checkB')

    const v1 = ok(await L.api.post(`${A}/statement-templates`, balanceSheet(L.chart.id)))
    assert.equal(v1.status, 'DRAFT')
    assert.lengthOf(v1.mappings, 6)
    ok(await L.api.patch(`${A}/statement-templates/${v1.id}`, { name: 'Balanço (modelo)' }), 200)
    const pub = ok(await L.api.post(`${A}/statement-templates/${v1.id}/publish`), 200)
    assert.equal(pub.status, 'PUBLISHED')
    const frozen = await L.api.patch(`${A}/statement-templates/${v1.id}`, { name: 'x' })
    assert.equal(frozen.body().error.code, 'NOT_DRAFT')
    ;(await L.api.delete(`${A}/statement-templates/${v1.id}`)).assertStatus(409)
    const dup = await L.api.post(`${A}/statement-templates`, balanceSheet(L.chart.id))
    assert.equal(dup.body().error.code, 'TEMPLATE_CODE_TAKEN')

    const v2 = ok(await L.api.post(`${A}/statement-templates/${v1.id}/versions`))
    assert.equal(v2.version, 2)
    assert.equal(v2.status, 'DRAFT')
    const again = await L.api.post(`${A}/statement-templates/${v1.id}/versions`)
    assert.equal(again.body().error.code, 'DRAFT_EXISTS')
    ok(await L.api.post(`${A}/statement-templates/${v2.id}/publish`), 200)
    const list = ok(await L.api.get(`${A}/statement-templates?chartId=${L.chart.id}`), 200)
    assert.deepEqual(
      list.map((t: any) => [t.version, t.status]),
      [
        [2, 'PUBLISHED'],
        [1, 'RETIRED'],
      ]
    )
    const v3 = ok(await L.api.post(`${A}/statement-templates/${v2.id}/versions`))
    ;(await L.api.delete(`${A}/statement-templates/${v3.id}`)).assertStatus(204)
  })

  test('balanço e resultados conferem com o razão; contas sem linha impedem a conferência', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const bs = ok(await L.api.post(`${A}/statement-templates`, balanceSheet(L.chart.id)))
    const r = ok(
      await L.api.get(`${A}/statements?templateId=${bs.id}&fiscalYearId=${L.year.id}`),
      200
    )
    const v = Object.fromEntries(
      r.lines.filter((l: any) => l.code).map((l: any) => [l.code, l.value])
    )
    assert.deepEqual(v, {
      A1: '800.00',
      A2: '500.00',
      TA: '1300.00',
      C1: '1000.00',
      RL: '150.00',
      TC: '1150.00',
      P1: '100.00',
      P2: '50.00',
      TP: '150.00',
      TCP: '1300.00',
    })
    assert.deepEqual(r.check, { a: '1300.00', b: '1300.00', ok: true })
    assert.isTrue(r.consistent)
    assert.deepEqual(r.unmapped, [])
    assert.equal(r.netIncome, '150.00')
    assert.deepEqual(
      r.lines.find((l: any) => l.code === 'A1').accounts.map((a: any) => [a.code, a.amount]),
      [['111', '800.00']]
    )

    // Sem a linha de descobertos, o banco credor fica por apresentar e a demonstração não confere.
    const partial = ok(
      await L.api.post(`${A}/statement-templates`, {
        ...balanceSheet(L.chart.id, false),
        code: 'BAL2',
      })
    )
    const p = ok(
      await L.api.get(`${A}/statements?templateId=${partial.id}&fiscalYearId=${L.year.id}`),
      200
    )
    assert.isFalse(p.consistent)
    assert.deepEqual(p.unmapped, [{ code: '113', name: 'Conta 113', balance: '-50.00' }])

    const is = ok(
      await L.api.post(`${A}/statement-templates`, {
        chartId: L.chart.id,
        code: 'DR',
        name: 'Demonstração de resultados',
        kind: 'INCOME_STATEMENT',
        checkA: 'RES',
        lines: [
          { kind: 'ACCOUNTS', code: 'R1', label: 'Vendas', sign: -1, mappings: [{ prefix: '7' }] },
          { kind: 'ACCOUNTS', code: 'G1', label: 'Gastos', sign: 1, mappings: [{ prefix: '6' }] },
          { kind: 'TOTAL', code: 'RES', label: 'Resultado líquido', formula: 'R1-G1' },
        ],
      })
    )
    const dr = ok(
      await L.api.get(`${A}/statements?templateId=${is.id}&fiscalYearId=${L.year.id}`),
      200
    )
    assert.deepEqual(
      dr.lines.map((l: any) => l.value),
      ['500.00', '350.00', '150.00']
    )
    assert.deepEqual(dr.check, { a: '150.00', b: '150.00', ok: true })
    assert.isTrue(dr.consistent)

    // Até Fevereiro (período 2) ainda não há movimentos.
    const feb = ok(
      await L.api.get(`${A}/statements?templateId=${is.id}&fiscalYearId=${L.year.id}&toPeriod=2`),
      200
    )
    assert.equal(feb.lines[2].value, '0.00')

    // Comparativo com um exercício sem movimentos.
    const y2027 = ok(
      await L.api.post(`${A}/fiscal-years`, {
        legalEntityId: L.le.id,
        code: '2027',
        startDate: '2027-01-01',
        endDate: '2027-12-31',
      })
    )
    const cmp = ok(
      await L.api.get(
        `${A}/statements?templateId=${bs.id}&fiscalYearId=${L.year.id}&compareFiscalYearId=${y2027.id}`
      ),
      200
    )
    assert.equal(cmp.compareFiscalYear.code, '2027')
    assert.equal(cmp.lines.find((l: any) => l.code === 'TA').previous, '0.00')
  })

  test('notas: numeradas por exercício e mostradas com a demonstração; permissões separadas', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const bs = ok(await L.api.post(`${A}/statement-templates`, balanceSheet(L.chart.id)))
    const note = ok(
      await L.api.post(`${A}/statement-notes`, {
        fiscalYearId: L.year.id,
        number: 3,
        title: 'Caixa e equivalentes',
        body: 'Saldos de caixa e depósitos à ordem.',
      })
    )
    const dup = await L.api.post(`${A}/statement-notes`, {
      fiscalYearId: L.year.id,
      number: 3,
      title: 'Outra',
      body: 'x',
    })
    assert.equal(dup.body().error.code, 'NOTE_NUMBER_TAKEN')
    const edited = ok(
      await L.api.patch(`${A}/statement-notes/${note.id}`, {
        expectedVersion: note.version,
        number: 3,
        title: 'Caixa e equivalentes de caixa',
        body: 'Saldos de caixa e depósitos à ordem em moeda nacional.',
      }),
      200
    )
    assert.equal(edited.version, 2)
    const r = ok(
      await L.api.get(`${A}/statements?templateId=${bs.id}&fiscalYearId=${L.year.id}`),
      200
    )
    assert.equal(r.notes[0].title, 'Caixa e equivalentes de caixa')
    assert.equal(r.lines.find((l: any) => l.code === 'A1').noteRef, '3')

    const reader = await createRole(client, L.s, 'leitor_dem', ['accounting.read'])
    const reports = await createRole(client, L.s, 'relat_dem', [
      'accounting.read',
      'accounting.reports',
    ])
    const R = as(client, (await memberWithRoles(client, L.s, [reader.id])).session)
    const P = as(client, (await memberWithRoles(client, L.s, [reports.id])).session)
    ;(await R.get(`${A}/statement-templates`)).assertStatus(200)
    ;(await R.get(`${A}/statements?templateId=${bs.id}&fiscalYearId=${L.year.id}`)).assertStatus(
      403
    )
    ;(await R.post(`${A}/statement-templates`, balanceSheet(L.chart.id))).assertStatus(403)
    ;(await P.get(`${A}/statements?templateId=${bs.id}&fiscalYearId=${L.year.id}`)).assertStatus(
      200
    )
    ;(
      await P.post(`${A}/statement-notes`, {
        fiscalYearId: L.year.id,
        number: 4,
        title: 'Nota',
        body: 'x',
      })
    ).assertStatus(403)
    ;(await L.api.delete(`${A}/statement-notes/${note.id}`)).assertStatus(204)
    assert.isTrue(true)
  })
})
