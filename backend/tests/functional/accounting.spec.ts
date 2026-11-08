import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  type Session,
} from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'
const owner = () => db.connection('owner')

const entryBody = (L: Awaited<ReturnType<typeof ledger>>, amount = '1000.50', extra = {}) => ({
  legalEntityId: L.le.id,
  journalId: L.journal.id,
  entryDate: '2026-03-10',
  description: 'Venda a dinheiro',
  lines: [
    { accountId: L.cash.id, debit: amount },
    { accountId: L.sales.id, credit: amount },
  ],
  ...extra,
})

async function approver(client: any, s: Session) {
  const role = await createRole(client, s, 'revisor', [
    'accounting.read',
    'accounting.approve',
    'accounting.post',
    'accounting.reverse',
  ])
  return memberWithRoles(client, s, [role.id])
}

test.group('contabilidade | plano, exercícios e diários', (group) => {
  group.each.setup(() => cleanDatabase())

  test('hierarquia do plano, um plano activo por entidade, exercícios sem sobreposição e diário com série própria', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const { api } = L
    const wrongPrefix = await api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '21',
      name: 'Fora do pai',
      level: 'ACCOUNT',
      nature: 'ASSET',
      parentId: L.c1.id,
    })
    wrongPrefix.assertStatus(422)
    assert.equal(wrongPrefix.body().error.details[0].code, 'CODE_PREFIX')
    const underPostable = await api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '1111',
      name: 'Sob movimentável',
      level: 'SUBACCOUNT',
      nature: 'ASSET',
      parentId: L.cash.id,
    })
    assert.equal(underPostable.body().error.details[0].code, 'PARENT_POSTABLE')
    ;(
      await api.patch(`${A}/accounts/${L.c11.id}`, {
        expectedVersion: L.c11.version,
        postable: true,
      })
    ).assertStatus(422)
    assert.equal(L.sales.normalBalance, 'CREDIT')
    assert.equal(L.cash.normalBalance, 'DEBIT')
    assert.equal(L.chart.jurisdiction, 'AO')

    const second = await api.post(`${A}/charts`, {
      legalEntityId: L.le.id,
      code: 'PC2',
      name: 'Outro plano',
      jurisdiction: 'AO',
    })
    second.assertStatus(409)
    assert.equal(second.body().error.code, 'ACTIVE_CHART_EXISTS')

    const year = (await api.get(`${A}/fiscal-years/${L.year.id}`)).body().data
    assert.lengthOf(year.periods, 14)
    const overlap = await api.post(`${A}/fiscal-years`, {
      legalEntityId: L.le.id,
      code: '2026B',
      startDate: '2026-06-01',
      endDate: '2027-05-31',
    })
    overlap.assertStatus(409)
    assert.equal(overlap.body().error.code, 'FISCAL_YEAR_OVERLAP')

    const invoices = ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: L.le.id,
        documentType: 'INVOICE',
        code: 'FT',
      })
    )
    const badJournal = await api.post(`${A}/journals`, {
      legalEntityId: L.le.id,
      code: 'DV',
      name: 'Vendas',
      type: 'SALES',
      documentSeriesId: invoices.id,
    })
    assert.equal(badJournal.body().error.details[0].code, 'WRONG_SERIES')
  })
})

