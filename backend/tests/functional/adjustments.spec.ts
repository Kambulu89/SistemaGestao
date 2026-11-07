import { test } from '@japa/runner'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger as setupLedger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'

/** Plano com clientes (113), custos diferidos (114), fornecedores (22), provisões (29), gastos, ganhos e perdas. */
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
  const clients = await account('113', 'SUBACCOUNT', 'ASSET', L.c11.id)
  const deferred = await account('114', 'SUBACCOUNT', 'ASSET', L.c11.id)
  const c2 = await account('2', 'CLASS', 'LIABILITY', null)
  const suppliers = await account('22', 'ACCOUNT', 'LIABILITY', c2.id)
  const provisionAcc = await account('29', 'ACCOUNT', 'LIABILITY', c2.id)
  const c6 = await account('6', 'CLASS', 'EXPENSE', null)
  const rent = await account('62', 'ACCOUNT', 'EXPENSE', c6.id)
  const provisionExp = await account('67', 'ACCOUNT', 'EXPENSE', c6.id)
  const fxLoss = await account('68', 'ACCOUNT', 'EXPENSE', c6.id)
  const fxGain = await account('76', 'ACCOUNT', 'REVENUE', L.c7.id)
  const fxRealized = await account('77', 'ACCOUNT', 'REVENUE', L.c7.id)
  const reversal = await account('78', 'ACCOUNT', 'REVENUE', L.c7.id)
  const role = await createRole(client, L.s, 'rev_reg', [
    'accounting.read',
    'accounting.approve',
    'accounting.post',
  ])
  const reviewer = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
  /** Submete (quem criou) e aprova/contabiliza (revisor). */
  const postDraft = async (id: string) => {
    const d = ok(await L.api.get(`${A}/entries/${id}`), 200)
    const s = ok(await L.api.post(`${A}/entries/${id}/submit`, { expectedVersion: d.version }), 200)
    const a = ok(
      await reviewer.post(`${A}/entries/${id}/approve`, { expectedVersion: s.version }),
      200
    )
    return ok(await reviewer.post(`${A}/entries/${id}/post`, { expectedVersion: a.version }), 200)
  }
  const post = async (body: Record<string, unknown>) =>
    postDraft(
      ok(
        await L.api.post(`${A}/entries`, {
          legalEntityId: L.le.id,
          journalId: L.journal.id,
          description: 'Movimento',
          ...body,
        })
      ).id
    )
  return {
    ...L,
    clients,
    deferred,
    suppliers,
    provisionAcc,
    rent,
    provisionExp,
    fxLoss,
    fxGain,
    fxRealized,
    reversal,
    postDraft,
    post,
  }
}

