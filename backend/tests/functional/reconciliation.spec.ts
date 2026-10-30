import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const MODULES = ['catalog', 'customers', 'orders', 'inventory', 'invoicing', 'finance']

/** Tenant com facturação e finanças: uma organização, um cliente, duas contas bancárias e uma de caixa. */
async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, MODULES)
  for (const code of MODULES) {
    const enabled = await http.post(`/api/v1/tenant/modules/${code}/enable`, {})
    if (enabled.status() !== 200) throw new Error(`${code}: ${JSON.stringify(enabled.body())}`)
  }
  const org = await must<any>(
    await http.post('/api/v1/organizations', {
      code: 'EMP',
      legalName: 'Empresa, Lda.',
      countryCode: 'AO',
      baseCurrency: 'AOA',
    }),
    201
  )
  for (const [documentType, prefixTemplate] of [
    ['INVOICE', 'FT {SERIES}/{YYYY}/'],
    ['CREDIT_NOTE', 'NC {SERIES}/{YYYY}/'],
  ] as const) {
    await must(
      await http.post('/api/v1/sequences', {
        organizationId: org.id,
        documentType,
        series: 'A',
        prefixTemplate,
      }),
      201
    )
  }
  const party = await must<any>(
    await http.post('/api/v1/organization-parties', {
      legalName: 'Acme, Lda.',
      taxCountry: 'AO',
      taxId: '5000012345',
    }),
    201
  )
  await must(
    await http.post(`/api/v1/parties/${party.id}/addresses`, {
      type: 'BILLING',
      line1: 'Rua Direita 1',
      city: 'Luanda',
      countryCode: 'AO',
      isPrimary: true,
    }),
    201
  )
  const customer = await must<any>(
    await http.post('/api/v1/customers', {
      partyId: party.id,
      organizationId: org.id,
      code: 'CLI-001',
      paymentTermDays: 15,
    }),
    201
  )
  const account = async (code: string, type: 'BANK' | 'CASH') =>
    must<any>(
      await http.post('/api/v1/treasury-accounts', {
        organizationId: org.id,
        code,
        name: code,
        type,
      }),
      201
    )
  const bank = await account('BAI', 'BANK')
  const other = await account('BFA', 'BANK')
  const cash = await account('CAIXA', 'CASH')
  return { client, tenant, admin, http, org, party, customer, bank, other, cash }
}

type Ctx = Awaited<ReturnType<typeof setup>>

/** Um recebimento confirmado na conta: factura sem imposto do valor pedido, paga por inteiro. Devolve o movimento. */
async function receipt(
  ctx: Ctx,
  amount: string,
  options: { account?: string; occurredOn?: string; reference?: string } = {}
) {
  const invoice = await must<any>(
    await ctx.http.post('/api/v1/invoices', {
      organizationId: ctx.org.id,
      customerId: ctx.customer.id,
      lines: [
        {
          description: 'Serviço',
          quantity: '1',
          unitPrice: amount,
          taxRate: '0',
          exemptionReason: 'Isento',
        },
      ],
    }),
    201
  )
  await must(await ctx.http.post(`/api/v1/invoices/${invoice.id}/issue`, {}), 200)
  const receivables = await must<any[]>(await ctx.http.get('/api/v1/receivables?limit=200'), 200)
  const receivable = receivables.find((r) => r.sourceId === invoice.id)
  const accountId = options.account ?? ctx.bank.id
  const payment = await must<any>(
    await ctx.http.post('/api/v1/payments', {
      organizationId: ctx.org.id,
      direction: 'INBOUND',
      partyId: ctx.party.id,
      treasuryAccountId: accountId,
      amount,
      occurredOn: options.occurredOn ?? '2026-10-10',
      reference: options.reference,
      allocations: [{ receivableId: receivable.id, amount }],
    }),
    201
  )
  await must(await ctx.http.post(`/api/v1/payments/${payment.id}/confirm`, {}), 200)
  const entries = await must<any[]>(
    await ctx.http.get(`/api/v1/treasury-accounts/${accountId}/entries`),
    200
  )
  return entries.find((e) => e.paymentId === payment.id) as { id: string }
}

