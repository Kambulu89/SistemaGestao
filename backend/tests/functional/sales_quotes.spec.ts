import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { acceptedQuote, markQuoteConverted } from '#modules/sales/index'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const S = '/api/v1/sales'
const Q = `${S}/quotes`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const paths = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)

async function member(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scope: { scopeType: string; scopeId?: string } = { scopeType: 'TENANT' }
) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      ...scope,
    }),
    200
  )
  return { api: as(client, m.session), memberId: m.memberId }
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = (leCode: string, taxId: string) =>
    api.post('/api/v1/organization/legal-entities', {
      code: leCode,
      legalName: `Entidade ${leCode}, Lda.`,
      taxId,
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  const leA = ok(await le('LEA', '5000000931'))
  const leB = ok(await le('LEB', '5000000932'))
  const seller = await member(client, s, 'vendas_a', ['sales.quotes.manage'], {
    scopeType: 'LEGAL_ENTITY',
    scopeId: leA.id,
  })
  const approver = await member(client, s, 'aprova_orc', ['sales.quotes.approve'])
  const own = await member(client, s, 'comercial', ['sales.quotes.manage'], { scopeType: 'OWN' })
  const uom = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    })
  )
  const p1 = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: '100',
    })
  )
  const serv = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'INST',
      name: 'Instalação',
      productType: 'SERVICE',
      baseUomId: uom.id,
    })
  )
  const customer = (n: number) =>
    api.post(`${S}/customers`, {
      currency: 'AOA',
      paymentTermsDays: 30,
      partner: {
        code: `CLI-${n}`,
        name: `Cliente ${n}`,
        partnerType: 'ORGANIZATION',
        taxId: `541700007${n}`,
        countryCode: 'AO',
        addressLine: 'Rua 1',
      },
    })
  const c1 = ok(await customer(1))
  ok(await api.put(`${S}/discount-limits`, { targetType: 'GENERAL', maxPct: '5' }), 200)
  const me = (
    await owner().rawQuery(
      `select m.id, m.user_id from tenant_memberships m join users u on u.id = m.user_id
        where m.tenant_id = ? and u.email = ?`,
      [tenant.id, admin.email]
    )
  ).rows[0]
  const context = {
    tenantId: tenant.id,
    userId: me.user_id,
    membershipId: me.id,
    requestId: 'teste',
  }
  return { tenant, api, leA, leB, seller, approver, own, p1, serv, c1, context }
}

const today = () => new Date().toISOString().slice(0, 10)
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

