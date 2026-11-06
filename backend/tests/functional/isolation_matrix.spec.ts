import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')

function upload(client: any, s: Session, subjectType: string, subjectId: string) {
  return client
    .post('/api/v1/attachments')
    .header('cookie', s.cookie)
    .header('x-xsrf-token', s.xsrf)
    .header('x-tenant-id', s.tenantId)
    .field('subjectType', subjectType)
    .field('subjectId', subjectId)
    .file('file', PDF, { filename: 'a.pdf' })
}

/** Empresa A com um registo de cada tipo; devolve os ids. */
async function populate(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const ok = (r: any, status = 201) => {
    if (r.status() !== status) throw new Error(JSON.stringify(r.body()))
    return r.body().data
  }
  const le = ok(
    await as(client, s).post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000101',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const branch = ok(
    await as(client, s).post('/api/v1/organization/branches', {
      code: 'BRA',
      name: 'Filial A',
      legalEntityId: le.id,
    })
  )
  const role = await createRole(client, s, 'aprovador_a', ['members.read'])
  const approver = await memberWithRoles(client, s, [role.id])
  const wf = ok(
    await as(client, s).post('/api/v1/approvals/workflows', {
      code: 'WFA',
      name: 'Workflow A',
      subjectType: 'manual',
      steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: approver.memberId }],
    })
  )
  ok(
    await as(client, s).post(`/api/v1/approvals/workflows/${wf.id}/publish`, {
      expectedVersion: wf.version,
    }),
    200
  )
  const request = ok(
    await as(client, s).post('/api/v1/approvals/requests', { workflowId: wf.id, title: 'Pedido A' })
  )
  const delegation = ok(
    await as(client, approver.session).post('/api/v1/approvals/delegations', {
      delegateMembershipId: (await as(client, s).get('/api/v1/context')).body().data.membershipId,
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'Ausência',
    })
  )
  const attachment = ok(await upload(client, s, 'legal_entity', le.id))
  const notification = (await as(client, approver.session).get('/api/v1/me/notifications')).body()
    .data[0]
  const rate = ok(
    await as(client, s).post('/api/v1/exchange-rates', {
      fromCurrency: 'USD',
      toCurrency: 'AOA',
      rate: '900',
      validOn: '2026-01-02',
    })
  )
  const series = ok(
    await as(client, s).post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'INVOICE',
      code: 'FTA',
    })
  )
  const calendar = ok(
    await as(client, s).post('/api/v1/calendars', {
      code: 'CALA',
      name: 'Calendário A',
      countryCode: 'AO',
    })
  )
  const holiday = ok(
    await as(client, s).post(`/api/v1/calendars/${calendar.id}/holidays`, {
      date: '2026-11-11',
      name: 'Independência',
    })
  )
  const bank = ok(
    await as(client, s).post('/api/v1/bank-accounts', {
      legalEntityId: le.id,
      holderName: 'Entidade A, Lda.',
      bankName: 'Banco A',
      accountNumber: '123456789',
      currency: 'AOA',
    })
  )
  ok(
    await as(client, s).put('/api/v1/company/profile', {
      expectedVersion: 0,
      displayName: 'Marca A',
    }),
    200
  )
  // Contabilidade: série de lançamentos, plano com duas contas, exercício, diário e um lançamento contabilizado.
  const jSeries = ok(
    await as(client, s).post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'JOURNAL',
      code: 'DGA',
    })
  )
  const chart = ok(
    await as(client, s).post('/api/v1/accounting/charts', {
      legalEntityId: le.id,
      code: 'PCA',
      name: 'Plano A',
      jurisdiction: 'AO',
    })
  )
  const acc = async (code: string, level: string, parentId: string | null, postable = false) =>
    ok(
      await as(client, s).post('/api/v1/accounting/accounts', {
        chartId: chart.id,
        code,
        name: `Conta ${code}`,
        level,
        nature: 'ASSET',
        parentId,
        postable,
      })
    )
  const cls = await acc('1', 'CLASS', null)
  const accountA = await acc('11', 'ACCOUNT', cls.id, true)
  const accountB = await acc('12', 'ACCOUNT', cls.id, true)
  const fy = ok(
    await as(client, s).post('/api/v1/accounting/fiscal-years', {
      legalEntityId: le.id,
      code: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
  )
  const journal = ok(
    await as(client, s).post('/api/v1/accounting/journals', {
      legalEntityId: le.id,
      code: 'DGA',
      name: 'Diário A',
      type: 'GENERAL',
      documentSeriesId: jSeries.id,
    })
  )
  const entry = ok(
    await as(client, s).post('/api/v1/accounting/entries', {
      legalEntityId: le.id,
      journalId: journal.id,
      entryDate: '2026-02-10',
      description: 'Lançamento A',
      lines: [
        { accountId: accountA.id, debit: '10' },
        { accountId: accountB.id, credit: '10' },
      ],
    })
  )
  const rule = ok(
    await as(client, s).post('/api/v1/accounting/posting-rules', {
      legalEntityId: le.id,
      code: 'REGA',
      name: 'Regra A',
      source: 'SALES_INVOICE',
      event: 'ISSUED',
      journalId: journal.id,
      validFrom: '2026-01-01',
      lines: [
        { side: 'DEBIT', accountId: accountA.id, amountKey: 'total' },
        { side: 'CREDIT', accountId: accountB.id, amountKey: 'total' },
      ],
    })
  )
  const postingEvent = ok(
    await as(client, s).post('/api/v1/accounting/posting-events', {
      legalEntityId: le.id,
      source: 'SALES_INVOICE',
      event: 'ISSUED',
      sourceRef: 'FT A1',
      occurredOn: '2026-02-11',
      amounts: { total: '5' },
    })
  )
  const period = (await as(client, s).get(`/api/v1/accounting/fiscal-years/${fy.id}`)).body().data
    .periods[2]
  const dimension = ok(
    await as(client, s).post('/api/v1/accounting/dimensions', { code: 'PRJA', name: 'Projecto A' })
  )
  const dimValue = ok(
    await as(client, s).post(`/api/v1/accounting/dimensions/${dimension.id}/values`, {
      code: 'V1',
      name: 'Valor A',
    })
  )[0]
  const allocKey = ok(
    await as(client, s).post('/api/v1/accounting/allocation-keys', {
      legalEntityId: le.id,
      code: 'KA',
      name: 'Chave A',
      lines: [{ percent: '100', values: { [dimension.id]: dimValue.id } }],
    })
  )
  ok(
    await as(client, s).put(`/api/v1/accounting/entries/${entry.id}/lines/1/allocations`, {
      keyId: allocKey.id,
    }),
    200
  )
  const assetClass = ok(
    await as(client, s).post('/api/v1/accounting/fixed-asset-classes', {
      legalEntityId: le.id,
      code: 'FA',
      name: 'Classe A',
      usefulLifeMonths: 12,
      journalId: journal.id,
      assetAccountId: accountA.id,
      accumulatedAccountId: accountB.id,
      expenseAccountId: accountA.id,
      gainAccountId: accountB.id,
      lossAccountId: accountA.id,
    })
  )
  const asset = ok(
    await as(client, s).post('/api/v1/accounting/fixed-assets', {
      classId: assetClass.id,
      number: 'AF-A',
      name: 'Activo A',
      acquisitionDate: '2026-01-01',
      cost: '12',
    })
  )
  const audit = (await as(client, s).get('/api/v1/audit-events?limit=1')).body().data[0]
  return {
    assetClass,
    asset,
    dimension,
    dimValue,
    allocKey,
    rule,
    postingEvent,
    chart,
    accountA,
    fy,
    period,
    journal,
    entry,
    rate,
    series,
    calendar,
    holiday,
    bank,
    tenantId: tenant.id,
    le,
    branch,
    role,
    member: approver.memberId,
    wf,
    request,
    delegation,
    attachment,
    notification,
    audit,
  }
}

test.group('isolamento | matriz entre empresas', (group) => {
  group.each.setup(() => cleanDatabase())

  test('o administrador de outra empresa (todas as permissões) não lê, altera nem refere registos de A', async ({
    client,
    assert,
  }) => {
    const a = await populate(client)
    const { tenant, admin } = await tenantWithAdmin()
    const b = await signIn(client, admin.email, tenant.id)
    const B = as(client, b)
    const v = { expectedVersion: 1 }

    const attempts: [string, Promise<any>][] = [
      ['GET entidade', B.get(`/api/v1/organization/legal-entities/${a.le.id}`)],
      [
        'PATCH entidade',
        B.patch(`/api/v1/organization/legal-entities/${a.le.id}`, { ...v, tradeName: 'x' }),
      ],
      ['GET filial', B.get(`/api/v1/organization/branches/${a.branch.id}`)],
      ['GET perfil', B.get(`/api/v1/roles/${a.role.id}`)],
      ['PATCH perfil', B.patch(`/api/v1/roles/${a.role.id}`, { ...v, name: 'x' })],
      ['DELETE perfil', B.delete(`/api/v1/roles/${a.role.id}`)],
      ['GET membro', B.get(`/api/v1/members/${a.member}`)],
      ['GET dimensão', B.get(`/api/v1/accounting/dimensions/${a.dimension.id}`)],
      [
        'PATCH dimensão',
        B.patch(`/api/v1/accounting/dimensions/${a.dimension.id}`, { ...v, name: 'xx' }),
      ],
      [
        'valor em dimensão de A',
        B.post(`/api/v1/accounting/dimensions/${a.dimension.id}/values`, { code: 'Z', name: 'Zz' }),
      ],
      ['GET chave', B.get(`/api/v1/accounting/allocation-keys/${a.allocKey.id}`)],
      [
        'PATCH chave',
        B.patch(`/api/v1/accounting/allocation-keys/${a.allocKey.id}`, { ...v, name: 'xx' }),
      ],
      ['imputações de A', B.get(`/api/v1/accounting/entries/${a.entry.id}/allocations`)],
      [
        'imputar linha de A',
        B.put(`/api/v1/accounting/entries/${a.entry.id}/lines/1/allocations`, { allocations: [] }),
      ],
      ['analítica de A', B.get(`/api/v1/accounting/analytics?fiscalYearId=${a.fy.id}`)],
      ['GET classe de activos', B.get(`/api/v1/accounting/fixed-asset-classes/${a.assetClass.id}`)],
      [
        'PATCH classe de activos',
        B.patch(`/api/v1/accounting/fixed-asset-classes/${a.assetClass.id}`, { ...v, name: 'xx' }),
      ],
      ['GET activo', B.get(`/api/v1/accounting/fixed-assets/${a.asset.id}`)],
      [
        'PATCH activo',
        B.patch(`/api/v1/accounting/fixed-assets/${a.asset.id}`, { ...v, name: 'xx' }),
      ],
      ['DELETE activo', B.delete(`/api/v1/accounting/fixed-assets/${a.asset.id}`)],
      [
        'adquirir activo',
        B.post(`/api/v1/accounting/fixed-assets/${a.asset.id}/acquire`, {
          ...v,
          counterpartAccountId: a.accountA.id,
        }),
      ],
      [
        'transferir activo',
        B.post(`/api/v1/accounting/fixed-assets/${a.asset.id}/transfer`, {
          ...v,
          date: '2026-02-01',
        }),
      ],
      [
        'abater activo',
        B.post(`/api/v1/accounting/fixed-assets/${a.asset.id}/dispose`, {
          ...v,
          date: '2026-02-01',
          reason: 'xx',
        }),
      ],
      [
        'simular depreciação de A',
        B.get(
          `/api/v1/accounting/fixed-assets/depreciation/preview?legalEntityId=${a.le.id}&upTo=2026-12`
        ),
      ],
      [
        'depreciar entidade de A',
        B.post('/api/v1/accounting/fixed-assets/depreciation/run', {
          legalEntityId: a.le.id,
          upTo: '2026-12',
        }),
      ],
      [
        'mapa de depreciação de A',
        B.get(`/api/v1/accounting/fixed-assets/depreciation-map?fiscalYearId=${a.fy.id}`),
      ],
      ['balancete de A', B.get(`/api/v1/accounting/trial-balance?fiscalYearId=${a.fy.id}`)],
      [
        'razão de A',
        B.get(
          `/api/v1/accounting/ledger?legalEntityId=${a.le.id}&accountId=${a.accountA.id}&from=2026-01-01&to=2026-12-31`
        ),
      ],
      [
        'abertura em exercício de A',
        B.post('/api/v1/accounting/opening-balances/validate', {
          fiscalYearId: a.fy.id,
          journalId: a.journal.id,
          lines: [],
        }),
      ],
      ['suspender membro', B.post(`/api/v1/members/${a.member}/suspend`, v)],
      ['GET workflow', B.get(`/api/v1/approvals/workflows/${a.wf.id}`)],
      ['retirar workflow', B.post(`/api/v1/approvals/workflows/${a.wf.id}/retire`, v)],
      ['GET pedido', B.get(`/api/v1/approvals/requests/${a.request.id}`)],
      [
        'decidir pedido',
        B.post(`/api/v1/approvals/requests/${a.request.id}/decisions`, { decision: 'APPROVE' }),
      ],
      ['cancelar pedido', B.post(`/api/v1/approvals/requests/${a.request.id}/cancel`, {})],
      ['revogar delegação', B.post(`/api/v1/approvals/delegations/${a.delegation.id}/revoke`)],
      ['descarregar anexo', B.get(`/api/v1/attachments/${a.attachment.id}/content`)],
      ['eliminar anexo', B.delete(`/api/v1/attachments/${a.attachment.id}`)],
      [
        'listar anexos de A',
        B.get(`/api/v1/attachments?subjectType=legal_entity&subjectId=${a.le.id}`),
      ],
      ['marcar notificação', B.post(`/api/v1/me/notifications/${a.notification.id}/read`)],
      ['GET câmbio', B.get(`/api/v1/exchange-rates/${a.rate.id}`)],
      ['PATCH câmbio', B.patch(`/api/v1/exchange-rates/${a.rate.id}`, { ...v, rate: '1' })],
      ['GET série', B.get(`/api/v1/document-series/${a.series.id}`)],
      ['PATCH série', B.patch(`/api/v1/document-series/${a.series.id}`, { ...v, name: 'x' })],
      ['pré-visualizar série', B.get(`/api/v1/document-series/${a.series.id}/preview`)],
      ['GET calendário', B.get(`/api/v1/calendars/${a.calendar.id}`)],
      [
        'dias úteis',
        B.get(`/api/v1/calendars/${a.calendar.id}/working-days?from=2026-11-01&to=2026-11-30`),
      ],
      [
        'feriado em calendário de A',
        B.post(`/api/v1/calendars/${a.calendar.id}/holidays`, {
          date: '2026-12-25',
          name: 'Natal',
        }),
      ],
      ['remover feriado', B.delete(`/api/v1/calendars/${a.calendar.id}/holidays/${a.holiday.id}`)],
      ['GET conta bancária', B.get(`/api/v1/bank-accounts/${a.bank.id}`)],
      [
        'PATCH conta bancária',
        B.patch(`/api/v1/bank-accounts/${a.bank.id}`, { ...v, isDefault: true }),
      ],
      [
        'dependentes da entidade',
        B.get(`/api/v1/organization/legal-entities/${a.le.id}/dependents`),
      ],
    ]
    const wrong: string[] = []
    for (const [name, promise] of attempts) {
      const status = (await promise).status()
      if (status !== 404) wrong.push(`${name} → ${status}`)
    }
    assert.deepEqual(wrong, [])

    // Referências a ids de A em escritas de B: recusadas (nunca ligam linhas de empresas diferentes).
    const crossRef = await B.post('/api/v1/organization/branches', {
      code: 'BRX',
      name: 'Filial cruzada',
      legalEntityId: a.le.id,
    })
    assert.include([404, 422], crossRef.status())
    ;(await upload(client, b, 'legal_entity', a.le.id)).assertStatus(404)
    const wfCross = await B.post('/api/v1/approvals/workflows', {
      code: 'WFX',
      name: 'Workflow cruzado',
      subjectType: 'manual',
      steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: a.member }],
    })
    wfCross.assertStatus(422)
    const assignCross = await B.post(
      `/api/v1/members/${(await B.get('/api/v1/context')).body().data.membershipId}/roles`,
      { roleId: a.role.id }
    )
    assert.include([403, 404, 422], assignCross.status())

    // Listas de B não contêm nada de A.
    const lists = await Promise.all([
      B.get('/api/v1/organization/legal-entities'),
      B.get('/api/v1/roles'),
      B.get('/api/v1/members'),
      B.get('/api/v1/approvals/workflows'),
      B.get('/api/v1/approvals/requests'),
      B.get('/api/v1/approvals/delegations?all=true'),
      B.get('/api/v1/audit-events?limit=200'),
      B.get('/api/v1/me/notifications'),
      B.get('/api/v1/me/tasks'),
      B.get('/api/v1/exchange-rates'),
      B.get('/api/v1/document-series'),
      B.get('/api/v1/calendars'),
      B.get('/api/v1/bank-accounts'),
      B.get('/api/v1/organization/departments/tree'),
      B.get('/api/v1/accounting/charts'),
      B.get('/api/v1/accounting/accounts'),
      B.get('/api/v1/accounting/fiscal-years'),
      B.get('/api/v1/accounting/journals'),
      B.get('/api/v1/accounting/entries'),
      B.get('/api/v1/accounting/posting-rules'),
      B.get('/api/v1/accounting/posting-events'),
      B.get('/api/v1/accounting/dimensions'),
      B.get('/api/v1/accounting/allocation-keys'),
      B.get('/api/v1/accounting/fixed-asset-classes'),
      B.get('/api/v1/accounting/fixed-assets'),
    ])
    const idsOfA = new Set(
      [
        a.le.id,
        a.branch.id,
        a.role.id,
        a.member,
        a.wf.id,
        a.request.id,
        a.delegation.id,
        a.audit.id,
        a.rate.id,
        a.series.id,
        a.calendar.id,
        a.bank.id,
        a.chart.id,
        a.accountA.id,
        a.fy.id,
        a.journal.id,
        a.entry.id,
        a.rule.id,
        a.postingEvent.id,
        a.dimension.id,
        a.allocKey.id,
        a.assetClass.id,
        a.asset.id,
      ].map(String)
    )
    const leaked = lists.flatMap((r) =>
      (r.body().data as any[]).filter((item) => idsOfA.has(item.id) || idsOfA.has(item.subjectId))
    )
    assert.deepEqual(leaked, [])

    // A pesquisa global de B não encontra nada de A.
    for (const q of ['Entidade A', 'Filial A', 'Pedido A', 'aprovador_a', 'Workflow A']) {
      const hits = (await B.get(`/api/v1/search?q=${encodeURIComponent(q)}`)).body().data as any[]
      assert.deepEqual(
        hits.filter((h) => idsOfA.has(h.id)),
        [],
        q
      )
    }
    // O painel de B só conta registos de B.
    const dash = (await B.get('/api/v1/dashboard')).body().data
    assert.equal(dash.organization.legalEntities, 0)
    assert.equal(dash.members.ACTIVE, 1)

    // Nada de A mudou.
    const owner = db.connection('owner')
    const le = await owner.rawQuery('select version, trade_name from legal_entities where id = ?', [
      a.le.id,
    ])
    assert.deepEqual(le.rows[0], { version: 1, trade_name: null })
    const req = await owner.rawQuery('select status from approval_requests where id = ?', [
      a.request.id,
    ])
    assert.equal(req.rows[0].status, 'PENDING')
    const att = await owner.rawQuery('select status from attachments where id = ?', [
      a.attachment.id,
    ])
    assert.equal(att.rows[0].status, 'ACTIVE')
    // Perfil e configurações são por empresa: B vê os seus (vazios), nunca os de A.
    const profile = (await B.get('/api/v1/company/profile')).body().data
    assert.notEqual(profile.displayName, 'Marca A')
    const hol = await owner.rawQuery(
      'select count(*)::int as n from calendar_holidays where id = ?',
      [a.holiday.id]
    )
    assert.equal(hol.rows[0].n, 1)
    const lookup = await B.get('/api/v1/exchange-rates/lookup?from=USD&to=AOA&date=2026-02-01')
    lookup.assertStatus(404)
    // Referências cruzadas na contabilidade: B não usa diário, plano ou contas de A.
    const leB = (
      await B.post('/api/v1/organization/legal-entities', {
        code: 'LEB',
        legalName: 'Entidade B, Lda.',
        taxId: '5000000202',
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    ).body().data
    const crossEntry = await B.post('/api/v1/accounting/entries', {
      legalEntityId: leB.id,
      journalId: a.journal.id,
      entryDate: '2026-02-10',
      description: 'Cruzado',
      lines: [{ accountId: a.accountA.id, debit: '1' }],
    })
    crossEntry.assertStatus(422)
    const crossAccount = await B.post('/api/v1/accounting/accounts', {
      chartId: a.chart.id,
      code: '9',
      name: 'Cruzada',
      level: 'CLASS',
      nature: 'ASSET',
    })
    crossAccount.assertStatus(422)
    // Eventos de B com a entidade legal de A não usam as regras de A.
    const crossEvent = await B.post('/api/v1/accounting/posting-events', {
      legalEntityId: a.le.id,
      source: 'SALES_INVOICE',
      event: 'ISSUED',
      sourceRef: 'FT X',
      occurredOn: '2026-02-11',
      amounts: { total: '5' },
    })
    assert.include([404, 422], crossEvent.status())
    const eventsOfA = await owner.rawQuery(
      'select count(*)::int as n from posting_events where tenant_id = ?',
      [a.tenantId]
    )
    assert.equal(eventsOfA.rows[0].n, 1)
    const entryA = await owner.rawQuery(
      'select status, description from journal_entries where id = ?',
      [a.entry.id]
    )
    assert.deepEqual(entryA.rows[0], { status: 'DRAFT', description: 'Lançamento A' })
  })

  test('com a sessão de B e X-Tenant-Id de A todas as rotas de empresa são negadas', async ({
    client,
    assert,
  }) => {
    const a = await populate(client)
    const { tenant, admin } = await tenantWithAdmin()
    const b = await signIn(client, admin.email, tenant.id)
    const spoof = as(client, { ...b, tenantId: a.tenantId })
    for (const url of [
      '/api/v1/context',
      '/api/v1/organization/legal-entities',
      `/api/v1/organization/legal-entities/${a.le.id}`,
      '/api/v1/members',
      '/api/v1/approvals/requests',
      `/api/v1/attachments/${a.attachment.id}/content`,
      '/api/v1/audit-events',
      '/api/v1/me/notifications',
      '/api/v1/company/profile',
      '/api/v1/settings',
      '/api/v1/exchange-rates',
      `/api/v1/bank-accounts/${a.bank.id}`,
      '/api/v1/accounting/entries',
      `/api/v1/accounting/charts/${a.chart.id}`,
    ]) {
      const r = await spoof.get(url)
      assert.equal(r.status(), 403, url)
      assert.equal(r.body().error.code, 'TENANT_ACCESS_DENIED', url)
    }
  })
})
