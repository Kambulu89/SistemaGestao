import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { postAccountingEvent } from '#modules/accounting/index'
import { cleanDatabase, createRole, memberWithRoles, as } from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

const A = '/api/v1/accounting'
const owner = () => db.connection('owner')

/** Plano do ledger + conta de imposto (24) e uma regra de venda: total a débito, líquido e imposto a crédito. */
async function setup(client: any, ruleExtra: Record<string, unknown> = {}) {
  const L = await ledger(client)
  const c2 = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '2',
      name: 'Terceiros',
      level: 'CLASS',
      nature: 'LIABILITY',
      parentId: null,
    })
  )
  const tax = ok(
    await L.api.post(`${A}/accounts`, {
      chartId: L.chart.id,
      code: '24',
      name: 'Imposto',
      level: 'ACCOUNT',
      nature: 'LIABILITY',
      parentId: c2.id,
      postable: true,
    })
  )
  const rule = ok(
    await L.api.post(`${A}/posting-rules`, {
      legalEntityId: L.le.id,
      code: 'VENDA',
      name: 'Venda a dinheiro',
      source: 'sales_invoice',
      event: 'issued',
      journalId: L.journal.id,
      autoPost: true,
      descriptionTemplate: 'Factura {sourceRef}',
      validFrom: '2026-01-01',
      lines: [
        { side: 'DEBIT', accountId: L.cash.id, amountKey: 'total', useEventThirdParty: true },
        { side: 'CREDIT', accountId: L.sales.id, amountKey: 'net' },
        { side: 'CREDIT', accountId: tax.id, amountKey: 'tax' },
      ],
      ...ruleExtra,
    })
  )
  return { ...L, tax, rule }
}

const event = (L: any, extra: Record<string, unknown> = {}) => ({
  legalEntityId: L.le.id,
  source: 'SALES_INVOICE',
  event: 'ISSUED',
  sourceRef: 'FT 2026/1',
  occurredOn: '2026-03-15',
  amounts: { total: '114.00', net: '100.00', tax: '14.00' },
  thirdPartyRef: '5000999999',
  ...extra,
})

