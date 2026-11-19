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

const I = '/api/v1/inventory'
const D = `${I}/documents`
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
  const leA = await le('LEA', '5000000831')
  const leB = await le('LEB', '5000000832')
  for (const [documentType, c, prefix] of [
    ['STOCK_RECEIPT', 'ENT', 'ENT-'],
    ['STOCK_ISSUE', 'SAI', 'SAI-'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: leA.id,
        documentType,
        code: c,
        prefix,
      })
    )
  const S = `${I}/settings`
  const un = ok(await api.post(`${S}/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' }))
  const cx = ok(await api.post(`${S}/uoms`, { code: 'CX', name: 'Caixa', category: 'UNIT' }))
  const P = (b: Record<string, unknown>) => api.post(`${I}/products`, b)
  const water = ok(
    await P({
      sku: 'AGUA',
      name: 'Água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      purchaseUomId: cx.id,
      conversions: [{ uomId: cx.id, factor: '24' }],
    })
  )
  const milk = ok(
    await P({
      sku: 'LEITE',
      name: 'Leite',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      trackLots: true,
      trackExpiry: true,
    })
  )
  const phone = ok(
    await P({
      sku: 'TEL',
      name: 'Telefone',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      trackSerials: true,
    })
  )
  const W = `${I}/warehouses`
  const wa = ok(
    await api.post(W, { code: 'WA', name: 'Central', legalEntityId: leA.id, warehouseType: 'MAIN' })
  )
  const wb = ok(
    await api.post(W, { code: 'WB', name: 'Loja B', legalEntityId: leB.id, warehouseType: 'STORE' })
  )
  let w = ok(await api.post(`${W}/${wa.id}/locations`, { code: 'Z1' }))
  const z1 = w.locations[0]
  w = ok(
    await api.post(`${W}/${wa.id}/locations`, { parentId: z1.id, code: 'P1', holdsStock: true })
  )
  const bin = w.locations.find((l: any) => l.pathCode === 'Z1-P1')
  const balance = async (productId: string) => {
    const rows = ok(await api.get(`${I}/stock/balances?productId=${productId}`), 200) as any[]
    return rows.reduce((t, r) => t + Number(r.physical), 0)
  }
  return { tenant, admin, s, api, leA, leB, un, cx, water, milk, phone, wa, wb, z1, bin, balance }
}

type O = Awaited<ReturnType<typeof setup>>
const lineOf = (doc: any, sku: string) => doc.lines.find((l: any) => l.product.sku === sku)
/** Conferir as quantidades indicadas (por SKU) e confirmar. */
async function checkAndConfirm(o: O, doc: any, qty: Record<string, string>, api = o.api) {
  const checked = ok(
    await api.post(`${D}/${doc.id}/check`, {
      expectedVersion: doc.version,
      lines: doc.lines.map((l: any) => ({
        lineId: l.id,
        checkedQuantity: qty[l.product.sku] ?? '0',
      })),
    }),
    200
  )
  return ok(
    await api.post(`${D}/${doc.id}/confirm`, {
      expectedVersion: checked.version,
      idempotencyKey: key(),
    }),
    200
  )
}

test.group('Inventário | entradas e saídas (8.4)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('entrada: rascunho, conferência, confirmações parciais, número, idempotência, estorno e fecho', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const base = { docType: 'RECEIPT', warehouseId: o.wa.id, origin: 'PURCHASE' }
    const waterLine = {
      productId: o.water.id,
      uomId: o.cx.id,
      quantity: '10',
      locationId: o.bin.id,
      unitCost: '1200',
    }
    const milkLine = {
      productId: o.milk.id,
      uomId: o.un.id,
      quantity: '5',
      locationId: o.bin.id,
      lotCode: 'L-2026-01',
      expiryDate: '2027-01-31',
      bucket: 'QUARANTINE',
    }
    // Validações.
    assert.include(details(await o.api.post(D, { ...base, lines: [] })), 'REQUIRED')
    assert.include(
      details(await o.api.post(D, { ...base, origin: 'SALE', lines: [waterLine] })),
      'INVALID'
    )
    assert.include(
      details(await o.api.post(D, { ...base, documentDate: '2999-01-01', lines: [waterLine] })),
      'FUTURE'
    )
    assert.include(
      details(await o.api.post(D, { ...base, lines: [{ ...waterLine, productId: o.milk.id }] })),
      'NO_CONVERSION'
    )
    assert.include(
      details(await o.api.post(D, { ...base, lines: [{ ...milkLine, lotCode: undefined }] })),
      'REQUIRED'
    )
    assert.include(
      details(await o.api.post(D, { ...base, lines: [{ ...milkLine, expiryDate: undefined }] })),
      'REQUIRED'
    )
    assert.include(
      details(
        await o.api.post(D, {
          ...base,
          lines: [{ productId: o.phone.id, uomId: o.un.id, quantity: '2', serials: ['S1'] }],
        })
      ),
      'SERIAL_COUNT'
    )
    assert.include(
      details(await o.api.post(D, { ...base, lines: [{ ...waterLine, quantity: '1.5' }] })),
      'DECIMALS'
    )
    assert.include(
      details(await o.api.post(D, { ...base, lines: [{ ...waterLine, locationId: o.z1.id }] })),
      'NOT_HOLDING'
    )

    // Rascunho: não mexe no stock; editável com versão.
    let doc = ok(
      await o.api.post(D, { ...base, originRef: 'FT 2026/15', lines: [waterLine, milkLine] })
    )
    assert.equal(doc.status, 'DRAFT')
    assert.isNull(doc.number)
    assert.equal(doc.currency, 'AOA')
    assert.equal(lineOf(doc, 'AGUA').baseQuantity, '240.000000')
    assert.equal(await o.balance(o.water.id), 0)
    assert.equal(
      code(await o.api.put(`${D}/${doc.id}`, { ...base, expectedVersion: 99, lines: [waterLine] })),
      'VERSION_CONFLICT'
    )
    doc = ok(
      await o.api.put(`${D}/${doc.id}`, {
        ...base,
        originRef: 'FT 2026/15',
        expectedVersion: doc.version,
        lines: [{ ...waterLine, quantity: '12' }, milkLine],
      }),
      200
    )
    assert.equal(lineOf(doc, 'AGUA').quantity, '12.000000')
    assert.equal(
      code(
        await o.api.post(`${D}/${doc.id}/confirm`, {
          expectedVersion: doc.version,
          idempotencyKey: key(),
        })
      ),
      'INVALID_STATE'
    )

    // Conferência parcial: 7 de 12 caixas; o leite fica para depois.
    const w = lineOf(doc, 'AGUA')
    assert.include(
      details(
        await o.api.post(`${D}/${doc.id}/check`, {
          expectedVersion: doc.version,
          lines: [{ lineId: w.id, checkedQuantity: '13' }],
        })
      ),
      'INVALID'
    )
    assert.equal(
      code(await o.api.post(`${D}/${doc.id}/check`, { expectedVersion: doc.version, lines: [] })),
      'VALIDATION_ERROR'
    )
    doc = ok(
      await o.api.post(`${D}/${doc.id}/check`, {
        expectedVersion: doc.version,
        lines: [{ lineId: w.id, checkedQuantity: '7', differenceReason: 'Faltam 5 caixas' }],
      }),
      200
    )
    assert.equal(doc.status, 'CHECKED')
    assert.equal(await o.balance(o.water.id), 0)
    // Reabrir e voltar a conferir.
    doc = ok(await o.api.post(`${D}/${doc.id}/reopen`, { expectedVersion: doc.version }), 200)
    assert.equal(doc.status, 'DRAFT')
    assert.isNull(lineOf(doc, 'AGUA').checkedQuantity)
    doc = ok(
      await o.api.post(`${D}/${doc.id}/check`, {
        expectedVersion: doc.version,
        lines: [{ lineId: w.id, checkedQuantity: '7' }],
      }),
      200
    )
    const k1 = key()
    const v = doc.version
    doc = ok(
      await o.api.post(`${D}/${doc.id}/confirm`, { expectedVersion: v, idempotencyKey: k1 }),
      200
    )
    assert.equal(doc.status, 'PARTIAL')
    assert.match(doc.number, /^ENT-0*1$/)
    assert.equal(lineOf(doc, 'AGUA').confirmedQuantity, '7.000000')
    assert.equal(lineOf(doc, 'AGUA').remainingQuantity, '5.000000')
    assert.equal(await o.balance(o.water.id), 168)
    // Repetir a mesma confirmação (mesma chave, versão antiga) não duplica.
    const again = ok(
      await o.api.post(`${D}/${doc.id}/confirm`, { expectedVersion: v, idempotencyKey: k1 }),
      200
    )
    assert.lengthOf(again.confirmations, 1)
    assert.equal(await o.balance(o.water.id), 168)
    // Documento com confirmações não se edita nem se anula.
    assert.equal(
      code(
        await o.api.put(`${D}/${doc.id}`, {
          ...base,
          expectedVersion: doc.version,
          lines: [waterLine],
        })
      ),
      'INVALID_STATE'
    )
    assert.equal(
      code(
        await o.api.post(`${D}/${doc.id}/cancel`, { expectedVersion: doc.version, reason: 'x' })
      ),
      'INVALID_STATE'
    )
    // Segunda ronda: o resto; número mantém-se; leite em quarentena.
    doc = await checkAndConfirm(o, doc, { AGUA: '5', LEITE: '5' })
    assert.equal(doc.status, 'COMPLETED')
    assert.match(doc.number, /^ENT-0*1$/)
    assert.lengthOf(doc.confirmations, 2)
    assert.equal(await o.balance(o.water.id), 288)
    const milkRows = ok(await o.api.get(`${I}/stock/balances?productId=${o.milk.id}`), 200)
    assert.equal(milkRows[0].quarantine, '5.000000')
    assert.equal(milkRows[0].available, '0.000000')
    // Movimentos com a origem do documento.
    const moves = ok(await o.api.get(`${I}/stock/movements?productId=${o.water.id}`), 200)
    assert.isTrue(
      moves.every((x: any) => x.source.type === 'STOCK_DOCUMENT' && x.source.ref === doc.number)
    )

    // Estorno da primeira confirmação: volta a haver saldo por confirmar.
    const c1 = doc.confirmations[0]
    assert.include(
      details(
        await o.api.post(`${I}/document-confirmations/${c1.id}/reverse`, { idempotencyKey: key() })
      ),
      'REQUIRED'
    )
    const rk = key()
    doc = ok(
      await o.api.post(`${I}/document-confirmations/${c1.id}/reverse`, {
        reason: 'Caixas devolvidas ao fornecedor',
        idempotencyKey: rk,
      }),
      200
    )
    assert.equal(doc.status, 'PARTIAL')
    assert.equal(lineOf(doc, 'AGUA').remainingQuantity, '7.000000')
    assert.isNotNull(doc.confirmations[0].reversalPostingId)
    assert.equal(await o.balance(o.water.id), 120)
    // Repetir o mesmo estorno devolve o documento; outro pedido é recusado.
    ok(
      await o.api.post(`${I}/document-confirmations/${c1.id}/reverse`, {
        reason: 'Caixas devolvidas ao fornecedor',
        idempotencyKey: rk,
      }),
      200
    )
    assert.equal(
      code(
        await o.api.post(`${I}/document-confirmations/${c1.id}/reverse`, {
          reason: 'x',
          idempotencyKey: key(),
        })
      ),
      'ALREADY_REVERSED'
    )
    assert.equal(await o.balance(o.water.id), 120)
    // Fechar o saldo por confirmar com motivo.
    assert.include(
      details(await o.api.post(`${D}/${doc.id}/close`, { expectedVersion: doc.version })),
      'REQUIRED'
    )
    doc = ok(
      await o.api.post(`${D}/${doc.id}/close`, {
        expectedVersion: doc.version,
        reason: 'Fornecedor não volta a entregar',
      }),
      200
    )
    assert.equal(doc.status, 'COMPLETED')
    assert.isTrue(doc.closedShort)

    // Auditoria e reconciliação.
    const audits = await owner().rawQuery(
      `select action from audit_events where tenant_id = ? and entity_type = 'stock_document' order by created_at`,
      [o.tenant.id]
    )
    const actions = audits.rows.map((r: any) => r.action)
    for (const a of [
      'created',
      'updated',
      'checked',
      'reopened',
      'confirmed',
      'reversed',
      'closed',
    ])
      assert.include(actions, `inventory.document.${a}`)
    const rec = ok(await o.api.get(`${I}/stock/reconciliation`), 200)
    assert.lengthOf(rec.differences, 0)

    // A base protege confirmações e linhas confirmadas.
    await assert.rejects(() =>
      owner().rawQuery('delete from stock_document_confirmations where tenant_id = ?', [
        o.tenant.id,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(
        `update stock_document_lines set quantity = 99 where tenant_id = ? and id = ?`,
        [o.tenant.id, w.id]
      )
    )
  })

  test('saída: stock insuficiente não lança, séries por inteiro, anulação e série documental em falta', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const r = ok(
      await o.api.post(D, {
        docType: 'RECEIPT',
        warehouseId: o.wa.id,
        origin: 'OPENING',
        lines: [
          { productId: o.water.id, uomId: o.un.id, quantity: '50', locationId: o.bin.id },
          {
            productId: o.phone.id,
            uomId: o.un.id,
            quantity: '2',
            locationId: o.bin.id,
            serials: ['IMEI-1', 'IMEI-2'],
          },
        ],
      })
    )
    // Séries: confirma-se a linha por inteiro.
    assert.include(
      details(
        await o.api.post(`${D}/${r.id}/check`, {
          expectedVersion: r.version,
          lines: [{ lineId: lineOf(r, 'TEL').id, checkedQuantity: '1' }],
        })
      ),
      'INVALID'
    )
    await checkAndConfirm(o, r, { AGUA: '50', TEL: '2' })
    assert.equal(await o.balance(o.water.id), 50)

    const out = (q: string, extra: Record<string, unknown> = {}) =>
      o.api.post(D, {
        docType: 'ISSUE',
        warehouseId: o.wa.id,
        origin: 'CONSUMPTION',
        lines: [
          { productId: o.water.id, uomId: o.cx.id, quantity: q, locationId: o.bin.id, ...extra },
        ],
      })
    assert.include(details(await out('1', { unitCost: '5' })), 'NOT_ALLOWED')
    // 3 caixas = 72 > 50: a conferência passa (é o que foi contado), a confirmação não lança nada.
    let big = ok(await out('3'))
    big = ok(
      await o.api.post(`${D}/${big.id}/check`, {
        expectedVersion: big.version,
        lines: [{ lineId: big.lines[0].id, checkedQuantity: '3' }],
      }),
      200
    )
    const fail = await o.api.post(`${D}/${big.id}/confirm`, {
      expectedVersion: big.version,
      idempotencyKey: key(),
    })
    assert.equal(code(fail), 'INSUFFICIENT_STOCK')
    const still = ok(await o.api.get(`${D}/${big.id}`), 200)
    assert.equal(still.status, 'CHECKED')
    assert.isNull(still.number)
    assert.lengthOf(still.confirmations, 0)
    assert.equal(await o.balance(o.water.id), 50)
    // Anular (com motivo) só sem confirmações.
    assert.include(
      details(await o.api.post(`${D}/${big.id}/cancel`, { expectedVersion: still.version })),
      'REQUIRED'
    )
    const cancelled = ok(
      await o.api.post(`${D}/${big.id}/cancel`, {
        expectedVersion: still.version,
        reason: 'Erro de contagem',
      }),
      200
    )
    assert.equal(cancelled.status, 'CANCELLED')
    // Saída válida: 2 caixas = 48.
    const okOut = await checkAndConfirm(o, ok(await out('2')), { AGUA: '2' })
    assert.equal(okOut.status, 'COMPLETED')
    assert.match(okOut.number, /^SAI-0*1$/)
    assert.equal(await o.balance(o.water.id), 2)

    // Entidade legal sem série: a confirmação explica o que falta e nada muda.
    const rb = ok(
      await o.api.post(D, {
        docType: 'RECEIPT',
        warehouseId: o.wb.id,
        origin: 'OTHER',
        lines: [{ productId: o.water.id, uomId: o.un.id, quantity: '1' }],
      })
    )
    const cb = ok(
      await o.api.post(`${D}/${rb.id}/check`, {
        expectedVersion: rb.version,
        lines: [{ lineId: rb.lines[0].id, checkedQuantity: '1' }],
      }),
      200
    )
    assert.equal(
      code(
        await o.api.post(`${D}/${rb.id}/confirm`, {
          expectedVersion: cb.version,
          idempotencyKey: key(),
        })
      ),
      'NO_SERIES'
    )
    assert.equal(await o.balance(o.water.id), 2)
    // Lista com filtros.
    const issues = ok(await o.api.get(`${D}?docType=ISSUE`), 200)
    assert.sameMembers(
      issues.map((x: any) => x.status),
      ['CANCELLED', 'COMPLETED']
    )
  })

  test('permissões, âmbito e confirmações em paralelo', async ({ client, assert }) => {
    const o = await setup(client)
    const body = {
      docType: 'RECEIPT',
      warehouseId: o.wa.id,
      origin: 'PURCHASE',
      lines: [{ productId: o.water.id, uomId: o.un.id, quantity: '10', locationId: o.bin.id }],
    }
    const reader = await roleMember(
      client,
      o.s,
      'ler',
      ['inventory.read'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    const clerk = await roleMember(
      client,
      o.s,
      'fiel',
      ['inventory.read', 'inventory.documents.manage'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    const boss = await roleMember(
      client,
      o.s,
      'chefe',
      ['inventory.read', 'inventory.documents.confirm'],
      'LEGAL_ENTITY',
      o.leA.id
    )
    assert.equal(code(await reader.post(D, body)), 'OUT_OF_SCOPE')
    // O fiel cria e confere; não confirma.
    let doc = ok(await clerk.post(D, body))
    doc = ok(
      await clerk.post(`${D}/${doc.id}/check`, {
        expectedVersion: doc.version,
        lines: [{ lineId: doc.lines[0].id, checkedQuantity: '10' }],
      }),
      200
    )
    assert.deepEqual(doc.can, { manage: true, confirm: false })
    assert.equal(
      code(
        await clerk.post(`${D}/${doc.id}/confirm`, {
          expectedVersion: doc.version,
          idempotencyKey: key(),
        })
      ),
      'OUT_OF_SCOPE'
    )
    // Documento de outra entidade legal: não existe para o leitor da entidade A.
    const other = ok(
      await o.api.post(D, {
        ...body,
        warehouseId: o.wb.id,
        lines: [{ ...body.lines[0], locationId: null }],
      })
    )
    assert.equal((await reader.get(`${D}/${other.id}`)).status(), 404)
    assert.notInclude(
      ok(await reader.get(D), 200).map((x: any) => x.id),
      other.id
    )

    // Duas confirmações em paralelo (chaves diferentes): só uma lança.
    const [a, b] = await Promise.all([
      boss.post(`${D}/${doc.id}/confirm`, { expectedVersion: doc.version, idempotencyKey: key() }),
      boss.post(`${D}/${doc.id}/confirm`, { expectedVersion: doc.version, idempotencyKey: key() }),
    ])
    assert.sameMembers([a.status(), b.status()], [200, 409])
    const final = ok(await o.api.get(`${D}/${doc.id}`), 200)
    assert.lengthOf(final.confirmations, 1)
    assert.equal(final.status, 'COMPLETED')
    assert.equal(await o.balance(o.water.id), 10)
  })
})
