import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { postStock, reverseStockPosting } from '#modules/inventory/index'
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
const ORG = '/api/v1/organization'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
let seq = 0
const key = () => `k-${Date.now()}-${++seq}`
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const errCode = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e: any) {
    return (e.details?.[0]?.code as string) ?? (e.code as string)
  }
}

async function roleMember(
  client: any,
  admin: Session,
  roleCode: string,
  grants: [string[], string, string?][]
) {
  const m = await memberWithRoles(client, admin, [])
  let n = 0
  for (const [permissions, scopeType, scopeId] of grants) {
    const role = await createRole(client, admin, `${roleCode}_${n++}`, permissions)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: role.id,
        scopeType,
        ...(scopeId ? { scopeId } : {}),
      }),
      200
    )
  }
  return { api: as(client, m.session) }
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = async (c: string, taxId: string) =>
    ok(
      await api.post(`${ORG}/legal-entities`, {
        code: c,
        legalName: `Entidade ${c}, Lda.`,
        taxId,
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    )
  const leA = await le('LEA', '5000000881')
  const leB = await le('LEB', '5000000882')
  for (const [t, c] of [
    ['STOCK_RECEIPT', 'RE'],
    ['STOCK_COUNT', 'IV'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: leA.id,
        documentType: t,
        code: c,
        prefix: `${c}-`,
      })
    )
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const milk = ok(
    await api.post(`${I}/products`, {
      sku: 'LEITE',
      name: 'Leite',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      trackLots: true,
      trackExpiry: true,
    })
  )
  const phone = ok(
    await api.post(`${I}/products`, {
      sku: 'TEL',
      name: 'Telemóvel',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      trackSerials: true,
    })
  )
  const mkWh = async (c: string, l: any) => {
    const w = ok(
      await api.post(`${I}/warehouses`, {
        code: c,
        name: `Armazém ${c}`,
        legalEntityId: l.id,
        warehouseType: 'MAIN',
      })
    )
    const x = ok(
      await api.post(`${I}/warehouses/${w.id}/locations`, { code: 'P1', holdsStock: true })
    )
    return { ...w, bin: x.locations[0] }
  }
  const wa = await mkWh('WA', leA)
  const wa2 = await mkWh('WA2', leA)
  const wb = await mkWh('WB', leB)
  const ctx = (await api.get('/api/v1/context')).body().data
  const sc = {
    tenantId: tenant.id,
    userId: admin.id,
    membershipId: ctx.membershipId,
    requestId: 't',
  }
  const post = (type: any, lines: any[], extra: Record<string, unknown> = {}) =>
    runInTenant(sc, (scope) =>
      postStock(scope, { type, idempotencyKey: key(), sourceType: 'TEST', lines, ...extra })
    )
  const L = (w: any, p: any, q: string, extra: Record<string, unknown> = {}) => ({
    warehouseId: w.id,
    locationId: w.bin?.id ?? null,
    productId: p.id,
    bucket: 'UNRESTRICTED',
    quantity: q,
    ...extra,
  })
  const lotsOf = async () =>
    Object.fromEntries(
      (ok(await api.get(`${I}/lots?productId=${milk.id}`), 200) as any[]).map((x) => [x.code, x])
    )
  const balance = async (w: any, lotId: string | null, field = 'unrestricted') => {
    const rows = ok(
      await api.get(`${I}/stock/balances?warehouseId=${w.id}&productId=${milk.id}`),
      200
    ) as any[]
    return rows
      .filter((r) => (r.lot?.id ?? null) === lotId)
      .reduce((t, r) => t + Number(r[field]), 0)
  }
  return { tenant, s, api, leA, leB, un, milk, phone, wa, wa2, wb, sc, post, L, lotsOf, balance }
}

test.group('Inventário | lotes, séries e FEFO (8.8)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('lotes no saldo: entrada por documento, FEFO nas saídas, expirados, transferência e contagem por lote', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Entrada por documento: o lote é criado com a validade.
    let d = ok(
      await o.api.post(`${I}/documents`, {
        docType: 'RECEIPT',
        warehouseId: o.wa.id,
        origin: 'OPENING',
        lines: [
          {
            productId: o.milk.id,
            uomId: o.un.id,
            quantity: '20',
            locationId: o.wa.bin.id,
            lotCode: 'L-LONGE',
            expiryDate: day(60),
          },
          {
            productId: o.milk.id,
            uomId: o.un.id,
            quantity: '10',
            locationId: o.wa.bin.id,
            lotCode: 'L-PERTO',
            expiryDate: day(5),
          },
        ],
      })
    )
    d = ok(
      await o.api.post(`${I}/documents/${d.id}/check`, {
        expectedVersion: d.version,
        lines: d.lines.map((l: any) => ({ lineId: l.id, checkedQuantity: l.quantity })),
      }),
      200
    )
    ok(
      await o.api.post(`${I}/documents/${d.id}/confirm`, {
        expectedVersion: d.version,
        idempotencyKey: key(),
      }),
      200
    )
    // Lote expirado (entra por ajuste, p.ex. achado numa contagem).
    await o.post('ADJUSTMENT', [
      o.L(o.wa, o.milk, '4', { lotCode: 'L-VELHO', expiryDate: day(-2) }),
    ])
    const lots = await o.lotsOf()
    assert.deepInclude(lots['L-PERTO'], {
      expiryDate: day(5),
      status: 'ACTIVE',
      stock: '10.000000',
      expired: false,
    })
    assert.isTrue(lots['L-VELHO'].expired)
    // Pesquisa por código e filtro de validade (expirados).
    assert.deepEqual(
      (ok(await o.api.get(`${I}/lots?q=perto`), 200) as any[]).map((x) => x.code),
      ['L-PERTO']
    )
    assert.deepEqual(
      (ok(await o.api.get(`${I}/lots?expiringWithinDays=0`), 200) as any[]).map((x) => x.code),
      ['L-VELHO']
    )
    // Uma validade diferente para o mesmo lote é recusada; entrada sem lote também.
    assert.equal(
      await errCode(
        o.post('RECEIPT', [o.L(o.wa, o.milk, '1', { lotCode: 'L-PERTO', expiryDate: day(9) })])
      ),
      'LOT_EXPIRY_MISMATCH'
    )
    assert.equal(await errCode(o.post('RECEIPT', [o.L(o.wa, o.milk, '1')])), 'LOT_REQUIRED')
    assert.equal(
      await errCode(
        o.post('RESERVATION', [
          {
            ...o.L(o.wa, o.milk, '1'),
            locationId: null,
            bucket: 'RESERVED',
            lotId: lots['L-PERTO'].id,
          },
        ])
      ),
      'LOT_NOT_ALLOWED'
    )

    // Saída sem lote: FEFO — primeiro o que expira antes (L-PERTO 10), depois L-LONGE; o expirado não sai.
    const issued = await o.post('ISSUE', [o.L(o.wa, o.milk, '-13')])
    assert.sameDeepMembers(
      issued.posting.lines.map((l: any) => [l.lot.code, l.quantity]),
      [
        ['L-PERTO', '-10.000000'],
        ['L-LONGE', '-3.000000'],
      ]
    )
    assert.equal(
      await errCode(o.post('ISSUE', [o.L(o.wa, o.milk, '-1', { lotId: lots['L-VELHO'].id })])),
      'LOT_EXPIRED'
    )
    // Só há 17 utilizáveis (4 expirados não contam).
    assert.equal(await errCode(o.post('ISSUE', [o.L(o.wa, o.milk, '-18')])), 'INSUFFICIENT_STOCK')
    // O expirado sai por ajuste (abate) e por mudança de estado.
    await o.post('ADJUSTMENT', [o.L(o.wa, o.milk, '-4', { lotId: lots['L-VELHO'].id })])

    // Transferência sem lote: o trânsito e a recepção levam os lotes que saíram (FEFO).
    await o.post('TRANSFER_OUT', [
      o.L(o.wa, o.milk, '-5'),
      {
        warehouseId: o.wa2.id,
        locationId: null,
        productId: o.milk.id,
        bucket: 'IN_TRANSIT',
        quantity: '5',
      },
    ])
    assert.equal(await o.balance(o.wa2, lots['L-LONGE'].id, 'inTransit'), 5)
    await o.post('TRANSFER_IN', [
      {
        warehouseId: o.wa2.id,
        locationId: null,
        productId: o.milk.id,
        bucket: 'IN_TRANSIT',
        quantity: '-5',
      },
      o.L(o.wa2, o.milk, '5'),
    ])
    assert.equal(await o.balance(o.wa2, lots['L-LONGE'].id), 5)
    assert.equal(await o.balance(o.wa, lots['L-LONGE'].id), 12)

    // Rastreabilidade: de onde veio, onde está, para onde foi.
    const trace = ok(await o.api.get(`${I}/lots/${lots['L-LONGE'].id}`), 200)
    assert.sameMembers(
      trace.balances.map((b: any) => `${b.warehouse.code}:${b.unrestricted}`),
      ['WA:12.000000', 'WA2:5.000000']
    )
    assert.include(
      trace.movements.map((m: any) => m.source.type),
      'STOCK_DOCUMENT'
    )
    assert.deepInclude(trace.destinations[0], { postingType: 'ISSUE', quantity: '3.000000' })
    assert.lengthOf(ok(await o.api.get(`${I}/stock/movements?lotId=${lots['L-PERTO'].id}`), 200), 2)
    // Estorno da saída: volta aos mesmos lotes.
    await runInTenant(o.sc, (scope) =>
      reverseStockPosting(scope, issued.posting.id, {
        idempotencyKey: key(),
        reason: 'Saída errada',
      })
    )
    assert.equal(await o.balance(o.wa, lots['L-PERTO'].id), 10)

    // Contagem por lote: uma linha por lote; o ajuste vai ao lote contado.
    let c = ok(
      await o.api.post(`${I}/counts`, { warehouseId: o.wa.id, description: 'Leite', blind: false })
    )
    c = ok(await o.api.post(`${I}/counts/${c.id}/start`, { expectedVersion: c.version }), 200)
    const longe = c.lines.find((l: any) => l.lot?.code === 'L-LONGE')
    assert.sameMembers(
      c.lines.map((l: any) => l.lot?.code),
      ['L-PERTO', 'L-LONGE']
    )
    c = ok(
      await o.api.post(`${I}/counts/${c.id}/count`, {
        expectedVersion: c.version,
        lines: c.lines.map((l: any) => ({ lineId: l.id, quantity: l === longe ? '11' : '10' })),
      }),
      200
    )
    c = ok(await o.api.post(`${I}/counts/${c.id}/submit`, { expectedVersion: c.version }), 200)
    c = ok(
      await o.api.post(`${I}/counts/${c.id}/justify`, {
        expectedVersion: c.version,
        lines: [{ lineId: longe.id, reasonCode: 'DAMAGE', justification: 'Pacote roto' }],
      }),
      200
    )
    const approver = await roleMember(client, o.s, 'aprova', [
      [['inventory.read', 'inventory.counts.approve'], 'TENANT'],
    ])
    ok(await approver.api.post(`${I}/counts/${c.id}/approve`, { expectedVersion: c.version }), 200)
    assert.equal(await o.balance(o.wa, lots['L-LONGE'].id), 11)
    assert.equal(await o.balance(o.wa, lots['L-PERTO'].id), 10)
    assert.lengthOf(ok(await o.api.get(`${I}/stock/reconciliation`), 200).differences, 0)
    // O rastreio já não muda com movimentos; validade exige lotes.
    assert.equal(
      code(
        await o.api.patch(`${I}/products/${o.milk.id}`, {
          expectedVersion: ok(await o.api.get(`${I}/products/${o.milk.id}`), 200).version,
          trackLots: false,
        })
      ),
      'VALIDATION_ERROR'
    )
    const bad = await o.api.post(`${I}/products`, {
      sku: 'SEMLOTE',
      name: 'Sem lotes',
      productType: 'STOCKABLE',
      baseUomId: o.un.id,
      trackExpiry: true,
    })
    assert.include(
      (bad.body().error?.details ?? []).map((x: any) => x.code),
      'EXPIRY_NEEDS_LOTS'
    )
  })

  test('bloqueio, desbloqueio e recolha: stock bloqueado, FEFO ignora, âmbito, reservas e imutabilidade', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    await o.post('RECEIPT', [
      o.L(o.wa, o.milk, '10', { lotCode: 'A1', expiryDate: day(10) }),
      o.L(o.wa, o.milk, '10', { lotCode: 'A2', expiryDate: day(20) }),
    ])
    await o.post('RECEIPT', [o.L(o.wb, o.milk, '3', { lotCode: 'A1' })])
    const lots = await o.lotsOf()
    const a1 = lots['A1']
    // Gestor de lotes só da entidade A: o A1 tem stock na B → fora do âmbito.
    const keeperA = await roleMember(client, o.s, 'lotes_a', [
      [['inventory.read', 'inventory.lots.manage'], 'LEGAL_ENTITY', o.leA.id],
    ])
    assert.equal(
      code(
        await keeperA.api.post(`${I}/lots/${a1.id}/block`, {
          expectedVersion: a1.version,
          reason: 'x',
        })
      ),
      'OUT_OF_SCOPE'
    )
    // Sem leitura: não vê.
    const nobody = await roleMember(client, o.s, 'nada', [[['inventory.counts.manage'], 'TENANT']])
    assert.equal((await nobody.api.get(`${I}/lots/${a1.id}`)).status(), 404)
    // Reserva que só cabe com o A1 livre: bloquear deixaria o reservado acima do livre.
    const res = await o.post('RESERVATION', [
      {
        warehouseId: o.wa.id,
        locationId: null,
        productId: o.milk.id,
        bucket: 'RESERVED',
        quantity: '15',
      },
    ])
    assert.equal(
      code(
        await o.api.post(`${I}/lots/${a1.id}/block`, {
          expectedVersion: a1.version,
          reason: 'Análise',
        })
      ),
      'OVER_RESERVED'
    )
    await runInTenant(o.sc, (scope) =>
      reverseStockPosting(scope, res.posting.id, { idempotencyKey: key(), reason: 'x' })
    )
    assert.include(
      (await o.api.post(`${I}/lots/${a1.id}/block`, { expectedVersion: a1.version }))
        .body()
        .error?.details?.map((x: any) => x.code) ?? [],
      'REQUIRED'
    )
    let lot = ok(
      await o.api.post(`${I}/lots/${a1.id}/block`, {
        expectedVersion: a1.version,
        reason: 'Análise laboratorial',
      }),
      200
    )
    assert.deepInclude(lot, { status: 'BLOCKED', blockReason: 'Análise laboratorial' })
    assert.equal(await o.balance(o.wa, a1.id), 0)
    assert.equal(await o.balance(o.wa, a1.id, 'blocked'), 10)
    assert.equal(await o.balance(o.wb, a1.id, 'blocked'), 3)
    // FEFO salta o lote bloqueado; entrada livre num lote bloqueado é recusada; recepção em quarentena é aceite.
    const out = await o.post('ISSUE', [o.L(o.wa, o.milk, '-2')])
    assert.equal(out.posting.lines[0].lot?.code, 'A2')
    assert.equal(
      await errCode(o.post('RECEIPT', [o.L(o.wa, o.milk, '1', { lotId: a1.id })])),
      'LOT_BLOCKED'
    )
    await o.post('RECEIPT', [o.L(o.wa, o.milk, '1', { lotId: a1.id, bucket: 'QUARANTINE' })])
    // Desbloqueio devolve o que o bloqueio moveu.
    lot = ok(
      await o.api.post(`${I}/lots/${a1.id}/unblock`, {
        expectedVersion: lot.version,
        reason: 'Análise conforme',
      }),
      200
    )
    assert.equal(lot.status, 'ACTIVE')
    assert.equal(await o.balance(o.wa, a1.id), 10)
    assert.equal(await o.balance(o.wb, a1.id), 3)
    // Recolha: definitiva, bloqueia o livre e lista para onde o lote foi.
    await o.post('ISSUE', [o.L(o.wa, o.milk, '-4', { lotId: a1.id })], {
      sourceType: 'INTERNAL_REQUISITION',
      sourceRef: 'RQ-9',
    })
    lot = ok(
      await o.api.post(`${I}/lots/${a1.id}/recall`, {
        expectedVersion: lot.version,
        reason: 'Contaminação no fornecedor',
      }),
      200
    )
    assert.equal(lot.status, 'RECALLED')
    assert.equal(await o.balance(o.wa, a1.id, 'blocked'), 6)
    assert.deepInclude(
      lot.destinations.find((x: any) => x.source.ref === 'RQ-9'),
      { quantity: '4.000000', warehouse: 'WA' }
    )
    assert.sameMembers(
      lot.events.map((e: any) => e.kind),
      ['BLOCKED', 'UNBLOCKED', 'RECALLED']
    )
    assert.equal(
      code(
        await o.api.post(`${I}/lots/${a1.id}/unblock`, {
          expectedVersion: lot.version,
          reason: 'x',
        })
      ),
      'INVALID_STATE'
    )
    // Do bloqueado sai por documento de saída (devolução ao fornecedor / destruição).
    await o.post('ISSUE', [o.L(o.wa, o.milk, '-6', { lotId: a1.id, bucket: 'BLOCKED' })])
    // A base não deixa voltar atrás uma recolha nem alterar eventos.
    await assert.rejects(() =>
      owner().rawQuery(
        `update stock_lots set status = 'ACTIVE', recall_reason = null, recalled_at = null where id = ?`,
        [a1.id]
      )
    )
    await assert.rejects(() =>
      owner().rawQuery('delete from stock_lot_events where tenant_id = ?', [o.tenant.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update stock_lots set expiry_date = '2099-01-01' where id = ?`, [a1.id])
    )
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where tenant_id = ? and entity_type = 'stock_lot'`,
      [o.tenant.id]
    )
    assert.sameMembers(
      audits.rows.map((x: any) => x.action),
      ['inventory.lot.blocked', 'inventory.lot.unblocked', 'inventory.lot.recalled']
    )
    // Versão desactualizada.
    assert.equal(
      code(
        await o.api.post(`${I}/lots/${lots['A2'].id}/block`, { expectedVersion: 99, reason: 'x' })
      ),
      'VERSION_CONFLICT'
    )
  })

  test('séries: entrada com séries, duplicados, saída automática e indicada, transferência, estorno, histórico e concorrência', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const T = (w: any, q: string, extra: Record<string, unknown> = {}) => o.L(w, o.phone, q, extra)
    assert.equal(await errCode(o.post('RECEIPT', [T(o.wa, '2')])), 'SERIALS_REQUIRED')
    assert.equal(
      await errCode(o.post('RECEIPT', [T(o.wa, '2', { serials: ['S1'] })])),
      'SERIAL_COUNT'
    )
    await o.post('RECEIPT', [T(o.wa, '3', { serials: ['S1', 'S2', 'S3'] })])
    assert.equal(
      await errCode(o.post('RECEIPT', [T(o.wa2, '1', { serials: ['S2'] })])),
      'SERIAL_IN_STOCK'
    )
    // Saída sem séries: a mais antiga; com série indicada: essa (e tem de estar ali).
    const a = await o.post('ISSUE', [T(o.wa, '-1')])
    assert.equal(
      await errCode(o.post('ISSUE', [T(o.wa, '-1', { serials: ['S1'] })])),
      'SERIAL_NOT_HERE'
    )
    await o.post('ISSUE', [T(o.wa, '-1', { serials: ['S3'] })])
    let found = ok(await o.api.get(`${I}/serials?q=S`), 200) as any[]
    const status = Object.fromEntries(found.map((x) => [x.serial, x.status]))
    assert.deepEqual(status, { S1: 'OUT', S2: 'IN_STOCK', S3: 'OUT' })
    // Transferência: a série viaja; estorno da saída devolve a S1 ao WA.
    await o.post('TRANSFER_OUT', [
      T(o.wa, '-1'),
      {
        warehouseId: o.wa2.id,
        locationId: null,
        productId: o.phone.id,
        bucket: 'IN_TRANSIT',
        quantity: '1',
      },
    ])
    await o.post('TRANSFER_IN', [
      {
        warehouseId: o.wa2.id,
        locationId: null,
        productId: o.phone.id,
        bucket: 'IN_TRANSIT',
        quantity: '-1',
      },
      T(o.wa2, '1'),
    ])
    await runInTenant(o.sc, (scope) =>
      reverseStockPosting(scope, a.posting.id, { idempotencyKey: key(), reason: 'Saída errada' })
    )
    found = ok(await o.api.get(`${I}/serials?q=S`), 200) as any[]
    const where = Object.fromEntries(
      found.map((x) => [x.serial, `${x.status}:${x.warehouse ?? '-'}`])
    )
    assert.deepEqual(where, { S1: 'IN_STOCK:WA', S2: 'IN_STOCK:WA2', S3: 'OUT:-' })
    const s2 = ok(await o.api.get(`${I}/serials/${found.find((x) => x.serial === 'S2').id}`), 200)
    assert.deepEqual(
      s2.history.map((h: any) => `${h.type}:${h.direction}:${h.warehouse}:${h.bucket}`),
      [
        'RECEIPT:IN:WA:UNRESTRICTED',
        'TRANSFER_OUT:OUT:WA:UNRESTRICTED',
        'TRANSFER_OUT:IN:WA2:IN_TRANSIT',
        'TRANSFER_IN:OUT:WA2:IN_TRANSIT',
        'TRANSFER_IN:IN:WA2:UNRESTRICTED',
      ]
    )
    // Uma série que saiu pode voltar a entrar (devolução).
    await o.post('RECEIPT', [T(o.wa, '1', { serials: ['S3'] })])
    // Concorrência: duas saídas da mesma única série em simultâneo — uma passa.
    const results = await Promise.allSettled([
      o.post('ISSUE', [T(o.wa, '-1', { serials: ['S3'] })]),
      o.post('ISSUE', [T(o.wa, '-1', { serials: ['S3'] })]),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    // A série e o saldo continuam coerentes; nada fica negativo.
    const rows = ok(await o.api.get(`${I}/stock/balances?productId=${o.phone.id}`), 200) as any[]
    const inStock = await owner().rawQuery(
      `select warehouse_id, count(*)::int as n from stock_serials where tenant_id = ? and status = 'IN_STOCK' group by warehouse_id`,
      [o.tenant.id]
    )
    for (const r of rows)
      assert.equal(
        Number(r.physical),
        inStock.rows.find((x: any) => x.warehouse_id === r.warehouse.id)?.n ?? 0
      )
    // Movimentos de séries só de acréscimo; contagem com diferença numa série → regulariza-se por documento.
    await assert.rejects(() =>
      owner().rawQuery('delete from stock_serial_movements where tenant_id = ?', [o.tenant.id])
    )
    let c = ok(
      await o.api.post(`${I}/counts`, {
        warehouseId: o.wa.id,
        description: 'Telemóveis',
        blind: false,
      })
    )
    c = ok(await o.api.post(`${I}/counts/${c.id}/start`, { expectedVersion: c.version }), 200)
    c = ok(
      await o.api.post(`${I}/counts/${c.id}/count`, {
        expectedVersion: c.version,
        lines: [{ lineId: c.lines[0].id, quantity: '0' }],
      }),
      200
    )
    c = ok(await o.api.post(`${I}/counts/${c.id}/submit`, { expectedVersion: c.version }), 200)
    c = ok(
      await o.api.post(`${I}/counts/${c.id}/justify`, {
        expectedVersion: c.version,
        lines: [{ lineId: c.lines[0].id, reasonCode: 'THEFT_LOSS', justification: 'Falta' }],
      }),
      200
    )
    const approver = await roleMember(client, o.s, 'aprova', [
      [['inventory.read', 'inventory.counts.approve'], 'TENANT'],
    ])
    const r = await approver.api.post(`${I}/counts/${c.id}/approve`, { expectedVersion: c.version })
    assert.include(r.body().error?.details?.map((x: any) => x.code) ?? [], 'SERIALS_REQUIRED')
    // Fora do âmbito de leitura: as séries noutros armazéns não mostram onde estão.
    const onlyB = await roleMember(client, o.s, 'le_b', [
      [['inventory.read'], 'LEGAL_ENTITY', o.leB.id],
    ])
    const seen = ok(await onlyB.api.get(`${I}/serials?q=S2`), 200) as any[]
    assert.isNull(seen[0].warehouse)
  })
})
