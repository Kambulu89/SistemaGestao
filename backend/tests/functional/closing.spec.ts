import { test } from '@japa/runner'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger as setupLedger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'

/**
 * Exercício 2026 com capital 1 000, venda 500 a dinheiro, gasto 200 pago e gasto 100 a crédito do fornecedor F1:
 * resultado 200 (lucro); caixa 1 300; fornecedores 100. Exercício 2027 criado para receber o transporte.
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
  const c2 = await account('2', 'CLASS', 'LIABILITY', null)
  const suppliers = await account('22', 'ACCOUNT', 'LIABILITY', c2.id)
  const c5 = await account('5', 'CLASS', 'EQUITY', null)
  const capital = await account('51', 'ACCOUNT', 'EQUITY', c5.id)
  const result = await account('59', 'ACCOUNT', 'EQUITY', c5.id)
  const c6 = await account('6', 'CLASS', 'EXPENSE', null)
  const expenses = await account('62', 'ACCOUNT', 'EXPENSE', c6.id)
  const role = await createRole(client, L.s, 'rev_fecho', [
    'accounting.read',
    'accounting.approve',
    'accounting.post',
  ])
  const reviewer = as(client, (await memberWithRoles(client, L.s, [role.id])).session)
  const draft = async (debit: string, credit: string, amount: string, extra: any = {}) =>
    ok(
      await L.api.post(`${A}/entries`, {
        legalEntityId: L.le.id,
        journalId: L.journal.id,
        entryDate: '2026-03-10',
        description: 'Movimento',
        lines: [
          { accountId: debit, debit: amount },
          { accountId: credit, credit: amount, ...extra },
        ],
      })
    )
  const approve = async (e: any) => {
    const s = ok(
      await L.api.post(`${A}/entries/${e.id}/submit`, { expectedVersion: e.version }),
      200
    )
    return ok(
      await reviewer.post(`${A}/entries/${e.id}/approve`, { expectedVersion: s.version }),
      200
    )
  }
  const post = async (debit: string, credit: string, amount: string, extra: any = {}) => {
    const a = await approve(await draft(debit, credit, amount, extra))
    return ok(await reviewer.post(`${A}/entries/${a.id}/post`, { expectedVersion: a.version }), 200)
  }
  await post(L.cash.id, capital.id, '1000.00')
  await post(L.cash.id, L.sales.id, '500.00')
  await post(expenses.id, L.cash.id, '200.00')
  await post(expenses.id, suppliers.id, '100.00', { thirdPartyRef: 'F1' })
  const next = ok(
    await L.api.post(`${A}/fiscal-years`, {
      legalEntityId: L.le.id,
      code: '2027',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
    })
  )
  const periods = async (yearId: string) =>
    ok(await L.api.get(`${A}/fiscal-years/${yearId}`), 200).periods as any[]
  /** Fecha por ordem todos os períodos menos o de regularizações (reconhecendo os avisos). */
  const closeAll = async (yearId: string) => {
    for (const p of await periods(yearId))
      if (p.kind !== 'CLOSING' && p.status === 'OPEN')
        ok(await L.api.post(`${A}/periods/${p.id}/close`, { acknowledgeWarnings: true }), 200)
  }
  return {
    ...L,
    suppliers,
    capital,
    result,
    expenses,
    reviewer,
    draft,
    approve,
    post,
    next,
    periods,
    closeAll,
  }
}

const codes = (r: any) => (r.body().error.details ?? []).map((d: any) => d.code)