test.group('contabilidade | motor de contabilização', (group) => {
  group.each.setup(() => cleanDatabase())

  test('regras: contas da empresa, débito e crédito, sem sobreposição de vigência, versão nova depois de usada', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    assert.deepInclude(L.rule, { source: 'SALES_INVOICE', event: 'ISSUED', inUse: false })
    assert.lengthOf(L.rule.lines, 3)
    const oneSided = await L.api.post(`${A}/posting-rules`, {
      legalEntityId: L.le.id,
      code: 'X',
      name: 'Só débito',
      source: 'OTHER',
      event: 'DONE',
      journalId: L.journal.id,
      validFrom: '2026-01-01',
      lines: [
        { side: 'DEBIT', accountId: L.cash.id, amountKey: 'a' },
        { side: 'DEBIT', accountId: L.c11.id, amountKey: 'b' },
      ],
    })
    assert.sameMembers(
      oneSided.body().error.details.map((d: any) => d.code),
      ['ONE_SIDED', 'NOT_POSTABLE']
    )
    const overlap = await L.api.post(`${A}/posting-rules`, {
      legalEntityId: L.le.id,
      code: 'VENDA2',
      name: 'Outra',
      source: 'SALES_INVOICE',
      event: 'ISSUED',
      journalId: L.journal.id,
      validFrom: '2026-06-01',
      lines: [
        { side: 'DEBIT', accountId: L.cash.id, amountKey: 'total' },
        { side: 'CREDIT', accountId: L.sales.id, amountKey: 'total' },
      ],
    })
    overlap.assertStatus(409)
    assert.equal(overlap.body().error.code, 'RULE_OVERLAP')

    ok(await L.api.post(`${A}/posting-events`, event(L)))
    const inUse = await L.api.patch(`${A}/posting-rules/${L.rule.id}`, {
      expectedVersion: L.rule.version,
      lines: L.rule.lines.slice(0, 2),
    })
    assert.equal(inUse.body().error.details[0].code, 'RULE_IN_USE')
    // Nova versão: fecha-se a vigência da actual e cria-se outra a partir do dia seguinte.
    ok(
      await L.api.patch(`${A}/posting-rules/${L.rule.id}`, {
        expectedVersion: L.rule.version,
        validTo: '2026-05-31',
      }),
      200
    )
    ok(
      await L.api.post(`${A}/posting-rules`, {
        legalEntityId: L.le.id,
        code: 'VENDA_V2',
        name: 'Venda (sem imposto separado)',
        source: 'SALES_INVOICE',
        event: 'ISSUED',
        journalId: L.journal.id,
        autoPost: true,
        validFrom: '2026-06-01',
        lines: [
          { side: 'DEBIT', accountId: L.cash.id, amountKey: 'total' },
          { side: 'CREDIT', accountId: L.sales.id, amountKey: 'total' },
        ],
      })
    )
    const june = ok(
      await L.api.post(
        `${A}/posting-events`,
        event(L, { sourceRef: 'FT 2026/2', occurredOn: '2026-06-02' })
      )
    )
    assert.equal(june.ruleCode, 'VENDA_V2')
  })

  test('evento contabilizado automaticamente, numerado e idempotente (também em simultâneo)', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const body = event(L)
    const [a, b] = await Promise.all([
      L.api.post(`${A}/posting-events`, body),
      L.api.post(`${A}/posting-events`, body),
    ])
    assert.sameMembers([a.status(), b.status()], [201, 200])
    const processed = a.status() === 201 ? a.body().data : b.body().data
    assert.deepInclude(processed, {
      status: 'POSTED',
      entryStatus: 'POSTED',
      entryNumber: 'DG/0001',
      ruleCode: 'VENDA',
      attempts: 1,
    })
    const entry = (await L.api.get(`${A}/entries/${processed.entryId}`)).body().data
    assert.deepInclude(entry, {
      source: 'SALES_INVOICE',
      description: 'Factura FT 2026/1',
      reference: 'FT 2026/1',
      totalDebit: '114.00',
    })
    assert.deepEqual(
      entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit, l.thirdPartyRef]),
      [
        ['111', '114.00', '0.00', '5000999999'],
        ['71', '0.00', '100.00', null],
        ['24', '0.00', '14.00', null],
      ]
    )
    const count = await owner().rawQuery(
      `select count(*)::int as n from journal_entries where source = 'SALES_INVOICE'`
    )
    assert.equal(count.rows[0].n, 1)

    // Imposto zero: a linha não é gerada.
    const zero = ok(
      await L.api.post(
        `${A}/posting-events`,
        event(L, { sourceRef: 'FT 2026/3', amounts: { total: '50', net: '50', tax: '0' } })
      )
    )
    const zeroEntry = (await L.api.get(`${A}/entries/${zero.entryId}`)).body().data
    assert.lengthOf(zeroEntry.lines, 2)
  })

  test('falhas ficam registadas com a mensagem e reprocessam-se depois de corrigida a causa', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const unbalanced = await L.api.post(
      `${A}/posting-events`,
      event(L, { amounts: { total: '114.00', net: '100.00', tax: '10.00' } })
    )
    unbalanced.assertStatus(422)
    assert.equal(unbalanced.body().error.details[0].code, 'UNBALANCED')
    const noRule = await L.api.post(
      `${A}/posting-events`,
      event(L, { source: 'PURCHASE_INVOICE', sourceRef: 'FC 1' })
    )
    assert.equal(noRule.body().error.details[0].code, 'NO_RULE')
    const failed = (await L.api.get(`${A}/posting-events?status=FAILED`)).body().data
    assert.lengthOf(failed, 2)
    const purchase = failed.find((f: any) => f.source === 'PURCHASE_INVOICE')
    assert.equal(purchase.error.details[0].code, 'NO_RULE')
    assert.isNull(purchase.entryId)

    ok(
      await L.api.post(`${A}/posting-rules`, {
        legalEntityId: L.le.id,
        code: 'COMPRA',
        name: 'Compra',
        source: 'PURCHASE_INVOICE',
        event: 'ISSUED',
        journalId: L.journal.id,
        validFrom: '2026-01-01',
        lines: [
          { side: 'DEBIT', accountId: L.sales.id, amountKey: 'total' },
          { side: 'CREDIT', accountId: L.cash.id, amountKey: 'total' },
        ],
      })
    )
    const retried = ok(await L.api.post(`${A}/posting-events/${purchase.id}/retry`), 200)
    // Sem contabilização automática: fica em rascunho e segue o fluxo normal de aprovação.
    assert.deepInclude(retried, { status: 'DRAFTED', entryStatus: 'DRAFT', attempts: 2 })
    ;(await L.api.post(`${A}/posting-events/${retried.id}/retry`)).assertStatus(409)
    const events = (
      await L.api.get(`/api/v1/audit-events?entityType=posting_event&entityId=${purchase.id}`)
    ).body().data
    assert.includeMembers(
      events.map((e: any) => e.action),
      ['posting_event.failed', 'posting_event.processed']
    )
  })

  test('contrato entre módulos: na transacção de quem chama (se falhar depois, nada fica)', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const ctx = (await L.api.get('/api/v1/context')).body().data
    const context = {
      tenantId: ctx.tenant.id,
      userId: L.adminId,
      membershipId: ctx.membershipId,
      requestId: 'teste',
    }
    await assert.rejects(() =>
      runInTenant(context as never, async (scope) => {
        await postAccountingEvent(scope, event(L, { sourceRef: 'FT ROLLBACK' }))
        throw new Error('a factura falhou depois')
      })
    )
    const n = await owner().rawQuery(
      `select count(*)::int as n from posting_events where source_ref = 'FT ROLLBACK'`
    )
    assert.equal(n.rows[0].n, 0)
    const done = await runInTenant(context as never, (scope) =>
      postAccountingEvent(scope, event(L, { sourceRef: 'FT OK' }))
    )
    assert.equal((done.event as any).status, 'POSTED')
  })

  test('simulação sem gravar; permissões: ler simula, só quem contabiliza envia eventos', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const sim = ok(await L.api.post(`${A}/posting-events/simulate`, event(L)), 200)
    assert.deepEqual(sim.issues, [])
    assert.deepEqual(
      sim.lines.map((l: any) => l.accountCode),
      ['111', '71', '24']
    )
    const bad = ok(
      await L.api.post(
        `${A}/posting-events/simulate`,
        event(L, { amounts: { total: '1', net: '2', tax: '0' } })
      ),
      200
    )
    assert.equal(bad.issues[0].code, 'UNBALANCED')
    const count = await owner().rawQuery('select count(*)::int as n from posting_events')
    assert.equal(count.rows[0].n, 0)

    const role = await createRole(client, L.s, 'leitor_motor', ['accounting.read'])
    const reader = await memberWithRoles(client, L.s, [role.id])
    const R = as(client, reader.session)
    ;(await R.post(`${A}/posting-events/simulate`, event(L))).assertStatus(200)
    ;(await R.post(`${A}/posting-events`, event(L))).assertStatus(403)
    ;(await R.post(`${A}/posting-rules`, {})).assertStatus(403)
  })
})