test.group('contabilidade | lançamentos', (group) => {
  group.each.setup(() => cleanDatabase())

  test('rascunho → submetido → aprovado → contabilizado; segregação de funções; imutável; estorno único', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const { api } = L
    const draft = ok(
      await api.post(`${A}/entries`, {
        ...entryBody(L),
        lines: [
          { accountId: L.cash.id, debit: '1000.50' },
          { accountId: L.sales.id, credit: '999' },
        ],
      })
    )
    assert.deepInclude(draft, { status: 'DRAFT', number: null, periodName: 'Mar 2026' })
    const unbalanced = await api.post(`${A}/entries/${draft.id}/submit`, {
      expectedVersion: draft.version,
    })
    unbalanced.assertStatus(422)
    assert.equal(unbalanced.body().error.details[0].code, 'UNBALANCED')

    const fixed = ok(
      await api.patch(`${A}/entries/${draft.id}`, {
        expectedVersion: draft.version,
        lines: entryBody(L).lines,
      }),
      200
    )
    assert.equal(fixed.totalDebit, '1000.50')
    const submitted = ok(
      await api.post(`${A}/entries/${draft.id}/submit`, { expectedVersion: fixed.version }),
      200
    )
    assert.equal(submitted.status, 'SUBMITTED')
    ;(
      await api.patch(`${A}/entries/${draft.id}`, {
        expectedVersion: submitted.version,
        description: 'x',
      })
    ).assertStatus(409)

    const self = await api.post(`${A}/entries/${draft.id}/approve`, {
      expectedVersion: submitted.version,
    })
    self.assertStatus(403)
    assert.equal(self.body().error.code, 'SEGREGATION_OF_DUTIES')

    const reviewer = await approver(client, L.s)
    const R = as(client, reviewer.session)
    const approved = ok(
      await R.post(`${A}/entries/${draft.id}/approve`, { expectedVersion: submitted.version }),
      200
    )
    const posted = ok(
      await R.post(`${A}/entries/${draft.id}/post`, { expectedVersion: approved.version }),
      200
    )
    assert.deepInclude(posted, { status: 'POSTED', number: 'DG/0001' })
    assert.deepEqual(
      posted.lines.map((l: any) => [l.accountCode, l.debitFunctional, l.creditFunctional]),
      [
        ['111', '1000.50', '0.00'],
        ['71', '0.00', '1000.50'],
      ]
    )

    // Imutável pela API e pela própria base de dados.
    ;(
      await api.patch(`${A}/entries/${draft.id}`, {
        expectedVersion: posted.version,
        description: 'Alterado',
      })
    ).assertStatus(409)
    ;(await api.delete(`${A}/entries/${draft.id}`)).assertStatus(409)
    await assert.rejects(
      () =>
        owner().rawQuery(`update journal_entries set description = 'x' where id = ?`, [draft.id]),
      /JOURNAL_ENTRY_IMMUTABLE/
    )
    await assert.rejects(
      () => owner().rawQuery(`update journal_lines set debit = 1 where entry_id = ?`, [draft.id]),
      /JOURNAL_ENTRY_IMMUTABLE/
    )

    // Estorno: só com permissão própria, troca os lados, numera na mesma série e só uma vez.
    ;(await api.post(`${A}/entries/${draft.id}/reverse`, { date: '2026-03-01' })).assertStatus(422)
    const reversal = ok(await R.post(`${A}/entries/${draft.id}/reverse`, { date: '2026-04-02' }))
    assert.deepInclude(reversal, {
      status: 'POSTED',
      number: 'DG/0002',
      reversalOfId: draft.id,
      periodName: 'Abr 2026',
    })
    assert.deepEqual(
      reversal.lines.map((l: any) => [l.accountCode, l.debit, l.credit]),
      [
        ['111', '0.00', '1000.50'],
        ['71', '1000.50', '0.00'],
      ]
    )
    const original = (await api.get(`${A}/entries/${draft.id}`)).body().data
    assert.equal(original.reversedById, reversal.id)
    ;(await R.post(`${A}/entries/${draft.id}/reverse`, { date: '2026-04-03' })).assertStatus(409)
    ;(await R.post(`${A}/entries/${reversal.id}/reverse`, { date: '2026-04-03' })).assertStatus(409)

    const events = (
      await api.get(`/api/v1/audit-events?entityType=journal_entry&entityId=${draft.id}`)
    )
      .body()
      .data.map((e: any) => e.action)
    assert.includeMembers(events, [
      'journal_entry.created',
      'journal_entry.submitted',
      'journal_entry.approved',
      'journal_entry.posted',
      'journal_entry.reversed',
    ])
  })

  test('período fechado: não se submete nem contabiliza; fechar exige nada pendente; reabrir exige motivo', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const { api } = L
    const year = (await api.get(`${A}/fiscal-years/${L.year.id}`)).body().data
    const march = year.periods.find((p: any) => p.name === 'Mar 2026')
    const pending = ok(await api.post(`${A}/entries`, entryBody(L)))
    ok(
      await api.post(`${A}/entries/${pending.id}/submit`, { expectedVersion: pending.version }),
      200
    )
    const blocked = await api.post(`${A}/periods/${march.id}/close`, {})
    blocked.assertStatus(409)
    assert.equal(blocked.body().error.code, 'CLOSE_BLOCKED')

    const april = year.periods.find((p: any) => p.name === 'Abr 2026')
    // Os períodos anteriores ainda abertos são um aviso: fechar exige reconhecê-lo.
    const warned = await api.post(`${A}/periods/${april.id}/close`, {})
    assert.equal(warned.body().error.code, 'CLOSE_WARNINGS')
    ok(await api.post(`${A}/periods/${april.id}/close`, { acknowledgeWarnings: true }), 200)
    const late = ok(await api.post(`${A}/entries`, entryBody(L, '10', { entryDate: '2026-04-15' })))
    const refused = await api.post(`${A}/entries/${late.id}/submit`, {
      expectedVersion: late.version,
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'PERIOD_CLOSED')
    ;(await api.post(`${A}/periods/${april.id}/reopen`, {})).assertStatus(422)
    ok(
      await api.post(`${A}/periods/${april.id}/reopen`, { reason: 'Correcção de classificação' }),
      200
    )
    ok(await api.post(`${A}/entries/${late.id}/submit`, { expectedVersion: late.version }), 200)

    // Período de regularizações escolhido explicitamente (data = último dia do exercício).
    const closing = year.periods.find((p: any) => p.kind === 'CLOSING')
    const adj = ok(
      await api.post(
        `${A}/entries`,
        entryBody(L, '5', { entryDate: '2026-12-31', periodId: closing.id })
      )
    )
    assert.equal(adj.periodId, closing.id)
    const wrong = await api.post(
      `${A}/entries`,
      entryBody(L, '5', { entryDate: '2026-12-30', periodId: closing.id })
    )
    assert.equal(wrong.body().error.details[0].code, 'NO_PERIOD')
    const noYear = await api.post(`${A}/entries`, entryBody(L, '5', { entryDate: '2027-01-05' }))
    assert.equal(noYear.body().error.details[0].code, 'NO_PERIOD')
  })

  test('idempotência: a mesma chave devolve o mesmo lançamento, também em pedidos simultâneos', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const body = entryBody(L, '50', { idempotencyKey: 'venda-42' })
    const [a, b] = await Promise.all([
      L.api.post(`${A}/entries`, body),
      L.api.post(`${A}/entries`, body),
    ])
    assert.sameMembers([a.status(), b.status()], [201, 200])
    assert.equal(a.body().data.id, b.body().data.id)
    const count = await owner().rawQuery(
      `select count(*)::int as n from journal_entries where idempotency_key = 'venda-42'`
    )
    assert.equal(count.rows[0].n, 1)
  })

  test('lista: ordenação no servidor (lista fechada) e intervalo de datas', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    ok(await L.api.post(`${A}/entries`, entryBody(L, '300', { entryDate: '2026-01-15' })))
    ok(await L.api.post(`${A}/entries`, entryBody(L, '100', { entryDate: '2026-03-10' })))
    ok(await L.api.post(`${A}/entries`, entryBody(L, '200', { entryDate: '2026-02-20' })))
    const list = async (qs: string) => {
      const r = await L.api.get(`${A}/entries?${qs}`)
      r.assertStatus(200)
      return r.body()
    }
    const byDefault = await list('')
    assert.deepEqual(
      byDefault.data.map((e: any) => e.entryDate),
      ['2026-03-10', '2026-02-20', '2026-01-15']
    )
    const byAmount = await list('sort=totalDebit&direction=asc')
    assert.deepEqual(
      byAmount.data.map((e: any) => e.totalDebit),
      ['100.00', '200.00', '300.00']
    )
    const ranged = await list('dateFrom=2026-02-01&dateTo=2026-03-01')
    assert.equal(ranged.meta.total, 1)
    assert.equal(ranged.data[0].entryDate, '2026-02-20')
    ;(await L.api.get(`${A}/entries?sort=description;drop`)).assertStatus(422)
    ;(await L.api.get(`${A}/entries?dateFrom=10-02-2026`)).assertStatus(422)
  })

  test('moeda estrangeira: câmbio indicado ou o em vigor, totais na moeda funcional', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const usd = ok(
      await L.api.post(
        `${A}/entries`,
        entryBody(L, '100.25', { currency: 'USD', exchangeRate: '912.5' })
      )
    )
    assert.deepInclude(usd, {
      currency: 'USD',
      exchangeRate: '912.5000000000',
      totalDebit: '91478.13',
    })
    const missing = await L.api.post(`${A}/entries`, entryBody(L, '1', { currency: 'EUR' }))
    assert.equal(missing.body().error.details[0].code, 'RATE_NOT_FOUND')
    ok(
      await L.api.post('/api/v1/exchange-rates', {
        fromCurrency: 'EUR',
        toCurrency: 'AOA',
        rate: '1000',
        validOn: '2026-01-01',
      })
    )
    const eur = ok(await L.api.post(`${A}/entries`, entryBody(L, '2', { currency: 'EUR' })))
    assert.deepInclude(eur, { exchangeRate: '1000.0000000000', totalCredit: '2000.00' })
    ;(await L.api.post(`${A}/entries`, entryBody(L, '1', { exchangeRate: '2' }))).assertStatus(422)
  })

  test('permissões: ler não chega para criar; contas e centros de custo de outra entidade são recusados', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const role = await createRole(client, L.s, 'leitor_cont', ['accounting.read'])
    const reader = await memberWithRoles(client, L.s, [role.id])
    const R = as(client, reader.session)
    ;(await R.get(`${A}/entries`)).assertStatus(200)
    ;(await R.post(`${A}/entries`, entryBody(L))).assertStatus(403)
    ;(
      await R.post(`${A}/charts`, {
        legalEntityId: L.le.id,
        code: 'X',
        name: 'X',
        jurisdiction: 'AO',
      })
    ).assertStatus(403)

    const le2 = ok(
      await L.api.post('/api/v1/organization/legal-entities', {
        code: 'LE2',
        legalName: 'Entidade Dois, Lda.',
        taxId: '5000000002',
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    )
    const cc = ok(
      await L.api.post('/api/v1/organization/cost-centers', {
        code: 'CC2',
        name: 'Centro dois',
        legalEntityId: le2.id,
      })
    )
    const res = await L.api.post(`${A}/entries`, {
      ...entryBody(L),
      lines: [
        { accountId: L.cash.id, debit: '1', costCenterId: cc.id },
        { accountId: L.sales.id, credit: '1' },
      ],
    })
    assert.equal(res.body().error.details[0].path, 'lines.0.costCenterId')
  })
})