const importLines = (ctx: Ctx, lines: unknown[], accountId = ctx.bank.id) =>
  ctx.http.post('/api/v1/reconciliations/imports', { accountId, fileName: 'extracto.csv', lines })

const lineList = async (ctx: Ctx, query = '', accountId = ctx.bank.id) =>
  must<any[]>(
    await ctx.http.get(`/api/v1/reconciliations/lines?accountId=${accountId}${query}`),
    200
  )

const match = (ctx: Ctx, statementLineId: string, treasuryEntryId: string, amount?: string) =>
  ctx.http.post('/api/v1/reconciliations/matches', {
    statementLineId,
    treasuryEntryId,
    ...(amount ? { amount } : {}),
  })

const owner = <T>(sql: string, tenant: Tenant) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

async function memberWith(ctx: { client: any; tenant: Tenant; http: Http }, permissions: string[]) {
  const actor = await newActor(ctx.client, ctx.tenant)
  const role = await must<{ id: string }>(
    await ctx.http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await ctx.http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return api(ctx.client, ctx.tenant, actor)
}

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

const hooks = (group: any) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })
}

test.group('conciliação | importação do extracto', (group) => {
  hooks(group)

  test('importa, ignora o que já foi importado e mantém linhas iguais do mesmo ficheiro', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const lines = [
      { occurredOn: '2026-10-10', amount: '100', description: 'Transferência Acme' },
      { occurredOn: '2026-10-11', amount: '-25.5', description: 'Comissão' },
      { occurredOn: '2026-10-11', amount: '-25.5', description: 'Comissão' },
    ]
    const first = await must<any>(await importLines(ctx, lines), 201)
    assert.equal(first.imported, 3)
    assert.equal(first.skipped, 0)
    const stored = await lineList(ctx)
    assert.lengthOf(stored, 3)
    assert.sameMembers(
      stored.map((l) => l.amountSigned),
      ['100.0000', '-25.5000', '-25.5000']
    )
    assert.isTrue(stored.every((l) => l.state === 'UNMATCHED' && l.matched === '0.0000'))

    const again = await importLines(ctx, lines)
    assert.equal(again.status(), 200)
    assert.deepInclude(again.body().data, { batch: null, imported: 0, skipped: 3 })
    assert.lengthOf(await lineList(ctx), 3)

    const more = await must<any>(
      await importLines(ctx, [...lines, { occurredOn: '2026-10-12', amount: '7' }]),
      201
    )
    assert.equal(more.imported, 1)
    assert.equal(more.skipped, 3)
    assert.lengthOf(await lineList(ctx), 4)
  })

  test('o identificador do banco identifica a linha mesmo que a descrição mude', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await must(
      await importLines(ctx, [
        { externalId: 'TX-1', occurredOn: '2026-10-10', amount: '10', description: 'A' },
      ]),
      201
    )
    const again = await importLines(ctx, [
      { externalId: 'TX-1', occurredOn: '2026-10-10', amount: '10', description: 'B' },
    ])
    assert.equal(again.status(), 200)
    assert.equal(again.body().data.skipped, 1)
    assert.equal(
      code(
        await importLines(ctx, [
          { externalId: 'TX-2', occurredOn: '2026-10-10', amount: '1' },
          { externalId: 'TX-2', occurredOn: '2026-10-10', amount: '2' },
        ])
      ),
      'DUPLICATE_EXTERNAL_ID'
    )
  })

  test('valida datas, valores e a conta; só contas bancárias têm extracto', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const bad = async (line: Record<string, unknown>) => {
      const r = await importLines(ctx, [line])
      assert.equal(r.status(), 422)
      return code(r)
    }
    assert.equal(await bad({ occurredOn: '2026-02-30', amount: '1' }), 'INVALID_DATE')
    assert.equal(await bad({ occurredOn: '2026-10-10', amount: '0' }), 'ZERO_AMOUNT')
    assert.equal(await bad({ occurredOn: '2026-10-10', amount: '1.00001' }), 'INVALID_AMOUNT')
    assert.equal(await bad({ occurredOn: '2026-10-10', amount: '1,5' }), 'INVALID_AMOUNT')
    assert.equal((await importLines(ctx, [])).status(), 422)
    const cash = await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '1' }], ctx.cash.id)
    assert.equal(cash.status(), 422)
    assert.equal(code(cash), 'NOT_A_BANK_ACCOUNT')
    const unknown = await importLines(
      ctx,
      [{ occurredOn: '2026-10-10', amount: '1' }],
      '00000000-0000-4000-8000-000000000000'
    )
    assert.equal(unknown.status(), 404)
  })

  test('importar e conciliar nunca mexe no livro de tesouraria', async ({ client, assert }) => {
    const ctx = await setup(client)
    const entry = await receipt(ctx, '100')
    const before = await must<any>(
      await ctx.http.get(`/api/v1/treasury-accounts/${ctx.bank.id}`),
      200
    )
    const batch = await must<any>(
      await importLines(ctx, [
        { occurredOn: '2026-10-10', amount: '100' },
        { occurredOn: '2026-10-10', amount: '-40', description: 'Despesa só no banco' },
      ]),
      201
    )
    assert.equal(batch.imported, 2)
    const [credit] = await lineList(ctx, '&state=UNMATCHED').then((all) =>
      all.filter((l) => l.amountSigned === '100.0000')
    )
    await must(await match(ctx, credit.id, entry.id), 201)
    const after = await must<any>(
      await ctx.http.get(`/api/v1/treasury-accounts/${ctx.bank.id}`),
      200
    )
    assert.equal(after.balance, before.balance)
    const rows = await owner<{ n: number }>(
      `select count(*)::int as n from treasury_entries where account_id = '${ctx.bank.id}'`,
      ctx.tenant
    )
    assert.equal(rows[0].n, 1)
    const summary = await must<any>(
      await ctx.http.get(`/api/v1/reconciliations/summary?accountId=${ctx.bank.id}`),
      200
    )
    assert.equal(summary.bookBalance, '100.0000')
    assert.equal(summary.statementTotal, '60.0000')
    assert.deepEqual(summary.lines, { total: 2, unmatched: 1, partial: 0, matched: 1 })
    assert.deepEqual(summary.entries, { total: 1, unmatched: 0, partial: 0, matched: 1 })
    assert.equal(summary.unmatchedStatementAmount, '-40.0000')
    assert.equal(summary.unmatchedBookAmount, '0.0000')
  })
})

