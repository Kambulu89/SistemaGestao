import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { tenantServices } from '#platform/tenants/index'
import { accountingServices } from '#modules/accounting/index'
import { LucidTenantDatabase, LucidTenantScope, serviceTenantContext } from '#core/tenancy/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { buildWorld, type World } from '#tests/support/matrix_fixture'

type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

const owner = <T>(sql: string, world: World) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [world.tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

let cached: { a: World; b: World } | undefined
async function worlds(client: any) {
  if (!cached) {
    await iamServices().syncCatalog.execute()
    await resetAuthState()
    cached = { a: await buildWorld(client, 'A'), b: await buildWorld(client, 'B') }
  }
  return cached
}

async function memberWith(client: any, world: World, permissions: string[]) {
  await resetAuthState()
  const actor = await newActor(client, world.tenant)
  const role = await must<{ id: string }>(
    await world.http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await world.http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return { actor, http: api(client, world.tenant, actor) }
}

let seq = 0

/** Uma empresa nova com o modelo, duas contas de movimento, um exercício de 2031 e o diário geral. */
async function company(http: Http) {
  const n = `${Date.now().toString(36)}${seq++}`
  const organization = await must<{ id: string }>(
    await http.post('/api/v1/organizations', {
      code: `C${n}`.slice(0, 20).toUpperCase(),
      legalName: `Empresa ${n}, Lda.`,
      countryCode: 'AO',
      baseCurrency: 'AOA',
    }),
    201
  )
  const org = organization.id
  await must(
    await http.post('/api/v1/ledger-accounts/apply-template', { organizationId: org }),
    200
  )
  const accounts = await must<any[]>(
    await http.get(`/api/v1/ledger-accounts?organizationId=${org}`),
    200
  )
  const header = (c: string) => accounts.find((a) => a.code === c).id as string
  const account = async (codeText: string, nature: string, extra: Record<string, unknown> = {}) =>
    must<{ id: string; version: number }>(
      await http.post('/api/v1/ledger-accounts', {
        organizationId: org,
        code: codeText,
        name: `Conta ${codeText}`,
        nature,
        parentId: header(codeText[0] as string),
        ...extra,
      }),
      201
    )
  const clients = await account('31.1', 'DEBIT')
  const sales = await account('61.1', 'CREDIT')
  const bank = await account('43.1', 'DEBIT')
  const year = await must<{ id: string; periods: any[] }>(
    await http.post('/api/v1/fiscal-years', {
      organizationId: org,
      code: '2031',
      startsOn: '2031-01-01',
      endsOn: '2031-12-31',
    }),
    201
  )
  const journals = await must<any[]>(await http.get(`/api/v1/journals?organizationId=${org}`), 200)
  const journal = (c: string) => journals.find((j) => j.code === c).id as string
  return { org, header, account, clients, sales, bank, year, journal, accounts }
}

type Company = Awaited<ReturnType<typeof company>>

const draft = (http: Http, c: Company, body: Record<string, unknown> = {}) =>
  http.post('/api/v1/journal-entries', {
    organizationId: c.org,
    journalId: c.journal('GER'),
    entryDate: '2031-03-10',
    description: 'Venda a pronto',
    lines: [
      { accountId: c.clients.id, debit: '250.5000' },
      { accountId: c.sales.id, credit: '250.5000' },
    ],
    ...body,
  })

async function posted(http: Http, c: Company, body: Record<string, unknown> = {}) {
  const created = await must<{ id: string }>(await draft(http, c, body), 201)
  return must<any>(await http.post(`/api/v1/journal-entries/${created.id}/post`, {}), 200)
}

test.group('contabilidade | plano de contas, exercícios e diários', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.timeout(240_000)

  test('o modelo de partida é idempotente e as contas respeitam a árvore', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const again = await must<any>(
      await a.http.post('/api/v1/ledger-accounts/apply-template', { organizationId: c.org }),
      200
    )
    assert.deepEqual(again, { accounts: 0, journals: 0 })
    assert.deepEqual(
      c.accounts.map((x) => x.code),
      ['1', '2', '3', '4', '5', '6', '7', '8']
    )
    assert.isTrue(c.accounts.every((x) => x.kind === 'HEADER'))
    const listed = await must<any[]>(
      await a.http.get(`/api/v1/ledger-accounts?organizationId=${c.org}`),
      200
    )
    const sales = listed.find((x) => x.code === '61.1')
    assert.equal(sales.accountClass, 6)
    assert.equal(sales.kind, 'POSTING')

    const cases: [string, Record<string, unknown>, number, string][] = [
      ['código fora da mãe', { code: '41.1', parentId: c.header('3') }, 422, 'NOT_UNDER_PARENT'],
      ['mãe de movimento', { code: '31.1.1', parentId: c.clients.id }, 422, 'NOT_HEADER'],
      ['código inválido', { code: '3A.1' }, 422, 'INVALID'],
      ['natureza desconhecida', { code: '39', nature: 'X' }, 422, 'INVALID'],
      ['código repetido', { code: '31.1', parentId: c.header('3') }, 409, 'ACCOUNT_CODE_TAKEN'],
    ]
    for (const [name, body, status, expected] of cases) {
      const response = await a.http.post('/api/v1/ledger-accounts', {
        organizationId: c.org,
        name: 'x',
        nature: 'DEBIT',
        ...body,
      })
      assert.equal(response.status(), status, name)
      assert.equal(code(response), expected, name)
    }
    // Conta com movimentos não se apaga (desactiva-se); conta nova apaga-se.
    await posted(a.http, c)
    const inUse = await a.http.delete(`/api/v1/ledger-accounts/${c.clients.id}`)
    assert.equal(inUse.status(), 409)
    assert.equal(inUse.body().error.code, 'ACCOUNT_IN_USE')
    const header = await a.http.delete(`/api/v1/ledger-accounts/${c.header('3')}`)
    assert.equal(header.status(), 409)
    const spare = await c.account('62.1', 'CREDIT')
    await must(await a.http.delete(`/api/v1/ledger-accounts/${spare.id}`), 204)
  })

  test('exercícios: períodos mensais, sem sobreposição, com limites', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    assert.lengthOf(c.year.periods, 12)
    assert.deepEqual(
      [c.year.periods[0].startsOn, c.year.periods[0].endsOn, c.year.periods[1].endsOn],
      ['2031-01-01', '2031-01-31', '2031-02-28']
    )
    const overlap = await a.http.post('/api/v1/fiscal-years', {
      organizationId: c.org,
      code: '2031B',
      startsOn: '2031-12-01',
      endsOn: '2032-11-30',
    })
    assert.equal(overlap.status(), 409)
    assert.equal(overlap.body().error.code, 'FISCAL_YEAR_OVERLAP')
    // Um exercício irregular de 15 meses é aceite; mais de 24 não.
    const irregular = await must<any>(
      await a.http.post('/api/v1/fiscal-years', {
        organizationId: c.org,
        code: '2032',
        startsOn: '2032-01-01',
        endsOn: '2033-03-31',
      }),
      201
    )
    assert.lengthOf(irregular.periods, 15)
    const tooLong = await a.http.post('/api/v1/fiscal-years', {
      organizationId: c.org,
      code: '2040',
      startsOn: '2040-01-01',
      endsOn: '2042-06-30',
    })
    assert.equal(tooLong.status(), 422)
    assert.equal(code(tooLong), 'TOO_LONG')
  })
})

