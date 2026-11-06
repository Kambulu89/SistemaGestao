import { test } from '@japa/runner'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger as setupLedger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'

/** Contabiliza um lançamento (rascunho → submetido → aprovado por outro → contabilizado). */
async function posted(L: any, reviewer: any, body: Record<string, unknown>) {
  const draft = ok(
    await L.api.post(`${A}/entries`, { legalEntityId: L.le.id, journalId: L.journal.id, ...body })
  )
  const sub = ok(
    await L.api.post(`${A}/entries/${draft.id}/submit`, { expectedVersion: draft.version }),
    200
  )
  const app = ok(
    await reviewer.post(`${A}/entries/${draft.id}/approve`, { expectedVersion: sub.version }),
    200
  )
  return ok(
    await reviewer.post(`${A}/entries/${draft.id}/post`, { expectedVersion: app.version }),
    200
  )
}

async function setup(client: any) {
  const L = await setupLedger(client)
  const c2 = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '2',
      name: 'Capital',
      level: 'CLASS',
      nature: 'EQUITY',
      parentId: null,
    })
  )
  const capital = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '21',
      name: 'Capital social',
      level: 'ACCOUNT',
      nature: 'EQUITY',
      parentId: c2.id,
      postable: true,
    })
  )
  const bank = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '112',
      name: 'Banco',
      level: 'SUBACCOUNT',
      nature: 'ASSET',
      parentId: L.c11.id,
      postable: true,
    })
  )
  const role = await createRole(client, L.s, 'revisor_r', [
    'accounting.read',
    'accounting.approve',
    'accounting.post',
    'accounting.reverse',
  ])
  const reviewer = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
  return { ...L, capital, bank, reviewer }
}