test.group('conciliação | sugestões e correspondências', (group) => {
  hooks(group)

  test('sugere primeiro o movimento de valor igual e data próxima; confirmar concilia os dois lados', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const exact = await receipt(ctx, '100', { occurredOn: '2026-10-10', reference: 'REC-77' })
    const near = await receipt(ctx, '40', { occurredOn: '2026-10-10' })
    const far = await receipt(ctx, '100', { occurredOn: '2026-08-01' })
    await must(
      await importLines(ctx, [
        { occurredOn: '2026-10-11', amount: '100', description: 'Transf REC-77 Acme' },
      ]),
      201
    )
    const [line] = await lineList(ctx)
    const suggestions = await must<any[]>(
      await ctx.http.get(`/api/v1/reconciliations/lines/${line.id}/suggestions`),
      200
    )
    assert.equal(suggestions[0].entryId, exact.id)
    assert.include(suggestions[0].reasons, 'Valor igual')
    assert.include(suggestions[0].reasons, 'Referência no extracto')
    assert.equal(suggestions[0].matchableAmount, '100.0000')
    assert.isAbove(suggestions[0].score, suggestions[1].score)
    // 40 é só parcial; o de 100 fora da janela de 30 dias nem é candidato.
    assert.deepEqual(
      suggestions.map((s) => s.entryId),
      [exact.id, near.id]
    )
    assert.notInclude(
      suggestions.map((s) => s.entryId),
      far.id
    )

    const confirmed = await must<any>(await match(ctx, line.id, exact.id), 201)
    assert.equal(confirmed.matchedAmount, '100.0000')
    const detail = await must<any>(
      await ctx.http.get(`/api/v1/reconciliations/lines/${line.id}`),
      200
    )
    assert.equal(detail.state, 'MATCHED')
    assert.equal(detail.remaining, '0.0000')
    assert.lengthOf(detail.matches, 1)
    const entries = await must<any[]>(
      await ctx.http.get(`/api/v1/reconciliations/entries?accountId=${ctx.bank.id}&state=MATCHED`),
      200
    )
    assert.deepEqual(
      entries.map((e) => e.id),
      [exact.id]
    )
    // A linha já conciliada deixa de ter sugestões, e repetir o par é um conflito.
    assert.deepEqual(
      await must<any[]>(
        await ctx.http.get(`/api/v1/reconciliations/lines/${line.id}/suggestions`),
        200
      ),
      []
    )
    const again = await match(ctx, line.id, exact.id)
    assert.equal(again.status(), 409)
    assert.equal(again.body().error.code, 'LINE_FULLY_MATCHED')
  })

  test('correspondências parciais somam até ao valor e nunca o ultrapassam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const first = await receipt(ctx, '60')
    const second = await receipt(ctx, '50')
    await must(await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '100' }]), 201)
    const [line] = await lineList(ctx)

    await must(await match(ctx, line.id, first.id), 201)
    let detail = await must<any>(
      await ctx.http.get(`/api/v1/reconciliations/lines/${line.id}`),
      200
    )
    assert.equal(detail.state, 'PARTIAL')
    assert.equal(detail.matched, '60.0000')
    assert.equal(detail.remaining, '40.0000')

    const over = await match(ctx, line.id, second.id, '45')
    assert.equal(over.status(), 409)
    assert.equal(over.body().error.code, 'EXCEEDS_REMAINING')
    assert.equal((await match(ctx, line.id, second.id, '0')).status(), 422)
    await must(await match(ctx, line.id, second.id, '40'), 201)
    detail = await must<any>(await ctx.http.get(`/api/v1/reconciliations/lines/${line.id}`), 200)
    assert.equal(detail.state, 'MATCHED')
    // O movimento de 50 ficou parcialmente conciliado: sobram 10.
    const entries = await must<any[]>(
      await ctx.http.get(`/api/v1/reconciliations/entries?accountId=${ctx.bank.id}&state=PARTIAL`),
      200
    )
    assert.deepEqual(
      entries.map((e) => [e.id, e.remaining]),
      [[second.id, '10.0000']]
    )
  })

  test('recusa contas diferentes e sentidos opostos', async ({ client, assert }) => {
    const ctx = await setup(client)
    const entry = await receipt(ctx, '100')
    const foreign = await receipt(ctx, '100', { account: ctx.other.id })
    await must(
      await importLines(ctx, [
        { occurredOn: '2026-10-10', amount: '100' },
        { occurredOn: '2026-10-10', amount: '-100' },
      ]),
      201
    )
    const lines = await lineList(ctx)
    const credit = lines.find((l) => l.amountSigned === '100.0000')
    const debit = lines.find((l) => l.amountSigned === '-100.0000')
    const wrongAccount = await match(ctx, credit.id, foreign.id)
    assert.equal(wrongAccount.status(), 422)
    assert.equal(code(wrongAccount), 'ACCOUNT_MISMATCH')
    const wrongWay = await match(ctx, debit.id, entry.id)
    assert.equal(wrongWay.status(), 422)
    assert.equal(code(wrongWay), 'DIRECTION_MISMATCH')
    assert.equal((await lineList(ctx, '&state=MATCHED')).length, 0)
  })

  test('desfazer exige motivo, repõe o estado, não apaga e é idempotente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const entry = await receipt(ctx, '100')
    await must(await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '100' }]), 201)
    const [line] = await lineList(ctx)
    const created = await must<any>(await match(ctx, line.id, entry.id), 201)

    assert.equal(
      (
        await ctx.http.post(`/api/v1/reconciliations/matches/${created.id}/undo`, { reason: '  ' })
      ).status(),
      422
    )
    const undone = await must<any>(
      await ctx.http.post(`/api/v1/reconciliations/matches/${created.id}/undo`, {
        reason: 'Par errado',
      }),
      200
    )
    assert.isNotNull(undone.undoneAt)
    assert.equal(undone.undoReason, 'Par errado')
    const repeated = await must<any>(
      await ctx.http.post(`/api/v1/reconciliations/matches/${created.id}/undo`, {
        reason: 'Outra vez',
      }),
      200
    )
    assert.equal(repeated.undoReason, 'Par errado')
    const detail = await must<any>(
      await ctx.http.get(`/api/v1/reconciliations/lines/${line.id}`),
      200
    )
    assert.equal(detail.state, 'UNMATCHED')
    assert.lengthOf(detail.matches, 1)

    // Pode voltar a ligar-se; a correspondência desfeita continua no histórico.
    await must(await match(ctx, line.id, entry.id), 201)
    const after = await must<any>(
      await ctx.http.get(`/api/v1/reconciliations/lines/${line.id}`),
      200
    )
    assert.equal(after.state, 'MATCHED')
    assert.lengthOf(after.matches, 2)
  })

  test('linhas importadas e correspondências são imutáveis também por SQL', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const entry = await receipt(ctx, '100')
    await must(await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '100' }]), 201)
    const [line] = await lineList(ctx)
    const created = await must<any>(await match(ctx, line.id, entry.id), 201)
    const fails = async (sql: string, pattern: RegExp) => {
      try {
        await owner(sql, ctx.tenant)
        assert.fail(`devia falhar: ${sql}`)
      } catch (error) {
        assert.match((error as Error).message, pattern)
      }
    }
    await fails(
      `update bank_statement_lines set amount_signed = 1 where id = '${line.id}'`,
      /STATEMENT_LINE_IMMUTABLE/
    )
    await fails(
      `update reconciliation_matches set matched_amount = 1 where id = '${created.id}'`,
      /MATCH_IMMUTABLE/
    )
    await fails(`delete from reconciliation_matches where id = '${created.id}'`, /MATCH_IMMUTABLE/)
    // Nem a linha conciliada se apaga (FK), nem o movimento que tem correspondência.
    await fails(`delete from bank_statement_lines where id = '${line.id}'`, /foreign key/)
    await fails(
      `delete from treasury_entries where id = '${entry.id}'`,
      /FINANCE_APPEND_ONLY|foreign key/
    )
  })

  test('confirmações concorrentes nunca concilian mais do que a linha ou o movimento valem', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const a = await receipt(ctx, '100')
    const b = await receipt(ctx, '100')
    await must(await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '100' }]), 201)
    const [line] = await lineList(ctx)
    const sameLine = await Promise.all([match(ctx, line.id, a.id), match(ctx, line.id, b.id)])
    assert.sameMembers(sameLine.map((r) => r.status()).sort(), [201, 409])

    // Um só movimento contra duas linhas: também só uma passa.
    const c = await receipt(ctx, '100', { occurredOn: '2026-10-20' })
    await must(
      await importLines(ctx, [
        { occurredOn: '2026-10-20', amount: '100', description: 'um' },
        { occurredOn: '2026-10-20', amount: '100', description: 'dois' },
      ]),
      201
    )
    const open = (await lineList(ctx, '&state=UNMATCHED')).filter(
      (l) => l.occurredOn === '2026-10-20'
    )
    const sameEntry = await Promise.all(open.map((l) => match(ctx, l.id, c.id)))
    assert.sameMembers(sameEntry.map((r) => r.status()).sort(), [201, 409])
    const entry = (
      await must<any[]>(
        await ctx.http.get(`/api/v1/reconciliations/entries?accountId=${ctx.bank.id}`),
        200
      )
    ).find((e) => e.id === c.id)
    assert.equal(entry.matched, '100.0000')
  })
})