test.group('contabilidade | regularizações', (group) => {
  group.each.setup(() => cleanDatabase())

  test('planos: recorrência e diferimento geram rascunhos uma vez por mês, com repartição exacta', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const unbalanced = await L.api.post(`${A}/adjustment-schedules`, {
      legalEntityId: L.le.id,
      code: 'X',
      name: 'Errado',
      kind: 'RECURRING',
      journalId: L.journal.id,
      startMonth: '2026-01',
      lines: [
        { accountId: L.rent.id, debit: '100.00' },
        { accountId: L.cash.id, credit: '90.00' },
      ],
    })
    assert.equal(unbalanced.body().error.details[0].code, 'UNBALANCED')
    const same = await L.api.post(`${A}/adjustment-schedules`, {
      legalEntityId: L.le.id,
      code: 'Y',
      name: 'Mesma conta',
      kind: 'DEFERRAL',
      journalId: L.journal.id,
      startMonth: '2026-02',
      months: 3,
      totalAmount: '1000.00',
      debitAccountId: L.rent.id,
      creditAccountId: L.rent.id,
    })
    assert.equal(same.status(), 422)

    const rent = ok(
      await L.api.post(`${A}/adjustment-schedules`, {
        legalEntityId: L.le.id,
        code: 'RENDA',
        name: 'Renda do escritório',
        kind: 'RECURRING',
        frequency: 'MONTHLY',
        journalId: L.journal.id,
        startMonth: '2026-01',
        endMonth: '2026-03',
        lines: [
          { accountId: L.rent.id, debit: '100.00' },
          { accountId: L.suppliers.id, credit: '100.00', thirdPartyRef: 'SENHORIO' },
        ],
      })
    )
    const insurance = ok(
      await L.api.post(`${A}/adjustment-schedules`, {
        legalEntityId: L.le.id,
        code: 'SEGURO',
        name: 'Seguro anual pago',
        kind: 'DEFERRAL',
        journalId: L.journal.id,
        startMonth: '2026-02',
        months: 3,
        totalAmount: '1000.00',
        debitAccountId: L.rent.id,
        creditAccountId: L.deferred.id,
      })
    )
    assert.equal(insurance.lastMonth, '2026-04')

    const preview = ok(
      await L.api.get(`${A}/adjustments/preview?legalEntityId=${L.le.id}&upTo=2026-03`),
      200
    )
    assert.equal(preview.total, '966.67')
    assert.lengthOf(preview.rows, 5)
    const gen = ok(
      await L.api.post(`${A}/adjustments/generate`, { legalEntityId: L.le.id, upTo: '2026-03' }),
      200
    )
    assert.lengthOf(gen.entries, 5)
    const again = await L.api.post(`${A}/adjustments/generate`, {
      legalEntityId: L.le.id,
      upTo: '2026-03',
    })
    assert.equal(again.body().error.code, 'NOTHING_DUE')

    const detail = ok(await L.api.get(`${A}/adjustment-schedules/${insurance.id}`), 200)
    assert.deepEqual(
      detail.occurrences.map((o: any) => [o.month, o.amount, o.entryStatus]),
      [
        ['2026-02', '333.33', 'DRAFT'],
        ['2026-03', '333.34', 'DRAFT'],
      ]
    )
    const entry = ok(await L.api.get(`${A}/entries/${detail.occurrences[0].entryId}`), 200)
    assert.equal(entry.source, 'ADJUSTMENT')
    assert.equal(entry.entryDate, '2026-02-28')

    // Com meses gerados, o diferimento não muda de total.
    const frozen = await L.api.patch(`${A}/adjustment-schedules/${insurance.id}`, {
      expectedVersion: detail.version,
      totalAmount: '1200.00',
    })
    assert.equal(frozen.body().error.details[0].code, 'IN_USE')

    // Apagar um rascunho liberta o mês: volta a ser gerado.
    ;(await L.api.delete(`${A}/entries/${detail.occurrences[0].entryId}`)).assertStatus(204)
    const regen = ok(
      await L.api.post(`${A}/adjustments/generate`, { legalEntityId: L.le.id, upTo: '2026-03' }),
      200
    )
    assert.deepEqual(
      regen.rows.map((r: any) => [r.code, r.month, r.total]),
      [['SEGURO', '2026-02', '333.33']]
    )

    // Concorrência: duas gerações ao mesmo tempo para Abril — uma gera, a outra não encontra nada.
    const [a, b] = await Promise.all([
      L.api.post(`${A}/adjustments/generate`, { legalEntityId: L.le.id, upTo: '2026-04' }),
      L.api.post(`${A}/adjustments/generate`, { legalEntityId: L.le.id, upTo: '2026-04' }),
    ])
    assert.sameMembers([a.status(), b.status()], [200, 409])
    const last = ok(await L.api.get(`${A}/adjustment-schedules/${insurance.id}`), 200)
    assert.deepEqual(
      last.occurrences.map((o: any) => o.amount),
      ['333.33', '333.34', '333.33']
    )
    const rents = ok(await L.api.get(`${A}/adjustment-schedules/${rent.id}`), 200)
    assert.lengthOf(rents.occurrences, 3) // termina em Março
  })

  test('provisões: constituição, utilização e reversão sem exceder o saldo', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const p = ok(
      await L.api.post(`${A}/provisions`, {
        legalEntityId: L.le.id,
        code: 'PROC',
        name: 'Processo judicial',
        journalId: L.journal.id,
        expenseAccountId: L.provisionExp.id,
        provisionAccountId: L.provisionAcc.id,
        reversalAccountId: L.reversal.id,
      })
    )
    const c = ok(
      await L.api.post(`${A}/provisions/${p.id}/movements`, {
        type: 'CONSTITUTION',
        date: '2026-03-31',
        amount: '500.00',
        reason: 'Risco provável',
      })
    )
    assert.equal(c.balance, '500.00')
    assert.equal(c.postedBalance, '0.00')
    const tooMuch = await L.api.post(`${A}/provisions/${p.id}/movements`, {
      type: 'REVERSAL',
      date: '2026-04-30',
      amount: '600.00',
      reason: 'Excesso',
    })
    assert.equal(tooMuch.body().error.details[0].code, 'EXCEEDS_BALANCE')
    const noAccount = await L.api.post(`${A}/provisions/${p.id}/movements`, {
      type: 'USE',
      date: '2026-04-30',
      amount: '100.00',
      reason: 'Pagamento',
    })
    assert.equal(noAccount.body().error.details[0].path, 'counterAccountId')
    ok(
      await L.api.post(`${A}/provisions/${p.id}/movements`, {
        type: 'USE',
        date: '2026-04-30',
        amount: '200.00',
        counterAccountId: L.cash.id,
        reason: 'Pagamento das custas',
      })
    )
    const done = ok(
      await L.api.post(`${A}/provisions/${p.id}/movements`, {
        type: 'REVERSAL',
        date: '2026-05-31',
        amount: '300.00',
        reason: 'Risco desapareceu',
      })
    )
    assert.equal(done.balance, '0.00')
    const constitution = done.movements[0]
    const posted = await L.postDraft(constitution.entryId)
    assert.equal(posted.status, 'POSTED')
    const entry = ok(await L.api.get(`${A}/entries/${constitution.entryId}`), 200)
    const byAccount = Object.fromEntries(entry.lines.map((l: any) => [l.accountId, l]))
    assert.equal(byAccount[L.provisionExp.id].debit, '500.00')
    assert.equal(byAccount[L.provisionAcc.id].credit, '500.00')
    const after = ok(await L.api.get(`${A}/provisions/${p.id}`), 200)
    assert.equal(after.postedBalance, '500.00')
    // Concorrência: duas reversões de 200 sobre um saldo de 300 — só uma passa.
    const p2 = ok(
      await L.api.post(`${A}/provisions`, {
        legalEntityId: L.le.id,
        code: 'GAR',
        name: 'Garantias',
        journalId: L.journal.id,
        expenseAccountId: L.provisionExp.id,
        provisionAccountId: L.provisionAcc.id,
        reversalAccountId: L.reversal.id,
      })
    )
    ok(
      await L.api.post(`${A}/provisions/${p2.id}/movements`, {
        type: 'CONSTITUTION',
        date: '2026-03-31',
        amount: '300.00',
        reason: 'Garantias dadas',
      })
    )
    const body = { type: 'REVERSAL', date: '2026-04-30', amount: '200.00', reason: 'Reduz' }
    const [x, y] = await Promise.all([
      L.api.post(`${A}/provisions/${p2.id}/movements`, body),
      L.api.post(`${A}/provisions/${p2.id}/movements`, body),
    ])
    assert.sameMembers([x.status(), y.status()], [201, 422])
  })

  test('diferenças cambiais: não realizada ao câmbio de fecho e realizada depois da liquidação', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    // Venda de 100 USD a 900 ao cliente C1.
    await L.post({
      entryDate: '2026-03-10',
      currency: 'USD',
      exchangeRate: '900',
      lines: [
        { accountId: L.clients.id, debit: '100.00', thirdPartyRef: 'C1' },
        { accountId: L.sales.id, credit: '100.00' },
      ],
    })
    const accounts = {
      journalId: L.journal.id,
      unrealizedGainAccountId: L.fxGain.id,
      unrealizedLossAccountId: L.fxLoss.id,
      realizedGainAccountId: L.fxRealized.id,
      realizedLossAccountId: L.fxLoss.id,
    }
    const q = `legalEntityId=${L.le.id}&accountIds=${L.clients.id}`
    const missing = ok(await L.api.get(`${A}/fx-revaluations/preview?${q}&date=2026-03-31`), 200)
    assert.deepEqual(missing.missingRates, ['USD'])
    ok(
      await L.api.post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '950',
        validOn: '2026-03-31',
      })
    )
    const preview = ok(await L.api.get(`${A}/fx-revaluations/preview?${q}&date=2026-03-31`), 200)
    assert.lengthOf(preview.lines, 1)
    assert.include(preview.lines[0], {
      kind: 'UNREALIZED',
      thirdPartyRef: 'C1',
      foreignBalance: '100.00',
      functionalBefore: '90000.00',
      functionalAfter: '95000.00',
      difference: '5000.00',
    })
    const run = ok(
      await L.api.post(`${A}/fx-revaluations`, {
        legalEntityId: L.le.id,
        date: '2026-03-31',
        accountIds: [L.clients.id],
        ...accounts,
      })
    )
    const draft = ok(await L.api.get(`${A}/entries/${run.entryId}`), 200)
    assert.equal(draft.source, 'FX_REVALUATION')
    const line = (id: string) => draft.lines.find((l: any) => l.accountId === id)
    assert.equal(line(L.clients.id).debit, '5000.00')
    assert.equal(line(L.clients.id).thirdPartyRef, 'C1')
    assert.equal(line(L.fxGain.id).credit, '5000.00')
    // Outra actualização com esta por contabilizar contaria a diferença duas vezes.
    const pending = await L.api.post(`${A}/fx-revaluations`, {
      legalEntityId: L.le.id,
      date: '2026-04-01',
      accountIds: [L.clients.id],
      ...accounts,
    })
    assert.equal(pending.body().error.code, 'PENDING_REVALUATION')
    await L.postDraft(run.entryId)
    const same = await L.api.post(`${A}/fx-revaluations`, {
      legalEntityId: L.le.id,
      date: '2026-03-31',
      accountIds: [L.clients.id],
      ...accounts,
    })
    assert.equal(same.status(), 409)

    // Recebimento dos 100 USD a 960: saldo em moeda liquidado, resíduo funcional realizado.
    await L.post({
      entryDate: '2026-04-15',
      currency: 'USD',
      exchangeRate: '960',
      lines: [
        { accountId: L.cash.id, debit: '100.00' },
        { accountId: L.clients.id, credit: '100.00', thirdPartyRef: 'C1' },
      ],
    })
    const realized = ok(
      await L.api.post(`${A}/fx-revaluations`, {
        legalEntityId: L.le.id,
        date: '2026-04-30',
        accountIds: [L.clients.id],
        ...accounts,
      })
    )
    assert.lengthOf(realized.lines, 1)
    assert.include(realized.lines[0], {
      kind: 'REALIZED',
      foreignBalance: '0.00',
      functionalBefore: '-1000.00', // 90 000 + 5 000 − 96 000
      difference: '1000.00',
    })
    const e2 = ok(await L.api.get(`${A}/entries/${realized.entryId}`), 200)
    assert.equal(e2.lines.find((l: any) => l.accountId === L.fxRealized.id).credit, '1000.00')
    const list = ok(await L.api.get(`${A}/fx-revaluations?legalEntityId=${L.le.id}`), 200)
    assert.lengthOf(list, 2)
  })

  test('reconciliação: só linhas contabilizadas, da mesma conta e terceiro, que se anulam; uma vez', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const invoice = await L.post({
      entryDate: '2026-03-01',
      lines: [
        { accountId: L.rent.id, debit: '500.00' },
        { accountId: L.suppliers.id, credit: '500.00', thirdPartyRef: 'F1' },
      ],
    })
    const partial = await L.post({
      entryDate: '2026-03-10',
      lines: [
        { accountId: L.suppliers.id, debit: '300.00', thirdPartyRef: 'F1' },
        { accountId: L.cash.id, credit: '300.00' },
      ],
    })
    const rest = await L.post({
      entryDate: '2026-03-20',
      lines: [
        { accountId: L.suppliers.id, debit: '200.00', thirdPartyRef: 'F1' },
        { accountId: L.cash.id, credit: '200.00' },
      ],
    })
    const other = await L.post({
      entryDate: '2026-03-20',
      lines: [
        { accountId: L.suppliers.id, debit: '500.00', thirdPartyRef: 'F2' },
        { accountId: L.cash.id, credit: '500.00' },
      ],
    })
    const scope = `legalEntityId=${L.le.id}&accountId=${L.suppliers.id}`
    const open = ok(
      await L.api.get(`${A}/reconciliations/open-items?${scope}&thirdPartyRef=F1`),
      200
    )
    assert.lengthOf(open.items, 3)
    assert.equal(open.balance, '0.00')
    const ref = (e: any, line: number) => ({ entryId: e.id, lineNo: line })
    const base = { legalEntityId: L.le.id, accountId: L.suppliers.id }
    const unbalanced = await L.api.post(`${A}/reconciliations`, {
      ...base,
      lines: [ref(invoice, 2), ref(partial, 1)],
    })
    assert.equal(unbalanced.body().error.details[0].code, 'NOT_BALANCED')
    const mixed = await L.api.post(`${A}/reconciliations`, {
      ...base,
      lines: [ref(invoice, 2), ref(other, 1)],
    })
    assert.equal(mixed.body().error.details[0].code, 'THIRD_PARTY')
    const wrongAccount = await L.api.post(`${A}/reconciliations`, {
      ...base,
      lines: [ref(invoice, 1), ref(partial, 1)],
    })
    assert.equal(wrongAccount.body().error.details[0].code, 'OTHER_ACCOUNT')
    const rec = ok(
      await L.api.post(`${A}/reconciliations`, {
        ...base,
        note: 'Factura FT1 paga em duas vezes',
        lines: [ref(invoice, 2), ref(partial, 1), ref(rest, 1)],
      })
    )
    assert.equal(rec.lines, 3)
    const twice = await L.api.post(`${A}/reconciliations`, {
      ...base,
      lines: [ref(invoice, 2), ref(partial, 1), ref(rest, 1)],
    })
    assert.equal(twice.body().error.code, 'ALREADY_RECONCILED')
    const after = ok(await L.api.get(`${A}/reconciliations/open-items?${scope}`), 200)
    assert.lengthOf(after.items, 1) // só a de F2
    const groups = ok(await L.api.get(`${A}/reconciliations?${scope}`), 200)
    assert.equal(groups[0].total, '500.00')
    ;(await L.api.delete(`${A}/reconciliations/${rec.id}`)).assertStatus(204)
    const reopened = ok(await L.api.get(`${A}/reconciliations/open-items?${scope}`), 200)
    assert.lengthOf(reopened.items, 4)
    // Rascunhos não se reconciliam.
    const draft = ok(
      await L.api.post(`${A}/entries`, {
        legalEntityId: L.le.id,
        journalId: L.journal.id,
        entryDate: '2026-03-25',
        description: 'Rascunho',
        lines: [
          { accountId: L.suppliers.id, debit: '500.00', thirdPartyRef: 'F1' },
          { accountId: L.cash.id, credit: '500.00' },
        ],
      })
    )
    const notPosted = await L.api.post(`${A}/reconciliations`, {
      ...base,
      lines: [ref(invoice, 2), ref(draft, 1)],
    })
    assert.equal(notPosted.body().error.details[0].code, 'NOT_POSTED')
  })

  test('permissões: ler não gera regularizações nem reconcilia', async ({ client, assert }) => {
    const L = await setup(client)
    const role = await createRole(client, L.s, 'leitor_reg', ['accounting.read'])
    const R = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
    ;(await R.get(`${A}/adjustment-schedules`)).assertStatus(200)
    ;(await R.get(`${A}/provisions`)).assertStatus(200)
    ;(
      await R.post(`${A}/adjustments/generate`, { legalEntityId: L.le.id, upTo: '2026-03' })
    ).assertStatus(403)
    ;(await R.post(`${A}/reconciliations`, { legalEntityId: L.le.id })).assertStatus(403)
    ;(
      await R.get(
        `${A}/fx-revaluations/preview?legalEntityId=${L.le.id}&date=2026-03-31&accountIds=${L.clients.id}`
      )
    ).assertStatus(403)
    assert.isTrue(true)
  })
})
