import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { postStock, reverseStockPosting, type PostStockInput } from '#modules/inventory/index'
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
const ST = `${I}/stock`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
let seq = 0
const key = (p = 'k') => `${p}-${Date.now()}-${++seq}`

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
  const ctx = (await as(client, m.session).get('/api/v1/context')).body().data
  return { api: as(client, m.session), memberId: m.memberId, ctx }
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
  const leA = await le('LEA', '5000000821')
  const leB = await le('LEB', '5000000822')
  const S = `${I}/settings`
  const un = ok(await api.post(`${S}/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' }))
  const kg = ok(
    await api.post(`${S}/uoms`, { code: 'KG', name: 'Quilo', category: 'WEIGHT', decimals: 3 })
  )
  const h = ok(
    await api.post(`${S}/uoms`, { code: 'H', name: 'Hora', category: 'TIME', decimals: 2 })
  )
  const P = (b: Record<string, unknown>) => api.post(`${I}/products`, b)
  const water = ok(
    await P({ sku: 'AGUA', name: 'Água', productType: 'STOCKABLE', baseUomId: un.id })
  )
  const rice = ok(
    await P({ sku: 'ARROZ', name: 'Arroz', productType: 'STOCKABLE', baseUomId: kg.id })
  )
  const shirt = ok(
    await P({ sku: 'CAM', name: 'Camisa', productType: 'STOCKABLE', baseUomId: un.id })
  )
  const blue = ok(
    await api.post(`${I}/products/${shirt.id}/variants`, {
      sku: 'CAM-AZ',
      attributes: { Cor: 'Azul' },
    })
  ).variants[0]
  const service = ok(
    await P({ sku: 'MANUT', name: 'Manutenção', productType: 'SERVICE', baseUomId: h.id })
  )
  const W = `${I}/warehouses`
  const wa = ok(
    await api.post(W, {
      code: 'WA',
      name: 'Central A',
      legalEntityId: leA.id,
      warehouseType: 'MAIN',
    })
  )
  const wb = ok(
    await api.post(W, { code: 'WB', name: 'Loja B', legalEntityId: leB.id, warehouseType: 'STORE' })
  )
  const zone = ok(await api.post(`${W}/${wa.id}/locations`, { code: 'Z1', holdsStock: false }))
  const z1 = zone.locations.find((l: any) => l.pathCode === 'Z1')
  const withBin = ok(
    await api.post(`${W}/${wa.id}/locations`, { parentId: z1.id, code: 'C1', holdsStock: true })
  )
  const bin = withBin.locations.find((l: any) => l.pathCode === 'Z1-C1')
  const ctx = (await api.get('/api/v1/context')).body().data
  const context = {
    tenantId: tenant.id,
    userId: admin.id,
    membershipId: ctx.membershipId,
    requestId: 'teste',
  }
  const post = (
    input: Omit<PostStockInput, 'idempotencyKey' | 'sourceType'> & Partial<PostStockInput>
  ) =>
    runInTenant(context, (scope) =>
      postStock(scope, { idempotencyKey: key(), sourceType: 'TEST', ...input })
    )
  return {
    tenant,
    admin,
    s,
    api,
    leA,
    leB,
    un,
    water,
    rice,
    shirt,
    blue,
    service,
    wa,
    wb,
    z1,
    bin,
    context,
    post,
  }
}

const balanceOf = async (api: any, q: string) =>
  ok(await api.get(`${ST}/balances?${q}`), 200) as any[]
const rejects = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch (e: any) {
    return { code: e.code as string, details: (e.details ?? []).map((d: any) => d.code) }
  }
  throw new Error('deveria ter falhado')
}

test.group('Inventário | stock (8.3)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('lançamentos: saldos derivados, baldes separados, reservado e regras por tipo', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const at = { warehouseId: o.wa.id, locationId: o.bin.id, productId: o.water.id }
    const wh = { warehouseId: o.wa.id, productId: o.water.id }
    // Validações do contrato.
    assert.include(
      (
        await rejects(() =>
          o.post({ type: 'RECEIPT', lines: [{ ...at, bucket: 'UNRESTRICTED', quantity: '-5' }] })
        )
      ).details,
      'BUCKET_NOT_ALLOWED'
    )
    assert.include(
      (
        await rejects(() =>
          o.post({ type: 'RECEIPT', lines: [{ ...at, bucket: 'UNRESTRICTED', quantity: '1.5' }] })
        )
      ).details,
      'DECIMALS'
    )
    assert.include(
      (
        await rejects(() =>
          o.post({
            type: 'RECEIPT',
            lines: [{ ...at, productId: o.service.id, bucket: 'UNRESTRICTED', quantity: '1' }],
          })
        )
      ).details,
      'NOT_STOCKABLE'
    )
    assert.include(
      (
        await rejects(() =>
          o.post({
            type: 'RECEIPT',
            lines: [{ ...at, productId: o.shirt.id, bucket: 'UNRESTRICTED', quantity: '1' }],
          })
        )
      ).details,
      'REQUIRED'
    )
    assert.include(
      (
        await rejects(() =>
          o.post({
            type: 'RECEIPT',
            lines: [{ ...at, locationId: o.z1.id, bucket: 'UNRESTRICTED', quantity: '1' }],
          })
        )
      ).details,
      'NOT_HOLDING'
    )
    assert.include(
      (
        await rejects(() =>
          o.post({
            type: 'RECEIPT',
            lines: [{ ...at, warehouseId: o.wb.id, bucket: 'UNRESTRICTED', quantity: '1' }],
          })
        )
      ).details,
      'NOT_FOUND'
    )
    assert.include(
      (
        await rejects(() =>
          o.post({ type: 'RESERVATION', lines: [{ ...at, bucket: 'RESERVED', quantity: '1' }] })
        )
      ).details,
      'NO_LOCATION'
    )
    assert.include(
      (
        await rejects(() =>
          o.post({ type: 'STATUS_CHANGE', lines: [{ ...at, bucket: 'BLOCKED', quantity: '1' }] })
        )
      ).details,
      'NOT_BALANCED'
    )
    assert.equal(
      (
        await rejects(() =>
          o.post({ type: 'ISSUE', lines: [{ ...at, bucket: 'UNRESTRICTED', quantity: '-1' }] })
        )
      ).code,
      'INSUFFICIENT_STOCK'
    )

    // Entrada prevista, recepção que a consome, variante e quilos com 3 casas.
    await o.post({
      type: 'EXPECTED',
      lines: [{ ...wh, locationId: null, bucket: 'EXPECTED', quantity: '100' }],
    })
    const receipt = await o.post({
      type: 'RECEIPT',
      sourceRef: 'GR 1',
      lines: [
        { ...at, bucket: 'UNRESTRICTED', quantity: '80' },
        { ...at, bucket: 'QUARANTINE', quantity: '20' },
        { ...wh, bucket: 'EXPECTED', quantity: '-100' },
        {
          ...at,
          productId: o.shirt.id,
          variantId: o.blue.id,
          bucket: 'UNRESTRICTED',
          quantity: '3',
        },
        { ...at, productId: o.rice.id, bucket: 'UNRESTRICTED', quantity: '12.345' },
      ],
    })
    assert.isFalse(receipt.replayed)
    assert.lengthOf(receipt.posting.lines, 5)
    let rows = await balanceOf(o.api, `productId=${o.water.id}`)
    const loc = rows.find((r) => r.location?.id === o.bin.id)
    assert.equal(loc.physical, '100.000000')
    assert.equal(loc.available, '80.000000')
    assert.equal(loc.quarantine, '20.000000')
    // O saldo do previsto chegou a zero e deixou de aparecer (só saldos não nulos por omissão).
    assert.isUndefined(rows.find((r) => r.location === null))
    assert.equal((await balanceOf(o.api, `productId=${o.rice.id}`))[0].physical, '12.345000')

    // Reservado reduz o disponível, não o físico; não pode exceder o livre do armazém.
    await o.post({ type: 'RESERVATION', lines: [{ ...wh, bucket: 'RESERVED', quantity: '30' }] })
    rows = await balanceOf(o.api, `productId=${o.water.id}`)
    const sum = (f: string) => rows.reduce((s, r) => s + Number(r[f]), 0)
    assert.equal(sum('physical'), 100)
    assert.equal(sum('reserved'), 30)
    assert.equal(sum('unrestricted') - sum('reserved'), 50)
    assert.equal(
      (
        await rejects(() =>
          o.post({ type: 'RESERVATION', lines: [{ ...wh, bucket: 'RESERVED', quantity: '51' }] })
        )
      ).code,
      'OVER_RESERVED'
    )
    // Saída do livre sem baixar a reserva deixaria o reservado acima do livre.
    assert.equal(
      (
        await rejects(() =>
          o.post({ type: 'ISSUE', lines: [{ ...at, bucket: 'UNRESTRICTED', quantity: '-60' }] })
        )
      ).code,
      'OVER_RESERVED'
    )
    // Saída que consome a reserva: a ordem das linhas não importa.
    await o.post({
      type: 'ISSUE',
      lines: [
        { ...wh, bucket: 'RESERVED', quantity: '-30' },
        { ...at, bucket: 'UNRESTRICTED', quantity: '-30' },
      ],
    })

    // Mudança de estado pela API: livre → bloqueado (físico igual, disponível menor).
    const blocked = ok(
      await o.api.post(`${ST}/status-changes`, {
        ...at,
        from: 'UNRESTRICTED',
        to: 'BLOCKED',
        quantity: '5',
        reason: 'Embalagem danificada',
        idempotencyKey: key('st'),
      })
    )
    assert.equal(blocked.type, 'STATUS_CHANGE')
    assert.deepEqual(
      blocked.lines.map((l: any) => [l.bucket, l.quantity]),
      [
        ['UNRESTRICTED', '-5.000000'],
        ['BLOCKED', '5.000000'],
      ]
    )
    rows = await balanceOf(o.api, `productId=${o.water.id}`)
    assert.equal(rows[0].physical, '70.000000')
    assert.equal(rows[0].available, '45.000000')
    assert.equal(rows[0].blocked, '5.000000')
    assert.equal(
      code(
        await o.api.post(`${ST}/status-changes`, {
          ...at,
          from: 'BLOCKED',
          to: 'UNRESTRICTED',
          quantity: '6',
          reason: 'x',
          idempotencyKey: key('st'),
        })
      ),
      'INSUFFICIENT_STOCK'
    )

    // Movimentos (kardex) e lançamento.
    const moves = ok(
      await o.api.get(`${ST}/movements?productId=${o.water.id}&warehouseId=${o.wa.id}`),
      200
    )
    assert.isAtLeast(moves.length, 7)
    assert.equal(moves[0].type, 'STATUS_CHANGE')
    const p = ok(await o.api.get(`${ST}/postings/${receipt.posting.id}`), 200)
    assert.equal(p.source.ref, 'GR 1')
    assert.equal(p.createdBy !== null, true)

    // Auditoria de cada lançamento.
    const audits = await owner().rawQuery(
      `select count(*)::int as n from audit_events where tenant_id = ? and action = 'inventory.stock.posted'`,
      [o.tenant.id]
    )
    assert.isAtLeast(audits.rows[0].n, 5)

    // Reconciliação: saldos = soma dos movimentos.
    const rec = ok(await o.api.get(`${ST}/reconciliation`), 200)
    assert.isAbove(rec.checked, 0)
    assert.lengthOf(rec.differences, 0)
  })

  test('idempotência e estornos: repetir não duplica; estorno único; nada se reescreve', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const line = { warehouseId: o.wa.id, locationId: o.bin.id, productId: o.water.id }
    const k = key('rcpt')
    const input = {
      type: 'RECEIPT' as const,
      idempotencyKey: k,
      lines: [{ ...line, bucket: 'UNRESTRICTED' as const, quantity: '10' }],
    }
    const first = await o.post(input)
    const again = await o.post({
      ...input,
      lines: [{ ...line, bucket: 'UNRESTRICTED', quantity: '10.000' }],
    })
    assert.isTrue(again.replayed)
    assert.equal(again.posting.id, first.posting.id)
    assert.equal(
      (
        await rejects(() =>
          o.post({ ...input, lines: [{ ...line, bucket: 'UNRESTRICTED', quantity: '11' }] })
        )
      ).code,
      'IDEMPOTENCY_MISMATCH'
    )
    assert.equal((await balanceOf(o.api, `productId=${o.water.id}`))[0].physical, '10.000000')

    // Estorno: novo lançamento inverso, uma só vez; um estorno não se estorna.
    const rev = (id: string, k2 = key('rev')) =>
      runInTenant(o.context, (scope) =>
        reverseStockPosting(scope, id, { idempotencyKey: k2, reason: 'Recepção em duplicado' })
      )
    assert.include(
      (
        await rejects(() =>
          runInTenant(o.context, (scope) =>
            reverseStockPosting(scope, first.posting.id, { idempotencyKey: key(), reason: ' ' })
          )
        )
      ).details,
      'REQUIRED'
    )
    const k2 = key('rev')
    const r1 = await rev(first.posting.id, k2)
    assert.equal(r1.posting.type, 'REVERSAL')
    assert.equal(r1.posting.reversalOf, first.posting.id)
    assert.equal(r1.posting.lines[0].quantity, '-10.000000')
    assert.isTrue((await rev(first.posting.id, k2)).replayed)
    assert.equal((await rejects(() => rev(first.posting.id))).code, 'ALREADY_REVERSED')
    assert.equal((await rejects(() => rev(r1.posting.id))).code, 'REVERSAL_OF_REVERSAL')
    assert.lengthOf(await balanceOf(o.api, `productId=${o.water.id}`), 0)
    const orig = ok(await o.api.get(`${ST}/postings/${first.posting.id}`), 200)
    assert.equal(orig.reversedBy, r1.posting.id)
    // Estornar uma entrada já consumida falha (ficaria negativo).
    const k3 = await o.post({
      type: 'RECEIPT',
      lines: [{ ...line, bucket: 'UNRESTRICTED', quantity: '5' }],
    })
    await o.post({ type: 'ISSUE', lines: [{ ...line, bucket: 'UNRESTRICTED', quantity: '-4' }] })
    assert.equal((await rejects(() => rev(k3.posting.id))).code, 'INSUFFICIENT_STOCK')

    // A base de dados recusa reescrever movimentos/lançamentos e escrever saldos directamente.
    const tid = o.tenant.id
    await assert.rejects(() =>
      owner().rawQuery('update stock_movements set quantity = 1 where tenant_id = ?', [tid])
    )
    await assert.rejects(() =>
      owner().rawQuery('delete from stock_postings where tenant_id = ?', [tid])
    )
    await assert.rejects(() =>
      owner().rawQuery('update stock_balances set qty_unrestricted = 999 where tenant_id = ?', [
        tid,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(
        `insert into stock_balances (tenant_id, warehouse_id, product_id, qty_unrestricted) values (?, ?, ?, 5)`,
        [tid, o.wb.id, o.water.id]
      )
    )
    // Mesmo inserindo movimentos à mão, o reservado acima do livre falha no fim da transacção.
    const trx = await owner().transaction()
    const raw = await trx.rawQuery(
      `insert into stock_postings (tenant_id, posting_type, idempotency_key, request_hash, source_type)
         values (?, 'RESERVATION', ?, 'x', 'TEST') returning id`,
      [tid, key('raw')]
    )
    await trx.rawQuery(
      `insert into stock_movements (tenant_id, posting_id, line_no, warehouse_id, product_id, bucket, quantity, occurred_at)
         values (?, ?, 1, ?, ?, 'RESERVED', 50, now())`,
      [tid, raw.rows[0].id, o.wa.id, o.water.id]
    )
    await assert.rejects(
      () => trx.rawQuery('set constraints stock_balances_reserved immediate'),
      /STOCK_OVER_RESERVED/
    )
    await trx.rollback()
    // Sem pedir a verificação imediata, o COMMIT falha na base e nada fica gravado.
    const rawKey = key('raw')
    const trx2 = await owner().transaction()
    const raw2 = await trx2.rawQuery(
      `insert into stock_postings (tenant_id, posting_type, idempotency_key, request_hash, source_type)
         values (?, 'RESERVATION', ?, 'x', 'TEST') returning id`,
      [tid, rawKey]
    )
    await trx2.rawQuery(
      `insert into stock_movements (tenant_id, posting_id, line_no, warehouse_id, product_id, bucket, quantity, occurred_at)
         values (?, ?, 1, ?, ?, 'RESERVED', 50, now())`,
      [tid, raw2.rows[0].id, o.wa.id, o.water.id]
    )
    await trx2.commit().catch(() => {})
    const kept = await owner().rawQuery(
      'select count(*)::int as n from stock_postings where idempotency_key = ?',
      [rawKey]
    )
    assert.equal(kept.rows[0].n, 0)
    const rec = ok(await o.api.get(`${ST}/reconciliation`), 200)
    assert.lengthOf(rec.differences, 0)
  })

  test('concorrência: saídas em paralelo nunca deixam stock negativo; a mesma chave grava uma vez', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const line = { warehouseId: o.wa.id, locationId: o.bin.id, productId: o.water.id }
    await o.post({ type: 'RECEIPT', lines: [{ ...line, bucket: 'UNRESTRICTED', quantity: '5' }] })
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        o.post({ type: 'ISSUE', lines: [{ ...line, bucket: 'UNRESTRICTED', quantity: '-1' }] })
      )
    )
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5)
    for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[])
      assert.equal(r.reason.code, 'INSUFFICIENT_STOCK')
    assert.lengthOf(await balanceOf(o.api, `productId=${o.water.id}`), 0)

    const k = key('same')
    const same = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        o.post({
          type: 'RECEIPT',
          idempotencyKey: k,
          lines: [{ ...line, bucket: 'UNRESTRICTED', quantity: '2' }],
        })
      )
    )
    const done = same.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[]
    assert.lengthOf(done, 5)
    assert.lengthOf(new Set(done.map((d) => d.value.posting.id)), 1)
    assert.equal(done.filter((d) => !d.value.replayed).length, 1)
    assert.equal((await balanceOf(o.api, `productId=${o.water.id}`))[0].physical, '2.000000')
    const rec = ok(await o.api.get(`${ST}/reconciliation`), 200)
    assert.lengthOf(rec.differences, 0)
  })

  test('acesso: saldos e movimentos só dos armazéns visíveis; mudar estado exige permissão e acesso', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const at = (w: any, loc: any = null) => ({
      warehouseId: w.id,
      locationId: loc?.id ?? null,
      productId: o.water.id,
    })
    await o.post({
      type: 'RECEIPT',
      lines: [{ ...at(o.wa, o.bin), bucket: 'UNRESTRICTED', quantity: '10' }],
    })
    const pb = await o.post({
      type: 'RECEIPT',
      lines: [{ ...at(o.wb), bucket: 'UNRESTRICTED', quantity: '7' }],
    })

    const readerA = await roleMember(
      client,
      o.s,
      'ler_a',
      ['inventory.read'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    let rows = ok(await readerA.api.get(`${ST}/balances`), 200)
    assert.deepEqual(
      rows.map((r: any) => r.warehouse.code),
      ['WA']
    )
    assert.isTrue(
      ok(await readerA.api.get(`${ST}/movements`), 200).every((m: any) => m.warehouse.code === 'WA')
    )
    assert.equal((await readerA.api.get(`${ST}/postings/${pb.posting.id}`)).status(), 404)
    const body = {
      ...at(o.wa, o.bin),
      from: 'UNRESTRICTED',
      to: 'QUARANTINE',
      quantity: '1',
      reason: 'Inspecção',
      idempotencyKey: key('st'),
    }
    assert.equal(code(await readerA.api.post(`${ST}/status-changes`, body)), 'OUT_OF_SCOPE')

    // Gestor de stock da entidade A, mas WA passa a restrito sem ele na lista: não vê nem opera.
    const stockA = await roleMember(
      client,
      o.s,
      'stock_a',
      ['inventory.read', 'inventory.stock.manage'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    ok(await stockA.api.post(`${ST}/status-changes`, body))
    const wa = ok(await o.api.get(`${I}/warehouses/${o.wa.id}`), 200)
    ok(
      await o.api.patch(`${I}/warehouses/${o.wa.id}`, {
        accessMode: 'RESTRICTED',
        expectedVersion: wa.version,
      }),
      200
    )
    assert.lengthOf(ok(await stockA.api.get(`${ST}/balances`), 200), 0)
    assert.equal(
      (
        await stockA.api.post(`${ST}/status-changes`, { ...body, idempotencyKey: key('st') })
      ).status(),
      404
    )
    // Na lista só para consultar: vê, mas não opera.
    ok(
      await o.api.put(`${I}/warehouses/${o.wa.id}/access`, {
        membershipId: stockA.ctx.membershipId,
        level: 'VIEW',
      }),
      200
    )
    rows = ok(await stockA.api.get(`${ST}/balances`), 200)
    assert.equal(rows[0].quarantine, '1.000000')
    assert.equal(
      code(await stockA.api.post(`${ST}/status-changes`, { ...body, idempotencyKey: key('st') })),
      'NO_OPERATE'
    )
    ok(
      await o.api.put(`${I}/warehouses/${o.wa.id}/access`, {
        membershipId: stockA.ctx.membershipId,
        level: 'OPERATE',
      }),
      200
    )
    ok(await stockA.api.post(`${ST}/status-changes`, { ...body, idempotencyKey: key('st') }))
    // Sem permissão de leitura nenhuma: 403 nas rotas? Não — lista vazia (a API só filtra).
    const nobody = await roleMember(client, o.s, 'nada', ['hr.read'])
    assert.lengthOf(ok(await nobody.api.get(`${ST}/balances`), 200), 0)
  })
})
