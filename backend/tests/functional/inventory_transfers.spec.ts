import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { postStock } from '#modules/inventory/index'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const I = '/api/v1/inventory'
const T = `${I}/transfers`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
let seq = 0
const key = () => `k-${Date.now()}-${++seq}`

async function roleMember(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scopeType = 'TENANT',
  scopeId?: string
) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType,
      ...(scopeId ? { scopeId } : {}),
    }),
    200
  )
  return as(client, m.session)
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = async (c: string, taxId: string) =>
    ok(
      await api.post('/api/v1/organization/legal-entities', {
        code: c,
        legalName: `Entidade ${c}, Lda.`,
        taxId,
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    )
  const leA = await le('LEA', '5000000851')
  const leB = await le('LEB', '5000000852')
  for (const [l, c] of [
    [leA, 'TA'],
    [leB, 'TB'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: l.id,
        documentType: 'STOCK_TRANSFER',
        code: c,
        prefix: `${c}-`,
      })
    )
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const water = ok(
    await api.post(`${I}/products`, {
      sku: 'AGUA',
      name: 'Água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
    })
  )
  const mkWh = async (c: string, legalEntityId: string) => {
    const w = ok(
      await api.post(`${I}/warehouses`, {
        code: c,
        name: `Armazém ${c}`,
        legalEntityId,
        warehouseType: 'MAIN',
      })
    )
    const z = ok(await api.post(`${I}/warehouses/${w.id}/locations`, { code: 'Z1' }))
    const b = ok(
      await api.post(`${I}/warehouses/${w.id}/locations`, {
        parentId: z.locations[0].id,
        code: 'P1',
        holdsStock: true,
      })
    )
    return { ...w, bin: b.locations.find((l: any) => l.pathCode === 'Z1-P1') }
  }
  const wa1 = await mkWh('WA1', leA.id)
  const wa2 = await mkWh('WA2', leA.id)
  const wb = await mkWh('WB', leB.id)
  const ctx = (await api.get('/api/v1/context')).body().data
  const context = {
    tenantId: tenant.id,
    userId: admin.id,
    membershipId: ctx.membershipId,
    requestId: 't',
  }
  const stockIn = (w: any, q: string, bucket = 'UNRESTRICTED') =>
    runInTenant(context, (scope) =>
      postStock(scope, {
        type: 'RECEIPT',
        idempotencyKey: key(),
        sourceType: 'TEST',
        lines: [
          {
            warehouseId: w.id,
            locationId: w.bin.id,
            productId: water.id,
            bucket: bucket as never,
            quantity: q,
          },
        ],
      })
    )
  const totals = async (w: any) => {
    const rows = ok(
      await api.get(`${I}/stock/balances?productId=${water.id}&warehouseId=${w.id}`),
      200
    ) as any[]
    const sum = (f: string) => rows.reduce((t, r) => t + Number(r[f]), 0)
    return {
      physical: sum('physical'),
      available: sum('available'),
      reserved: sum('reserved'),
      inTransit: sum('inTransit'),
      quarantine: sum('quarantine'),
    }
  }
  // Aprovador (todas as entidades): quem pede não aprova.
  const approver = await roleMember(client, s, 'aprovador', [
    'inventory.read',
    'inventory.transfers.approve',
    'inventory.transfers.manage',
  ])
  return { tenant, s, api, leA, leB, water, wa1, wa2, wb, stockIn, totals, approver }
}

type O = Awaited<ReturnType<typeof setup>>
const newTransfer = (o: O, from: any, to: any, q: string, extra: Record<string, unknown> = {}) =>
  o.api.post(T, {
    sourceWarehouseId: from.id,
    destWarehouseId: to.id,
    lines: [
      {
        productId: o.water.id,
        quantity: q,
        sourceLocationId: from.bin.id,
        destLocationId: to.bin.id,
        ...extra,
      },
    ],
  })
const act = async (api: any, t: any, action: string, b: Record<string, unknown> = {}) =>
  ok(await api.post(`${T}/${t.id}/${action}`, { expectedVersion: t.version, ...b }), 200)

test.group('Inventário | transferências (8.5)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('interna: pedido, aprovação com reserva, separação, expedição, recepção parcial e perda', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    await o.stockIn(o.wa1, '100')
    assert.equal(
      details(
        await o.api.post(T, {
          sourceWarehouseId: o.wa1.id,
          destWarehouseId: o.wa1.id,
          lines: [],
        })
      ).includes('SAME'),
      true
    )
    assert.include(
      details(
        await o.api.post(T, { sourceWarehouseId: o.wa1.id, destWarehouseId: o.wa2.id, lines: [] })
      ),
      'REQUIRED'
    )
    assert.include(
      details(await newTransfer(o, o.wa1, o.wa2, '5', { destLocationId: o.wa1.bin.id })),
      'NOT_FOUND'
    )
    let t = ok(await newTransfer(o, o.wa1, o.wa2, '30'))
    assert.equal(t.status, 'DRAFT')
    assert.isFalse(t.intercompany)
    t = await act(o.api, t, 'submit')
    assert.equal(t.status, 'REQUESTED')
    // Quem pediu não aprova; o aprovador aprova: número e reserva na origem.
    assert.equal(
      code(await o.api.post(`${T}/${t.id}/approve`, { expectedVersion: t.version })),
      'SELF_APPROVAL'
    )
    t = await act(o.approver, t, 'approve')
    assert.equal(t.status, 'APPROVED')
    assert.match(t.number, /^TA-0*1$/)
    assert.deepInclude(await o.totals(o.wa1), { physical: 100, reserved: 30, available: 70 })
    // Separação curta: 25 de 30.
    assert.include(
      details(
        await o.api.post(`${T}/${t.id}/pick`, {
          expectedVersion: t.version,
          lines: [{ lineId: t.lines[0].id, pickedQuantity: '31' }],
        })
      ),
      'INVALID'
    )
    t = await act(o.api, t, 'pick', { lines: [{ lineId: t.lines[0].id, pickedQuantity: '25' }] })
    assert.equal(t.status, 'PICKED')
    // Expedição: sai 25 da origem, a reserva sai toda, 25 em trânsito no destino.
    const k = key()
    const v = t.version
    t = await act(o.api, t, 'dispatch', { idempotencyKey: k, carrier: 'Frota própria' })
    assert.equal(t.status, 'IN_TRANSIT')
    assert.equal(t.lines[0].shippedQuantity, '25.000000')
    ok(await o.api.post(`${T}/${t.id}/dispatch`, { expectedVersion: v, idempotencyKey: k }), 200)
    assert.deepInclude(await o.totals(o.wa1), { physical: 75, reserved: 0, available: 75 })
    assert.deepInclude(await o.totals(o.wa2), { physical: 0, inTransit: 25 })
    // Recepção parcial; acima do trânsito é recusada.
    assert.include(
      details(
        await o.api.post(`${T}/${t.id}/receive`, {
          expectedVersion: t.version,
          idempotencyKey: key(),
          lines: [{ lineId: t.lines[0].id, quantity: '26' }],
        })
      ),
      'INVALID'
    )
    t = await act(o.api, t, 'receive', {
      idempotencyKey: key(),
      lines: [{ lineId: t.lines[0].id, quantity: '10' }],
    })
    assert.equal(t.status, 'PARTIAL')
    assert.equal(t.lines[0].inTransitQuantity, '15.000000')
    assert.deepInclude(await o.totals(o.wa2), { physical: 10, inTransit: 15 })
    // O resto perdeu-se: fecho com motivo (aprovação no destino).
    assert.include(
      details(
        await o.api.post(`${T}/${t.id}/close`, {
          expectedVersion: t.version,
          idempotencyKey: key(),
        })
      ),
      'REQUIRED'
    )
    t = await act(o.approver, t, 'close', {
      idempotencyKey: key(),
      reason: 'Caixas partidas no transporte',
    })
    assert.equal(t.status, 'RECEIVED')
    assert.equal(t.lines[0].lostQuantity, '15.000000')
    assert.deepInclude(await o.totals(o.wa2), { physical: 10, inTransit: 0 })
    assert.sameMembers(
      t.events.map((e: any) => e.kind),
      ['RESERVE', 'DISPATCH', 'RECEIVE', 'LOSS']
    )
    // Movimentos com a origem da transferência; reconciliação; auditoria.
    const moves = ok(await o.api.get(`${I}/stock/movements?productId=${o.water.id}`), 200)
    assert.isTrue(
      moves.some((m: any) => m.source.type === 'STOCK_TRANSFER' && m.source.ref === t.number)
    )
    assert.lengthOf(ok(await o.api.get(`${I}/stock/reconciliation`), 200).differences, 0)
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where tenant_id = ? and entity_type = 'stock_transfer'`,
      [o.tenant.id]
    )
    for (const a of [
      'created',
      'submitted',
      'approved',
      'picked',
      'dispatched',
      'received',
      'closed',
    ])
      assert.include(
        audits.rows.map((r: any) => r.action),
        `inventory.transfer.${a}`
      )
    // A base protege eventos e linhas expedidas.
    await assert.rejects(() =>
      owner().rawQuery('delete from stock_transfer_events where tenant_id = ?', [o.tenant.id])
    )
    await assert.rejects(() =>
      owner().rawQuery('update stock_transfer_lines set quantity = 1 where tenant_id = ?', [
        o.tenant.id,
      ])
    )
  })

  test('intragrupo: aprovação da origem e aceitação do destino, referência comercial obrigatória', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    await o.stockIn(o.wa1, '50')
    let t = ok(await newTransfer(o, o.wa1, o.wb, '20'))
    assert.isTrue(t.intercompany)
    t = await act(o.api, t, 'submit')
    t = await act(o.approver, t, 'approve')
    // Falta a aceitação do destino: não reserva nem expede.
    assert.equal(t.status, 'REQUESTED')
    assert.isNull(t.number)
    assert.deepInclude(await o.totals(o.wa1), { reserved: 0 })
    assert.equal(
      code(
        await o.api.post(`${T}/${t.id}/dispatch`, {
          expectedVersion: t.version,
          idempotencyKey: key(),
        })
      ),
      'INVALID_STATE'
    )
    assert.equal(
      code(await o.approver.post(`${T}/${t.id}/approve`, { expectedVersion: t.version })),
      'ALREADY_APPROVED'
    )
    t = await act(o.approver, t, 'accept')
    assert.equal(t.status, 'APPROVED')
    assert.match(t.number, /^TA-/)
    assert.deepInclude(await o.totals(o.wa1), { reserved: 20 })
    assert.include(
      details(
        await o.api.post(`${T}/${t.id}/dispatch`, {
          expectedVersion: t.version,
          idempotencyKey: key(),
        })
      ),
      'REQUIRED'
    )
    t = await act(o.api, t, 'dispatch', { idempotencyKey: key(), intercompanyRef: 'FT-IG 2026/7' })
    assert.equal(t.intercompanyRef, 'FT-IG 2026/7')
    t = await act(o.api, t, 'receive', {
      idempotencyKey: key(),
      lines: [{ lineId: t.lines[0].id, quantity: '20' }],
    })
    assert.equal(t.status, 'RECEIVED')
    assert.deepInclude(await o.totals(o.wb), { physical: 20, inTransit: 0 })
    assert.deepInclude(await o.totals(o.wa1), { physical: 30, reserved: 0 })
    const moves = ok(await o.api.get(`${I}/stock/movements?warehouseId=${o.wb.id}`), 200)
    assert.isTrue(moves.every((m: any) => m.source.type === 'INTERCOMPANY_TRANSFER'))
    // Aceitar só se aplica a intragrupo.
    let inner = ok(await newTransfer(o, o.wa1, o.wa2, '1'))
    inner = await act(o.api, inner, 'submit')
    assert.equal(
      code(await o.approver.post(`${T}/${inner.id}/accept`, { expectedVersion: inner.version })),
      'NOT_INTERCOMPANY'
    )
  })

  test('falta de stock, anulação com libertação, rejeição, quarentena e âmbito por armazém', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    await o.stockIn(o.wa1, '40')
    await o.stockIn(o.wa1, '5', 'QUARANTINE')
    // Aprovar mais do que o disponível: a reserva falha e nada muda.
    let big = await act(o.api, ok(await newTransfer(o, o.wa1, o.wa2, '41')), 'submit')
    assert.equal(
      code(await o.approver.post(`${T}/${big.id}/approve`, { expectedVersion: big.version })),
      'OVER_RESERVED'
    )
    big = ok(await o.api.get(`${T}/${big.id}`), 200)
    assert.equal(big.status, 'REQUESTED')
    assert.isNull(big.number)
    // Rejeição com motivo.
    assert.include(
      details(await o.approver.post(`${T}/${big.id}/reject`, { expectedVersion: big.version })),
      'REQUIRED'
    )
    big = await act(o.approver, big, 'reject', { reason: 'Quantidade acima do disponível' })
    assert.equal(big.status, 'REJECTED')
    // Anular depois de aprovada liberta a reserva.
    let t = await act(o.api, ok(await newTransfer(o, o.wa1, o.wa2, '10')), 'submit')
    t = await act(o.approver, t, 'approve')
    assert.deepInclude(await o.totals(o.wa1), { reserved: 10, available: 30 })
    t = await act(o.api, t, 'cancel', { reason: 'Já não é preciso' })
    assert.equal(t.status, 'CANCELLED')
    assert.deepInclude(await o.totals(o.wa1), { reserved: 0, available: 40 })
    assert.sameMembers(
      t.events.map((e: any) => e.kind),
      ['RESERVE', 'RELEASE']
    )
    // Stock em quarentena transfere-se sem reserva e chega em quarentena.
    let q = await act(
      o.api,
      ok(await newTransfer(o, o.wa1, o.wa2, '5', { sourceBucket: 'QUARANTINE' })),
      'submit'
    )
    q = await act(o.approver, q, 'approve')
    assert.deepInclude(await o.totals(o.wa1), { reserved: 0 })
    q = await act(o.api, q, 'dispatch', { idempotencyKey: key() })
    q = await act(o.api, q, 'receive', {
      idempotencyKey: key(),
      lines: [{ lineId: q.lines[0].id, quantity: '5' }],
    })
    assert.deepInclude(await o.totals(o.wa2), { quarantine: 5, available: 0 })

    // Âmbito: quem gere só a entidade A pede e expede de WA1, mas não recebe em WB.
    const clerkA = await roleMember(
      client,
      o.s,
      'fiel_a',
      ['inventory.read', 'inventory.transfers.manage'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    const readerB = await roleMember(
      client,
      o.s,
      'ler_b',
      ['inventory.read'],
      'LEGAL_ENTITY',
      o.leB.id
    )
    let x = await act(
      clerkA,
      ok(
        await clerkA.post(T, {
          sourceWarehouseId: o.wa1.id,
          destWarehouseId: o.wb.id,
          intercompanyRef: 'IG-1',
          lines: [{ productId: o.water.id, quantity: '2', sourceLocationId: o.wa1.bin.id }],
        })
      ),
      'submit'
    )
    x = await act(o.approver, x, 'approve')
    x = await act(o.approver, x, 'accept')
    x = await act(clerkA, x, 'dispatch', { idempotencyKey: key() })
    assert.equal(
      code(
        await clerkA.post(`${T}/${x.id}/receive`, {
          expectedVersion: x.version,
          idempotencyKey: key(),
          lines: [{ lineId: x.lines[0].id, quantity: '2' }],
        })
      ),
      'OUT_OF_SCOPE'
    )
    // O leitor de B vê a transferência para WB, não as internas de A.
    const seen = ok(await readerB.get(T), 200).map((r: any) => r.id)
    assert.include(seen, x.id)
    assert.notInclude(seen, t.id)
    assert.equal((await readerB.get(`${T}/${t.id}`)).status(), 404)
    assert.lengthOf(ok(await o.api.get(`${I}/stock/reconciliation`), 200).differences, 0)
  })
})