test.group('contabilidade | lançamentos e partidas dobradas', (group) => {
  group.each.timeout(240_000)

  test('lançar exige partidas dobradas, contas de movimento e dimensões obrigatórias', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const unbalanced = await must<{ id: string }>(
      await draft(a.http, c, {
        lines: [
          { accountId: c.clients.id, debit: '100' },
          { accountId: c.sales.id, credit: '99.9999' },
        ],
      }),
      201
    )
    const refused = await a.http.post(`/api/v1/journal-entries/${unbalanced.id}/post`, {})
    assert.equal(refused.status(), 422)
    assert.equal(code(refused), 'UNBALANCED')

    const cases: [string, unknown[], string][] = [
      [
        'conta agregadora',
        [
          { accountId: c.header('3'), debit: '1' },
          { accountId: c.sales.id, credit: '1' },
        ],
        'NOT_POSTING',
      ],
      [
        'débito e crédito na mesma linha',
        [
          { accountId: c.clients.id, debit: '1', credit: '1' },
          { accountId: c.sales.id, credit: '1' },
        ],
        'ONE_SIDE',
      ],
      [
        'montante com 5 casas',
        [
          { accountId: c.clients.id, debit: '1.00001' },
          { accountId: c.sales.id, credit: '1.00001' },
        ],
        'INVALID_AMOUNT',
      ],
      ['montante como número', [{ accountId: c.clients.id, debit: 1 }], 'INVALID_AMOUNT'],
    ]
    for (const [name, lines, expected] of cases) {
      const response = await draft(a.http, c, { lines })
      assert.equal(response.status(), 422, name)
      assert.equal(code(response), expected, name)
    }
    const noYear = await draft(a.http, c, { entryDate: '2029-01-01' })
    assert.equal(code(noYear), 'NO_FISCAL_YEAR')

    // Conta que exige centro de custo: o rascunho grava, lançar recusa.
    const analytic = await c.account('62.1', 'CREDIT', { requiresCostCenter: true })
    const pending = await must<{ id: string }>(
      await draft(a.http, c, {
        lines: [
          { accountId: c.clients.id, debit: '10' },
          { accountId: analytic.id, credit: '10' },
        ],
      }),
      201
    )
    const noCenter = await a.http.post(`/api/v1/journal-entries/${pending.id}/post`, {})
    assert.equal(noCenter.status(), 422)
    assert.equal(code(noCenter), 'REQUIRED')
  })

  test('a numeração é sequencial por diário e exercício, também com lançamentos em paralelo', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const drafts = await Promise.all(
      Array.from({ length: 6 }, () => draft(a.http, c).then((r) => must<{ id: string }>(r, 201)))
    )
    const results = await Promise.all(
      drafts.map((d) => a.http.post(`/api/v1/journal-entries/${d.id}/post`, {}))
    )
    assert.isTrue(results.every((r) => r.status() === 200))
    const numbers = results.map((r) => r.body().data.number).sort((x: number, y: number) => x - y)
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6])
    // Outro diário começa no 1; lançar duas vezes não renumera.
    const sales = await posted(a.http, c, { journalId: c.journal('VEN') })
    assert.equal(sales.number, 1)
    const again = await must<any>(
      await a.http.post(`/api/v1/journal-entries/${sales.id}/post`, {}),
      200
    )
    assert.equal(again.number, 1)
  })

  test('um lançamento lançado é imutável: pela API e por SQL directo', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const entry = await posted(a.http, c)
    const edit = await a.http.patch(`/api/v1/journal-entries/${entry.id}`, {
      version: entry.version,
      journalId: c.journal('GER'),
      entryDate: '2031-03-10',
      description: 'x',
      lines: [],
    })
    assert.equal(edit.status(), 409)
    assert.equal(edit.body().error.code, 'ENTRY_POSTED')
    assert.equal((await a.http.delete(`/api/v1/journal-entries/${entry.id}`)).status(), 409)
    await assert.rejects(
      () => owner(`update journal_entries set description = 'x' where id = '${entry.id}'`, a),
      /JOURNAL_ENTRY_IMMUTABLE/
    )
    await assert.rejects(
      () => owner(`delete from journal_entries where id = '${entry.id}'`, a),
      /JOURNAL_ENTRY_IMMUTABLE/
    )
    await assert.rejects(
      () =>
        owner(`update journal_lines set debit = 1 where entry_id = '${entry.id}' and debit > 0`, a),
      /JOURNAL_LINES_IMMUTABLE/
    )
    await assert.rejects(
      () => owner(`delete from journal_lines where entry_id = '${entry.id}'`, a),
      /JOURNAL_LINES_IMMUTABLE/
    )
  })

  test('a base de dados recusa um lançamento desequilibrado ou num período fechado, sem a aplicação', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const entry = await must<any>(await draft(a.http, c), 201)
    // Desequilibrar o rascunho por SQL e tentar lançá-lo por SQL: a restrição diferida recusa no fim da transacção.
    await owner(
      `update journal_lines set credit = 1 where entry_id = '${entry.id}' and credit > 0`,
      a
    )
    // A restrição é diferida: força-se a verificação já, como a aplicação faz ao lançar.
    await assert.rejects(
      () =>
        owner(
          `set constraints journal_entries_balanced immediate;
           update journal_entries set status = 'POSTED', number = 999, posted_at = now() where id = '${entry.id}'`,
          a
        ),
      /JOURNAL_ENTRY_UNBALANCED/
    )
    // E sem a forçar, o COMMIT recusa: o lançamento continua rascunho.
    await owner(
      `update journal_entries set status = 'POSTED', number = 999, posted_at = now() where id = '${entry.id}'`,
      a
    ).catch(() => undefined)
    const after = await owner<any>(`select status from journal_entries where id = '${entry.id}'`, a)
    assert.equal(after[0].status, 'DRAFT')
    // Período fechado: nem a API nem o SQL lançam nele.
    const balanced = await must<any>(await draft(a.http, c), 201)
    const march = c.year.periods.find((p: any) => p.number === 3)
    await must(await a.http.post(`/api/v1/fiscal-periods/${march.id}/close`, {}), 200)
    const closed = await a.http.post(`/api/v1/journal-entries/${balanced.id}/post`, {})
    assert.equal(closed.status(), 409)
    assert.equal(closed.body().error.code, 'PERIOD_CLOSED')
    await assert.rejects(
      () =>
        owner(
          `update journal_entries set status = 'POSTED', number = 998, posted_at = now() where id = '${balanced.id}'`,
          a
        ),
      /PERIOD_CLOSED/
    )
    // Reabrir permite lançar.
    await must(await a.http.post(`/api/v1/fiscal-periods/${march.id}/reopen`, {}), 200)
    await must(await a.http.post(`/api/v1/journal-entries/${balanced.id}/post`, {}), 200)
    // Encerrar o exercício exige todos os períodos fechados.
    const early = await a.http.post(`/api/v1/fiscal-years/${c.year.id}/close`, {})
    assert.equal(early.status(), 409)
    assert.equal(early.body().error.code, 'PERIODS_OPEN')
  })

  test('uma restrição diferida que falha no fim da unidade de trabalho rejeita o run (R-01)', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const entry = await must<any>(await draft(a.http, c), 201)
    const uow = new LucidTenantDatabase()
    let returned: string | undefined
    // Sem `set constraints … immediate`: a falha só aparece no COMMIT e tem de chegar ao chamador.
    await assert.rejects(async () => {
      returned = await uow.run(
        async (scope) => {
          const trx = (scope as LucidTenantScope).trx
          await trx.rawQuery(
            'update journal_lines set credit = 1 where entry_id = ? and credit > 0',
            [entry.id]
          )
          await trx.rawQuery(
            "update journal_entries set status = 'POSTED', number = 997, posted_at = now() where id = ?",
            [entry.id]
          )
          return 'ok'
        },
        serviceTenantContext(a.tenant.id, 'teste-r01')
      )
    }, /JOURNAL_ENTRY_UNBALANCED/)
    assert.isUndefined(returned)
    const after = await owner<any>(`select status from journal_entries where id = '${entry.id}'`, a)
    assert.equal(after[0].status, 'DRAFT')
  })

  test('reverter cria o inverso, uma só vez, e o saldo volta a zero', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const entry = await posted(a.http, c)
    const [first, second] = await Promise.all([
      a.http.post(`/api/v1/journal-entries/${entry.id}/reverse`, { entryDate: '2031-03-20' }),
      a.http.post(`/api/v1/journal-entries/${entry.id}/reverse`, { entryDate: '2031-03-20' }),
    ])
    const statuses = [first.status(), second.status()].sort()
    assert.deepEqual(statuses, [201, 409])
    const reversal = (first.status() === 201 ? first : second).body().data
    assert.equal(reversal.reversalOfId, entry.id)
    assert.equal(reversal.status, 'POSTED')
    assert.deepEqual(
      reversal.lines.map((l: any) => [l.accountId, l.debit, l.credit]),
      [
        [c.clients.id, '0.0000', '250.5000'],
        [c.sales.id, '250.5000', '0.0000'],
      ]
    )
    const original = await must<any>(await a.http.get(`/api/v1/journal-entries/${entry.id}`), 200)
    assert.equal(original.status, 'REVERSED')
    assert.equal(original.reversedById, reversal.id)
    const reverseReversal = await a.http.post(`/api/v1/journal-entries/${reversal.id}/reverse`, {})
    assert.equal(reverseReversal.status(), 409)
    assert.equal(reverseReversal.body().error.code, 'IS_REVERSAL')
    const ledger = await must<any>(
      await a.http.get(`/api/v1/ledger?accountId=${c.clients.id}&from=2031-01-01&to=2031-12-31`),
      200
    )
    assert.equal(ledger.closing, '0.0000')
    assert.deepEqual(
      ledger.rows.map((r: any) => r.balance),
      ['250.5000', '0.0000']
    )
  })
})