test.group('conciliação | lotes e permissões', (group) => {
  hooks(group)

  test('só se descarta um lote que nunca teve correspondências', async ({ client, assert }) => {
    const ctx = await setup(client)
    const entry = await receipt(ctx, '100')
    const kept = await must<any>(
      await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '100' }]),
      201
    )
    const spare = await must<any>(
      await importLines(ctx, [{ occurredOn: '2026-10-12', amount: '5' }]),
      201
    )
    const [credit] = (await lineList(ctx)).filter((l) => l.batchId === kept.batch.id)
    const created = await must<any>(await match(ctx, credit.id, entry.id), 201)
    await must(
      await ctx.http.post(`/api/v1/reconciliations/matches/${created.id}/undo`, { reason: 'x' }),
      200
    )
    const blocked = await ctx.http.delete(`/api/v1/reconciliations/batches/${kept.batch.id}`)
    assert.equal(blocked.status(), 409)
    assert.equal(blocked.body().error.code, 'BATCH_HAS_MATCHES')
    assert.equal(
      (await ctx.http.delete(`/api/v1/reconciliations/batches/${spare.batch.id}`)).status(),
      204
    )
    assert.lengthOf(await lineList(ctx), 1)
    // Importar outra vez o mesmo ficheiro volta a criar a linha descartada.
    const again = await must<any>(
      await importLines(ctx, [{ occurredOn: '2026-10-12', amount: '5' }]),
      201
    )
    assert.equal(again.imported, 1)
    const batches = await must<any[]>(
      await ctx.http.get(`/api/v1/reconciliations/batches?accountId=${ctx.bank.id}`),
      200
    )
    assert.lengthOf(batches, 2)
  })

  test('ler, importar e confirmar são permissões distintas', async ({ client, assert }) => {
    const ctx = await setup(client)
    const entry = await receipt(ctx, '100')
    await must(await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '100' }]), 201)
    const [line] = await lineList(ctx)
    const reader = await memberWith(ctx, ['reconciliation.read'])
    const importer = await memberWith(ctx, ['reconciliation.read', 'reconciliation.manage'])
    const confirmer = await memberWith(ctx, ['reconciliation.read', 'reconciliation.confirm'])
    const nobody = await memberWith(ctx, ['treasury.read'])

    assert.equal(
      (await reader.get(`/api/v1/reconciliations/lines?accountId=${ctx.bank.id}`)).status(),
      200
    )
    assert.equal(
      (await nobody.get(`/api/v1/reconciliations/lines?accountId=${ctx.bank.id}`)).status(),
      403
    )
    const body = { accountId: ctx.bank.id, lines: [{ occurredOn: '2026-10-13', amount: '3' }] }
    assert.equal((await reader.post('/api/v1/reconciliations/imports', body)).status(), 403)
    assert.equal((await confirmer.post('/api/v1/reconciliations/imports', body)).status(), 403)
    assert.equal((await importer.post('/api/v1/reconciliations/imports', body)).status(), 201)
    const payload = { statementLineId: line.id, treasuryEntryId: entry.id }
    assert.equal((await reader.post('/api/v1/reconciliations/matches', payload)).status(), 403)
    assert.equal((await importer.post('/api/v1/reconciliations/matches', payload)).status(), 403)
    const done = await confirmer.post('/api/v1/reconciliations/matches', payload)
    assert.equal(done.status(), 201)
    assert.equal(
      (
        await reader.post(`/api/v1/reconciliations/matches/${done.body().data.id}/undo`, {
          reason: 'x',
        })
      ).status(),
      403
    )
  })

  test('a auditoria regista importações e correspondências', async ({ client, assert }) => {
    const ctx = await setup(client)
    const entry = await receipt(ctx, '100')
    await must(await importLines(ctx, [{ occurredOn: '2026-10-10', amount: '100' }]), 201)
    const [line] = await lineList(ctx)
    await must(await match(ctx, line.id, entry.id), 201)
    const rows = await owner<{ table_name: string; n: number }>(
      `select resource_type as table_name, count(*)::int as n from audit_logs
        where resource_type in ('bank_statement_batches', 'bank_statement_lines', 'reconciliation_matches')
        group by resource_type`,
      ctx.tenant
    )
    assert.sameMembers(
      rows.map((r) => r.table_name),
      ['bank_statement_batches', 'bank_statement_lines', 'reconciliation_matches']
    )
  })
})