test.group('Vendas | orçamentos (10.3)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('ciclo: preços do motor, imposto por linha, aprovação segregada, envio numerado, revisão e aceitação', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const V = o.seller.api
    const header = {
      legalEntityId: o.leA.id,
      customerId: o.c1.id,
      quoteDate: today(),
      validUntil: plus(30),
    }
    const lines = [
      { productId: o.p1.id, quantity: '2', manualDiscountPct: '3', taxRate: '14' },
      { productId: o.serv.id, quantity: '1', manualUnitPrice: '5000', taxRate: '0' },
    ]
    // Validação: sem motivo de isenção numa linha a 0 %; desconto e preço manual juntos; entidade fora do âmbito.
    const bad = await V.post(Q, {
      ...header,
      lines: [
        lines[0],
        lines[1],
        {
          productId: o.p1.id,
          quantity: '1',
          manualDiscountPct: '1',
          manualUnitPrice: '1',
          taxRate: '14',
        },
      ],
    })
    assert.includeMembers(paths(bad), ['lines.1.taxExemptionReason', 'lines.2.manualUnitPrice'])
    assert.equal((await V.post(Q, { ...header, legalEntityId: o.leB.id, lines: [] })).status(), 403)
    lines[1] = { ...lines[1], taxExemptionReason: 'Isenção de teste' } as any
    let q = ok(await V.post(Q, { ...header, lines }))
    // 100 −3 % = 97 × 2 = 194,00 + 14 % = 27,16; serviço a preço manual 5 000,00 isento.
    assert.deepEqual(
      q.lines.map((l: any) => [
        l.priceSource,
        l.netUnitPrice,
        l.netAmount,
        l.taxAmount,
        l.requiresApproval,
      ]),
      [
        ['CATALOG', '97.0000', '194.00', '27.16', false],
        ['MANUAL', '5000.0000', '5000.00', '0.00', true],
      ]
    )
    assert.deepEqual([q.netTotal, q.taxTotal, q.grossTotal], ['5194.00', '27.16', '5221.16'])
    assert.equal(q.currency, 'AOA')
    assert.equal(q.paymentTermsDays, 30)
    assert.isTrue(q.requiresApproval)
    assert.isNull(q.number)

    // Submeter: preço manual → aguarda aprovação de outra pessoa.
    q = ok(await V.post(`${Q}/${q.id}/submit`, { expectedVersion: q.version }), 200)
    assert.equal(q.status, 'PENDING_APPROVAL')
    assert.equal(
      (await V.post(`${Q}/${q.id}/approve`, { expectedVersion: q.version })).status(),
      403
    )
    assert.equal(
      code(await o.approver.api.post(`${Q}/${q.id}/reject`, { expectedVersion: q.version })),
      'VALIDATION_ERROR'
    )
    q = ok(
      await o.approver.api.post(`${Q}/${q.id}/reject`, {
        expectedVersion: q.version,
        reason: 'Preço manual sem justificação',
      }),
      200
    )
    assert.equal(q.status, 'DRAFT')
    // Sem linhas acima do limite: aprovado logo ao submeter.
    q = ok(await V.patch(`${Q}/${q.id}`, { expectedVersion: q.version, lines: [lines[0]] }), 200)
    assert.equal(q.grossTotal, '221.16')
    q = ok(await V.post(`${Q}/${q.id}/submit`, { expectedVersion: q.version }), 200)
    assert.equal(q.status, 'APPROVED')
    assert.equal(
      code(await V.patch(`${Q}/${q.id}`, { expectedVersion: q.version, notes: 'x' })),
      'INVALID_STATE'
    )

    // Envio: série obrigatória; escolha explícita quando há várias; e-mail com destinatário.
    assert.equal(
      code(await V.post(`${Q}/${q.id}/send`, { expectedVersion: q.version, channel: 'HAND' })),
      'NO_SERIES'
    )
    const sa = ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.leA.id,
        documentType: 'SALES_QUOTE',
        code: 'ORA',
        prefix: 'ORA-',
      })
    )
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.leA.id,
        documentType: 'SALES_QUOTE',
        code: 'ORB',
        prefix: 'ORB-',
      })
    )
    assert.equal(
      code(await V.post(`${Q}/${q.id}/send`, { expectedVersion: q.version, channel: 'HAND' })),
      'SERIES_REQUIRED'
    )
    assert.include(
      paths(
        await V.post(`${Q}/${q.id}/send`, {
          expectedVersion: q.version,
          channel: 'EMAIL',
          seriesId: sa.id,
        })
      ),
      'sentTo'
    )
    q = ok(
      await V.post(`${Q}/${q.id}/send`, {
        expectedVersion: q.version,
        channel: 'EMAIL',
        sentTo: 'compras@cliente.ao',
        seriesId: sa.id,
      }),
      200
    )
    assert.equal(q.status, 'SENT')
    assert.match(q.number, /^ORA-0*1$/)
    assert.lengthOf(q.versions, 1)
    assert.equal(q.versions[0].customerVersionNo, 1)
    const firstHash = q.versions[0].hash
    // A base não deixa mexer no enviado.
    await assert.rejects(() =>
      owner().rawQuery(`update sales_quote_lines set quantity = 9 where quote_id = ?`, [q.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(
        `update sales_quotes set gross_total = 1, net_total = 1, tax_total = 0 where id = ?`,
        [q.id]
      )
    )
    await assert.rejects(() =>
      owner().rawQuery(`update sales_quote_versions set hash = 'x' where quote_id = ?`, [q.id])
    )

    // Revisão: versão 2 com o mesmo número; a decisão tem de ser sobre a versão em vigor.
    assert.equal(
      code(
        await V.post(`${Q}/${q.id}/accept`, {
          expectedVersion: q.version,
          versionNo: 2,
          decidedByName: 'Ana',
        })
      ),
      'VERSION_MISMATCH'
    )
    q = ok(
      await V.post(`${Q}/${q.id}/revise`, {
        expectedVersion: q.version,
        reason: 'Cliente pediu 3 unidades',
      }),
      200
    )
    assert.deepEqual([q.status, q.versionNo], ['DRAFT', 2])
    q = ok(
      await V.patch(`${Q}/${q.id}`, {
        expectedVersion: q.version,
        lines: [{ ...lines[0], quantity: '3' }],
      }),
      200
    )
    q = ok(await V.post(`${Q}/${q.id}/submit`, { expectedVersion: q.version }), 200)
    q = ok(await V.post(`${Q}/${q.id}/send`, { expectedVersion: q.version, channel: 'HAND' }), 200)
    assert.match(q.number, /^ORA-0*1$/)
    assert.lengthOf(q.versions, 2)
    assert.notEqual(q.versions[0].hash, firstHash)
    const v1 = await owner().rawQuery(
      `select data from sales_quote_versions where quote_id = ? and version_no = 1`,
      [q.id]
    )
    assert.equal(v1.rows[0].data.lines[0].quantity, '2.000000')
    assert.equal(
      code(
        await V.post(`${Q}/${q.id}/decline`, {
          expectedVersion: q.version,
          versionNo: 2,
          decidedByName: 'Ana',
        })
      ),
      'VALIDATION_ERROR'
    )
    q = ok(
      await V.post(`${Q}/${q.id}/accept`, {
        expectedVersion: q.version,
        versionNo: 2,
        decidedByName: 'Ana Compras',
        customerReference: 'PO-77',
      }),
      200
    )
    assert.equal(q.status, 'ACCEPTED')
    assert.equal(q.history.at(-1).details.customerReference, 'PO-77')
    assert.equal(
      code(await V.post(`${Q}/${q.id}/revise`, { expectedVersion: q.version, reason: 'Mais' })),
      'INVALID_STATE'
    )
    assert.equal(
      code(await V.post(`${Q}/${q.id}/cancel`, { expectedVersion: q.version, reason: 'Mais' })),
      'INVALID_STATE'
    )

    // Conversão única (contrato para as encomendas do 10.4): duas tentativas simultâneas, só uma passa.
    const a = await runInTenant(o.context, (scope) => acceptedQuote(scope, q.id))
    assert.equal(a.quote.grossTotal, '331.74')
    // Duas encomendas candidatas (a FK exige encomendas reais), inseridas directamente.
    const ids: string[] = []
    for (let i = 0; i < 2; i++)
      ids.push(
        (
          await owner().rawQuery(
            `insert into sales_orders (tenant_id, legal_entity_id, customer_id, salesperson_membership_id, order_date, currency)
             values (?, ?, ?, ?, current_date, 'AOA') returning id`,
            [o.tenant.id, o.leA.id, o.c1.id, o.context.membershipId]
          )
        ).rows[0].id
      )
    const res = await Promise.allSettled(
      ids.map((orderId, i) =>
        runInTenant({ ...o.context, requestId: `c${i}` }, (scope) =>
          markQuoteConverted(scope, q.id, orderId)
        )
      )
    )
    assert.deepEqual(res.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
    await assert.rejects(
      () => runInTenant(o.context, (scope) => acceptedQuote(scope, q.id)),
      /convertido/
    )
    const conv = ok(await V.get(`${Q}/${q.id}`), 200)
    assert.equal(conv.status, 'CONVERTED')
    assert.include(ids, conv.convertedOrderId)

    const audits = await owner().rawQuery(
      `select action from audit_events where entity_type = 'sales_quote' and entity_id = ? order by created_at`,
      [q.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      [
        'sales_quote.created',
        'sales_quote.rejected',
        'sales_quote.submitted',
        'sales_quote.sent',
        'sales_quote.revised',
        'sales_quote.accepted',
        'sales_quote.converted',
      ]
    )
  })

  test('âmbitos (entidade e próprios), auto-aprovação, cliente bloqueado, validade e recusa', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const header = { customerId: o.c1.id, quoteDate: today(), validUntil: plus(10) }
    const line = { productId: o.p1.id, quantity: '1', manualDiscountPct: '20', taxRate: '14' }
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.leB.id,
        documentType: 'SALES_QUOTE',
        code: 'OB',
        prefix: 'OB-',
      })
    )
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.leA.id,
        documentType: 'SALES_QUOTE',
        code: 'OA',
        prefix: 'OA-',
      })
    )
    // Quem submete não aprova (o administrador tem as duas permissões).
    let qb = ok(await o.api.post(Q, { ...header, legalEntityId: o.leB.id, lines: [line] }))
    qb = ok(await o.api.post(`${Q}/${qb.id}/submit`, { expectedVersion: qb.version }), 200)
    assert.equal(qb.status, 'PENDING_APPROVAL')
    assert.isFalse(qb.can.approve)
    assert.equal(
      code(await o.api.post(`${Q}/${qb.id}/approve`, { expectedVersion: qb.version })),
      'SELF_APPROVAL'
    )
    qb = ok(
      await o.approver.api.post(`${Q}/${qb.id}/approve`, { expectedVersion: qb.version }),
      200
    )
    assert.equal(qb.status, 'APPROVED')
    // Âmbito por entidade: o vendedor da A não vê o orçamento da B.
    assert.equal((await o.seller.api.get(`${Q}/${qb.id}`)).status(), 404)
    assert.notInclude(
      ok(await o.seller.api.get(Q), 200).map((x: any) => x.id),
      qb.id
    )
    // Âmbito próprio: o comercial só vê os seus e não os atribui a outra pessoa.
    const mine = ok(
      await o.own.api.post(Q, {
        ...header,
        legalEntityId: o.leA.id,
        lines: [{ ...line, manualDiscountPct: null }],
      })
    )
    assert.equal(mine.salesperson.membershipId, o.own.memberId)
    assert.equal(
      (
        await o.own.api.post(Q, {
          ...header,
          legalEntityId: o.leA.id,
          salespersonMembershipId: o.seller.memberId,
          lines: [],
        })
      ).status(),
      403
    )
    assert.deepEqual(
      ok(await o.own.api.get(Q), 200).map((x: any) => x.id),
      [mine.id]
    )
    assert.equal((await o.own.api.get(`${Q}/${qb.id}`)).status(), 404)
    const opts = ok(await o.own.api.get(`${Q}/options`), 200)
    assert.isTrue(opts.ownOnly)

    // Cliente bloqueado: não submete nem envia.
    let c = ok(await o.api.get(`${S}/customers/${o.c1.id}`), 200)
    c = ok(
      await o.api.post(`${S}/customers/${c.id}/status`, {
        expectedVersion: c.version,
        status: 'BLOCKED',
        reason: 'Dívida vencida',
      }),
      200
    )
    assert.equal(
      code(
        await o.api.post(`${Q}/${qb.id}/send`, { expectedVersion: qb.version, channel: 'HAND' })
      ),
      'CUSTOMER_BLOCKED'
    )
    assert.equal(
      code(await o.own.api.post(`${Q}/${mine.id}/submit`, { expectedVersion: mine.version })),
      'CUSTOMER_BLOCKED'
    )
    assert.equal(
      code(await o.api.post(Q, { ...header, legalEntityId: o.leA.id, lines: [] })),
      'CUSTOMER_BLOCKED'
    )
    ok(
      await o.api.post(`${S}/customers/${c.id}/status`, {
        expectedVersion: c.version,
        status: 'ACTIVE',
      }),
      200
    )

    // Enviado, recusado pelo cliente com motivo, revisto e anulado.
    qb = ok(
      await o.api.post(`${Q}/${qb.id}/send`, { expectedVersion: qb.version, channel: 'HAND' }),
      200
    )
    qb = ok(
      await o.api.post(`${Q}/${qb.id}/decline`, {
        expectedVersion: qb.version,
        versionNo: 1,
        decidedByName: 'Rui',
        reason: 'Preço alto',
      }),
      200
    )
    assert.equal(qb.status, 'DECLINED')
    qb = ok(
      await o.api.post(`${Q}/${qb.id}/revise`, {
        expectedVersion: qb.version,
        reason: 'Nova proposta',
      }),
      200
    )
    qb = ok(
      await o.api.post(`${Q}/${qb.id}/cancel`, {
        expectedVersion: qb.version,
        reason: 'Cliente desistiu',
      }),
      200
    )
    assert.equal(qb.status, 'CANCELLED')
    await assert.rejects(() =>
      owner().rawQuery(`update sales_quotes set status = 'DRAFT' where id = ?`, [qb.id])
    )

    // Validade ultrapassada: aparece como expirado e não se aceita (simulada directamente na base, em rascunho).
    let old = ok(
      await o.own.api.post(Q, {
        ...header,
        legalEntityId: o.leA.id,
        lines: [{ ...line, manualDiscountPct: null }],
      })
    )
    old = ok(await o.own.api.post(`${Q}/${old.id}/submit`, { expectedVersion: old.version }), 200)
    old = ok(
      await o.own.api.post(`${Q}/${old.id}/send`, {
        expectedVersion: old.version,
        channel: 'HAND',
      }),
      200
    )
    await owner().rawQuery(`alter table sales_quotes disable trigger sales_quotes_fixed`)
    await owner().rawQuery(
      `update sales_quotes set quote_date = '2026-01-01', valid_until = '2026-01-02' where id = ?`,
      [old.id]
    )
    await owner().rawQuery(`alter table sales_quotes enable trigger sales_quotes_fixed`)
    old = ok(await o.own.api.get(`${Q}/${old.id}`), 200)
    assert.isTrue(old.expired)
    assert.equal(
      code(
        await o.own.api.post(`${Q}/${old.id}/accept`, {
          expectedVersion: old.version,
          versionNo: 1,
          decidedByName: 'Ana',
        })
      ),
      'EXPIRED'
    )
    assert.deepEqual(
      ok(await o.own.api.get(`${Q}?status=EXPIRED`), 200).map((x: any) => x.id),
      [old.id]
    )
  })
})