test.group('contabilidade | razão, balancete, regras e permissões', (group) => {
  group.each.timeout(240_000)
  group.teardown(async () => {
    await deleteTestTenants()
    await deleteTestUsers()
  })

  test('o balancete fecha (débitos = créditos) e os saldos batem com o razão', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    // Janeiro (antes do intervalo): venda 1000; Março: recebimento 400 e nova venda 50.
    await posted(a.http, c, {
      entryDate: '2031-01-15',
      lines: [
        { accountId: c.clients.id, debit: '1000' },
        { accountId: c.sales.id, credit: '1000' },
      ],
    })
    await posted(a.http, c, {
      entryDate: '2031-03-05',
      lines: [
        { accountId: c.bank.id, debit: '400' },
        { accountId: c.clients.id, credit: '400' },
      ],
    })
    await posted(a.http, c, {
      entryDate: '2031-03-06',
      lines: [
        { accountId: c.clients.id, debit: '50' },
        { accountId: c.sales.id, credit: '50' },
      ],
    })
    const trial = await must<any>(
      await a.http.get(
        `/api/v1/trial-balance?organizationId=${c.org}&from=2031-03-01&to=2031-03-31`
      ),
      200
    )
    assert.equal(trial.totals.periodDebit, trial.totals.periodCredit)
    assert.equal(trial.totals.closingDebit, trial.totals.closingCredit)
    assert.equal(trial.totals.openingDebit, trial.totals.openingCredit)
    const clients = trial.rows.find((r: any) => r.code === '31.1')
    assert.deepEqual(
      [clients.openingDebit, clients.periodDebit, clients.periodCredit, clients.closingDebit],
      ['1000.0000', '50.0000', '400.0000', '650.0000']
    )
    const sales = trial.rows.find((r: any) => r.code === '61.1')
    assert.equal(sales.closingCredit, '1050.0000')
    assert.equal(sales.natureBalance, '1050.0000')
    const ledger = await must<any>(
      await a.http.get(`/api/v1/ledger?accountId=${c.clients.id}&from=2031-03-01&to=2031-03-31`),
      200
    )
    assert.equal(ledger.opening, '1000.0000')
    assert.equal(ledger.closing, '650.0000')
    // O razão de uma conta de cabeçalho soma as subcontas.
    const classThree = await must<any>(
      await a.http.get(`/api/v1/ledger?accountId=${c.header('3')}&from=2031-01-01&to=2031-12-31`),
      200
    )
    assert.equal(classThree.closing, '650.0000')
    assert.equal(
      (
        await a.http.get(
          `/api/v1/trial-balance?organizationId=${c.org}&from=2031-03-31&to=2031-03-01`
        )
      ).status(),
      422
    )
  })

  test('o motor de lançamentos automáticos é idempotente por origem e exige as regras', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const context = (
      await tenantServices().resolveTenantContext.execute({
        user: { id: a.admin.userId, locale: null },
        selector: { tenantId: a.tenant.id },
        correlationId: 'motor',
      })
    ).context
    const request = {
      organizationId: c.org,
      eventType: 'invoice.issued',
      sourceType: 'invoice',
      sourceId: 'f-1',
      sourceKey: `invoice:${c.org}:issued`,
      entryDate: '2031-04-02',
      description: 'Factura FT A/1',
      lines: [
        { role: 'receivable', debit: '114.0000' },
        { role: 'revenue', credit: '100.0000' },
        { role: 'tax', credit: '14.0000' },
      ],
    }
    await assert.rejects(
      () => accountingServices().posting.post(context, request),
      /regra de contabilização/
    )
    const tax = await c.account('34.1', 'CREDIT')
    for (const [role, accountId] of [
      ['receivable', c.clients.id],
      ['revenue', c.sales.id],
      ['tax', tax.id],
    ] as const) {
      await must(
        await a.http.put('/api/v1/posting-rules', {
          organizationId: c.org,
          eventType: 'invoice.issued',
          role,
          accountId,
          journalId: c.journal('VEN'),
        }),
        200
      )
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, () => accountingServices().posting.post(context, request))
    )
    assert.lengthOf(
      results.filter((r) => r.created),
      1
    )
    assert.lengthOf(new Set(results.map((r) => r.entry.id)), 1)
    assert.equal(results[0]?.entry.status, 'POSTED')
    assert.equal(results[0]?.entry.journalCode, 'VEN')
    assert.equal(
      (
        await owner<any>(
          `select count(*)::int as n from journal_entries where source_key = '${request.sourceKey}'`,
          a
        )
      )[0].n,
      1
    )
    // Uma regra para um papel que o evento não tem é recusada.
    const wrong = await a.http.put('/api/v1/posting-rules', {
      organizationId: c.org,
      eventType: 'invoice.issued',
      role: 'salary_expense',
      accountId: c.sales.id,
      journalId: c.journal('VEN'),
    })
    assert.equal(wrong.status(), 422)
  })

  test('permissões: consultar, lançar, reverter e fechar períodos são distintos', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const c = await company(a.http)
    const entry = await posted(a.http, c)
    const reader = await memberWith(client, a, ['accounting.read'])
    const poster = await memberWith(client, a, ['accounting.read', 'journal.post'])
    const none = await memberWith(client, a, ['party.read'])

    assert.equal((await none.http.get('/api/v1/ledger-accounts')).status(), 403)
    assert.equal((await reader.http.get(`/api/v1/journal-entries/${entry.id}`)).status(), 200)
    assert.equal((await draft(reader.http, c)).status(), 403)
    const mine = await must<{ id: string }>(await draft(poster.http, c), 201)
    await must(await poster.http.post(`/api/v1/journal-entries/${mine.id}/post`, {}), 200)
    assert.equal(
      (await poster.http.post(`/api/v1/journal-entries/${entry.id}/reverse`, {})).status(),
      403
    )
    const period = c.year.periods[0].id
    assert.equal(
      (await poster.http.post(`/api/v1/fiscal-periods/${period}/close`, {})).status(),
      403
    )
    assert.equal(
      (
        await poster.http.post('/api/v1/ledger-accounts', {
          organizationId: c.org,
          code: '39',
          name: 'x',
          nature: 'DEBIT',
        })
      ).status(),
      403
    )
  })
})