test.group('contabilidade | fecho', (group) => {
  group.each.setup(() => cleanDatabase())

  test('checklist do período: bloqueios, avisos reconhecidos e tarefas manuais', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const march = (await L.periods(L.year.id)).find((p) => p.name === 'Mar 2026')
    const april = (await L.periods(L.year.id)).find((p) => p.name === 'Abr 2026')
    const stray = await L.draft(L.expenses.id, L.cash.id, '10.00')
    const pending = await L.approve(await L.draft(L.expenses.id, L.cash.id, '20.00'))
    ok(await L.api.post(`${A}/periods/${march.id}/tasks`, { title: 'Conciliar o banco' }))
    const dup = await L.api.post(`${A}/periods/${march.id}/tasks`, { title: 'Conciliar o banco' })
    assert.equal(dup.body().error.code, 'TASK_EXISTS')

    const cl = ok(await L.api.get(`${A}/periods/${march.id}/checklist`), 200)
    const status = Object.fromEntries(cl.items.map((i: any) => [i.code, i.status]))
    assert.include(status, {
      PENDING_ENTRIES: 'BLOCKING',
      UNBALANCED: 'OK',
      DRAFT_ENTRIES: 'WARNING',
      FAILED_EVENTS: 'OK',
      DEPRECIATION_DUE: 'OK',
      EARLIER_OPEN: 'WARNING',
      TASKS_OPEN: 'WARNING',
    })
    assert.isFalse(cl.canClose)

    const blocked = await L.api.post(`${A}/periods/${march.id}/close`, {
      acknowledgeWarnings: true,
    })
    assert.equal(blocked.body().error.code, 'CLOSE_BLOCKED')
    ok(
      await L.reviewer.post(`${A}/entries/${pending.id}/post`, {
        expectedVersion: pending.version,
      }),
      200
    )
    const warned = await L.api.post(`${A}/periods/${march.id}/close`, {})
    assert.equal(warned.body().error.code, 'CLOSE_WARNINGS')
    assert.sameMembers(codes(warned), ['DRAFT_ENTRIES', 'EARLIER_OPEN', 'TASKS_OPEN'])

    ;(await L.api.delete(`${A}/entries/${stray.id}`)).assertStatus(204)
    const task = cl.tasks.length
      ? cl.tasks[0]
      : (await L.api.get(`${A}/periods/${march.id}/checklist`)).body().data.tasks[0]
    ok(
      await L.api.patch(`${A}/close-tasks/${task.id}`, {
        expectedVersion: task.version,
        done: true,
        note: 'Extracto de Março conferido',
      }),
      200
    )
    const closed = ok(
      await L.api.post(`${A}/periods/${march.id}/close`, { acknowledgeWarnings: true }),
      200
    )
    assert.equal(closed.find((p: any) => p.id === march.id).status, 'CLOSED')
    const after = ok(await L.api.get(`${A}/periods/${march.id}/checklist`), 200)
    const locked = await L.api.patch(`${A}/close-tasks/${after.tasks[0].id}`, {
      expectedVersion: after.tasks[0].version,
      done: false,
    })
    assert.equal(locked.body().error.code, 'PERIOD_CLOSED')

    // As tarefas copiam-se para o período seguinte (por concluir).
    const copied = ok(await L.api.post(`${A}/periods/${april.id}/tasks/copy`), 200)
    assert.deepEqual(
      copied.map((t: any) => [t.title, t.done]),
      [['Conciliar o banco', false]]
    )
  })

  test('encerramento: apura o resultado, transporta os saldos, bloqueia e reabre com estornos', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const body = {
      resultAccountId: L.result.id,
      journalId: L.journal.id,
      nextFiscalYearId: L.next.id,
      acknowledgeWarnings: true,
    }
    const early = await L.api.post(`${A}/fiscal-years/${L.year.id}/close`, body)
    assert.equal(early.body().error.code, 'PERIODS_OPEN')
    await L.closeAll(L.year.id)
    const notEquity = await L.api.post(`${A}/fiscal-years/${L.year.id}/close`, {
      ...body,
      resultAccountId: L.cash.id,
    })
    assert.equal(notEquity.body().error.details[0].code, 'NOT_EQUITY')

    const status = ok(await L.api.get(`${A}/fiscal-years/${L.year.id}/closing`), 200)
    assert.equal(status.netResult, '200.00')
    assert.deepEqual(status.openPeriods, [])

    const done = ok(await L.api.post(`${A}/fiscal-years/${L.year.id}/close`, body), 200)
    assert.equal(done.netResult, '200.00')
    const closingEntry = ok(await L.api.get(`${A}/entries/${done.closingEntryId}`), 200)
    const lines = (e: any) =>
      Object.fromEntries(
        e.lines.map((l: any) => [
          `${l.accountId}|${l.thirdPartyRef ?? ''}`,
          /[1-9]/.test(l.debit ?? '') ? l.debit : `-${l.credit}`,
        ])
      )
    assert.deepEqual(lines(closingEntry), {
      [`${L.sales.id}|`]: '500.00',
      [`${L.expenses.id}|`]: '-300.00',
      [`${L.result.id}|`]: '-200.00',
    })
    assert.equal(closingEntry.status, 'POSTED')
    const opening = ok(await L.api.get(`${A}/entries/${done.openingEntryId}`), 200)
    assert.equal(opening.entryDate, '2027-01-01')
    assert.equal(opening.periodName, 'Abertura')
    assert.deepEqual(lines(opening), {
      [`${L.cash.id}|`]: '1300.00',
      [`${L.suppliers.id}|F1`]: '-100.00',
      [`${L.capital.id}|`]: '-1000.00',
      [`${L.result.id}|`]: '-200.00',
    })

    // Encerrado: nada mais entra em 2026 e os lançamentos do encerramento não se estornam à mão.
    const late = await L.draft(L.expenses.id, L.cash.id, '1.00')
    const refused = await L.api.post(`${A}/entries/${late.id}/submit`, {
      expectedVersion: late.version,
    })
    assert.equal(refused.body().error.code, 'PERIOD_CLOSED')
    const manual = await L.api.post(`${A}/entries/${done.closingEntryId}/reverse`, {
      date: '2026-12-31',
    })
    assert.equal(manual.body().error.code, 'MANAGED_BY_YEAR_CLOSE')
    const twice = await L.api.post(`${A}/fiscal-years/${L.year.id}/close`, body)
    assert.equal(twice.body().error.code, 'YEAR_ALREADY_CLOSED')

    // Reabrir: motivo obrigatório, estorna o transporte e o apuramento; o histórico fica.
    const noReason = await L.api.post(`${A}/fiscal-years/${L.year.id}/reopen`, {})
    assert.equal(noReason.status(), 422)
    const reopened = ok(
      await L.api.post(`${A}/fiscal-years/${L.year.id}/reopen`, {
        reason: 'Factura de Dezembro em falta',
      }),
      200
    )
    assert.lengthOf(reopened.reversals, 2)
    const st = ok(await L.api.get(`${A}/fiscal-years/${L.year.id}/closing`), 200)
    assert.equal(st.fiscalYear.status, 'OPEN')
    assert.equal(st.netResult, '200.00')
    assert.deepEqual(
      st.history.map((h: any) => h.status),
      ['REVERSED']
    )
    // Pode voltar a encerrar (o período de regularizações foi reaberto; os mensais continuam fechados).
    ok(await L.api.post(`${A}/fiscal-years/${L.year.id}/close`, body), 200)

    // Com a abertura de 2027 fechada, 2026 não reabre (o transporte não se estorna).
    const opening2027 = (await L.periods(L.next.id)).find((p) => p.kind === 'OPENING')
    ok(await L.api.post(`${A}/periods/${opening2027.id}/close`, { acknowledgeWarnings: true }), 200)
    const stuck = await L.api.post(`${A}/fiscal-years/${L.year.id}/reopen`, {
      reason: 'Outra correcção',
    })
    assert.equal(stuck.body().error.code, 'NEXT_OPENING_CLOSED')
  })

  test('concorrência: dois encerramentos e contabilizar enquanto se fecha o período', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const march = (await L.periods(L.year.id)).find((p) => p.name === 'Mar 2026')
    for (let i = 0; i < 3; i++) {
      const a = await L.approve(await L.draft(L.expenses.id, L.cash.id, '5.00'))
      const [posted, closed] = await Promise.all([
        L.reviewer.post(`${A}/entries/${a.id}/post`, { expectedVersion: a.version }),
        L.api.post(`${A}/periods/${march.id}/close`, { acknowledgeWarnings: true }),
      ])
      // Ou contabiliza antes do fecho (e fecha), ou o fecho vê o aprovado pendente e recusa; nunca fica um
      // lançamento contabilizado num período fechado depois de o fechar.
      assert.equal(posted.status(), 200)
      assert.oneOf(closed.status(), [200, 409])
      if (closed.status() === 200)
        ok(
          await L.api.post(`${A}/periods/${march.id}/reopen`, { reason: 'Teste de concorrência' }),
          200
        )
    }
    await L.closeAll(L.year.id)
    const body = {
      resultAccountId: L.result.id,
      journalId: L.journal.id,
      acknowledgeWarnings: true,
    }
    const [x, y] = await Promise.all([
      L.api.post(`${A}/fiscal-years/${L.year.id}/close`, body),
      L.api.post(`${A}/fiscal-years/${L.year.id}/close`, body),
    ])
    assert.sameMembers([x.status(), y.status()], [200, 409])
    const st = ok(await L.api.get(`${A}/fiscal-years/${L.year.id}/closing`), 200)
    assert.lengthOf(st.history, 1)
  })

  test('permissões: ler a checklist, encerrar e reabrir são separadas', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const reader = await createRole(client, L.s, 'leitor_fecho', ['accounting.read'])
    const closer = await createRole(client, L.s, 'fecho', ['accounting.read', 'accounting.close'])
    const R = as(client, (await memberWithRoles(client, L.s, [reader.id])).session)
    const C = as(client, (await memberWithRoles(client, L.s, [closer.id])).session)
    const march = (await L.periods(L.year.id)).find((p) => p.name === 'Mar 2026')
    ;(await R.get(`${A}/periods/${march.id}/checklist`)).assertStatus(200)
    ;(await R.get(`${A}/fiscal-years/${L.year.id}/closing`)).assertStatus(200)
    ;(await R.post(`${A}/periods/${march.id}/tasks`, { title: 'Tarefa' })).assertStatus(403)
    ;(await R.post(`${A}/fiscal-years/${L.year.id}/close`, {})).assertStatus(403)
    ;(await C.post(`${A}/periods/${march.id}/tasks`, { title: 'Tarefa' })).assertStatus(201)
    ;(
      await C.post(`${A}/fiscal-years/${L.year.id}/reopen`, { reason: 'Sem permissão' })
    ).assertStatus(403)
    assert.isTrue(true)
  })
})