test.group('contabilidade | abertura, razão e balancete', (group) => {
  group.each.setup(() => cleanDatabase())

  test('importação de abertura: validada linha a linha, equilibrada, rascunho no período de abertura, uma por exercício', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const base = { fiscalYearId: L.year.id, journalId: L.journal.id }
    const check = ok(
      await L.api.post(`${A}/opening-balances/validate`, {
        ...base,
        lines: [
          { accountCode: '111', debit: '1000' },
          { accountCode: '11', debit: '5' },
          { accountCode: '999', credit: '1' },
          { accountCode: '21', debit: '1', credit: '1' },
          { accountCode: '111', debit: '3' },
        ],
      }),
      200
    )
    assert.sameMembers(
      check.issues.map((i: any) => i.code),
      ['NOT_POSTABLE', 'ACCOUNT_NOT_FOUND', 'ONE_SIDE', 'DUPLICATE', 'UNBALANCED']
    )
    assert.match(check.issues.find((i: any) => i.code === 'ACCOUNT_NOT_FOUND').message, /Linha 3/)

    const lines = [
      { accountCode: '111', debit: '1000,00'.replace(',', '.') },
      { accountCode: '112', debit: '4000' },
      { accountCode: '21', credit: '5000' },
    ]
    const entry = ok(await L.api.post(`${A}/opening-balances`, { ...base, lines }))
    assert.deepInclude(entry, {
      status: 'DRAFT',
      source: 'OPENING_BALANCE',
      periodName: 'Abertura',
      entryDate: '2026-01-01',
      totalDebit: '5000.00',
    })
    const again = await L.api.post(`${A}/opening-balances`, { ...base, lines })
    again.assertStatus(409)
    assert.equal(again.body().error.code, 'OPENING_EXISTS')
    const unbalanced = await L.api.post(`${A}/opening-balances/validate`, {
      ...base,
      lines: lines.slice(0, 2),
    })
    assert.include(
      unbalanced.body().data.issues.map((i: any) => i.code),
      'OPENING_EXISTS'
    )

    // Contabilizada e depois estornada: pode importar-se de novo.
    const sub = ok(
      await L.api.post(`${A}/entries/${entry.id}/submit`, { expectedVersion: entry.version }),
      200
    )
    const app = ok(
      await L.reviewer.post(`${A}/entries/${entry.id}/approve`, { expectedVersion: sub.version }),
      200
    )
    ok(
      await L.reviewer.post(`${A}/entries/${entry.id}/post`, { expectedVersion: app.version }),
      200
    )
    ok(await L.reviewer.post(`${A}/entries/${entry.id}/reverse`, { date: '2026-01-01' }))
    ok(await L.api.post(`${A}/opening-balances`, { ...base, lines }))
  })

  test('balancete = razão; contas-mãe não duplicam; só contabilizados; intervalo de períodos; sintético', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const opening = ok(
      await L.api.post(`${A}/opening-balances`, {
        fiscalYearId: L.year.id,
        journalId: L.journal.id,
        lines: [
          { accountCode: '111', debit: '1000' },
          { accountCode: '112', debit: '4000' },
          { accountCode: '21', credit: '5000' },
        ],
      })
    )
    const sub = ok(
      await L.api.post(`${A}/entries/${opening.id}/submit`, { expectedVersion: opening.version }),
      200
    )
    const app = ok(
      await L.reviewer.post(`${A}/entries/${opening.id}/approve`, { expectedVersion: sub.version }),
      200
    )
    ok(
      await L.reviewer.post(`${A}/entries/${opening.id}/post`, { expectedVersion: app.version }),
      200
    )
    const sale = (
      date: string,
      account: string,
      amount: string,
      thirdPartyRef: string | null = null
    ) =>
      posted(L, L.reviewer, {
        entryDate: date,
        description: `Venda ${date}`,
        lines: [
          { accountId: account, debit: amount, thirdPartyRef },
          { accountId: L.sales.id, credit: amount },
        ],
      })
    await sale('2026-02-10', L.cash.id, '300', 'CLIENTE-A')
    await sale('2026-03-05', L.bank.id, '700', 'CLIENTE-B')
    await sale('2026-03-20', L.cash.id, '50.25', 'CLIENTE-A')
    // Rascunho não conta.
    ok(
      await L.api.post(`${A}/entries`, {
        legalEntityId: L.le.id,
        journalId: L.journal.id,
        entryDate: '2026-03-21',
        description: 'Rascunho',
        lines: [
          { accountId: L.cash.id, debit: '999' },
          { accountId: L.sales.id, credit: '999' },
        ],
      })
    )

    const tb = ok(await L.api.get(`${A}/trial-balance?fiscalYearId=${L.year.id}`), 200)
    assert.isTrue(tb.balanced)
    const row = (code: string) => tb.rows.find((r: any) => r.code === code)
    assert.deepInclude(row('111'), {
      opening: '0.00',
      debit: '1350.25',
      credit: '0.00',
      closing: '1350.25',
    })
    assert.deepInclude(row('11'), { debit: '6050.25', closing: '6050.25' })
    assert.deepInclude(row('1'), { debit: '6050.25', closing: '6050.25' })
    assert.deepInclude(tb.totals, {
      debit: '6050.25',
      credit: '6050.25',
      closingDebit: '6050.25',
      closingCredit: '6050.25',
    })

    // Março (período 3): saldo anterior inclui abertura e Fevereiro.
    const march = ok(
      await L.api.get(`${A}/trial-balance?fiscalYearId=${L.year.id}&fromPeriod=3&toPeriod=3`),
      200
    )
    const m111 = march.rows.find((r: any) => r.code === '111')
    assert.deepInclude(m111, { opening: '1300.00', debit: '50.25', closing: '1350.25' })
    assert.deepInclude(march.totals, { opening: '0.00', debit: '750.25', credit: '750.25' })

    const synth = ok(
      await L.api.get(`${A}/trial-balance?fiscalYearId=${L.year.id}&mode=synthetic&maxDepth=1`),
      200
    )
    assert.deepEqual(
      synth.rows.map((r: any) => r.code),
      ['1', '2', '7']
    )

    // Razão: cada conta coincide com o balancete; conta-mãe inclui as subcontas; filtro por terceiro.
    for (const code of ['111', '112', '21', '71']) {
      const account = [L.cash, L.bank, L.capital, L.sales].find((a: any) => a.code === code)
      const lg = ok(
        await L.api.get(
          `${A}/ledger?legalEntityId=${L.le.id}&accountId=${account.id}&from=2026-01-01&to=2026-12-31`
        ),
        200
      )
      assert.equal(lg.closing, row(code).closing, code)
      assert.equal(lg.debit, row(code).debit, code)
    }
    const parent = ok(
      await L.api.get(
        `${A}/ledger?legalEntityId=${L.le.id}&accountId=${L.c11.id}&from=2026-01-01&to=2026-12-31`
      ),
      200
    )
    assert.deepInclude(parent, { closing: '6050.25' })
    assert.isTrue(parent.account.includesSubaccounts)
    const marchLedger = ok(
      await L.api.get(
        `${A}/ledger?legalEntityId=${L.le.id}&accountId=${L.cash.id}&from=2026-03-01&to=2026-03-31`
      ),
      200
    )
    assert.deepInclude(marchLedger, { opening: '1300.00', debit: '50.25', closing: '1350.25' })
    assert.deepEqual(
      marchLedger.lines.map((l: any) => [l.date, l.debit, l.balance]),
      [['2026-03-20', '50.25', '1350.25']]
    )
    const clientA = ok(
      await L.api.get(
        `${A}/ledger?legalEntityId=${L.le.id}&accountId=${L.c11.id}&from=2026-01-01&to=2026-12-31&thirdPartyRef=CLIENTE-A`
      ),
      200
    )
    assert.deepInclude(clientA, { debit: '350.25' })
    ;(
      await L.api.get(
        `${A}/ledger?legalEntityId=${L.le.id}&accountId=${L.cash.id}&from=2026-03-01&to=2027-01-10`
      )
    ).assertStatus(422)
  })

  test('permissões: relatórios exigem accounting.reports; importar exige accounting.create', async ({
    client,
  }) => {
    const L = await setup(client)
    const role = await createRole(client, L.s, 'so_leitura', ['accounting.read'])
    const R = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
    ;(await R.get(`${A}/trial-balance?fiscalYearId=${L.year.id}`)).assertStatus(403)
    ;(
      await R.get(
        `${A}/ledger?legalEntityId=${L.le.id}&accountId=${L.cash.id}&from=2026-01-01&to=2026-01-31`
      )
    ).assertStatus(403)
    ;(
      await R.post(`${A}/opening-balances/validate`, {
        fiscalYearId: L.year.id,
        journalId: L.journal.id,
        lines: [],
      })
    ).assertStatus(403)
  })
})
