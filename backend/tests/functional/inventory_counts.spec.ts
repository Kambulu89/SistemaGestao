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
const C = `${I}/counts`
const ORG = '/api/v1/organization'
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
  const leA = await le('LEA', '5000000871')
  const leB = await le('LEB', '5000000872')
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: leA.id,
      documentType: 'STOCK_COUNT',
      code: 'IV',
      prefix: 'IV-',
    })
  )
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const cat = ok(await api.post(`${I}/settings/categories`, { code: 'LUB', name: 'Lubrificantes' }))
  const product = async (sku: string, extra: Record<string, unknown> = {}) =>
    ok(
      await api.post(`${I}/products`, {
        sku,
        name: sku,
        productType: 'STOCKABLE',
        baseUomId: un.id,
        ...extra,
      })
    )
  const oil = await product('OLEO', { categoryId: cat.id })
  const filter = await product('FILTRO')
  const bolt = await product('PARAF')
  const mkWh = async (c: string, l: any) => {
    const w = ok(
      await api.post(`${I}/warehouses`, {
        code: c,
        name: `Armazém ${c}`,
        legalEntityId: l.id,
        warehouseType: 'MAIN',
      })
    )
    const z1 = ok(await api.post(`${I}/warehouses/${w.id}/locations`, { code: 'Z1' }))
    const z1id = z1.locations.find((x: any) => x.pathCode === 'Z1').id
    ok(
      await api.post(`${I}/warehouses/${w.id}/locations`, {
        parentId: z1id,
        code: 'P1',
        holdsStock: true,
      })
    )
    const z2 = ok(
      await api.post(`${I}/warehouses/${w.id}/locations`, { code: 'Z2', holdsStock: true })
    )
    const loc = (p: string) => z2.locations.find((x: any) => x.pathCode === p)
    return { ...w, z1: loc('Z1'), p1: loc('Z1-P1'), z2: loc('Z2') }
  }
  const wa = await mkWh('WA', leA)
  const wb = await mkWh('WB', leB)
  const ctx = (await api.get('/api/v1/context')).body().data
  const scopeCtx = {
    tenantId: tenant.id,
    userId: admin.id,
    membershipId: ctx.membershipId,
    requestId: 't',
  }
  const move = (type: 'RECEIPT' | 'ISSUE', lines: [any, any, any, string][]) =>
    runInTenant(scopeCtx, (sc) =>
      postStock(sc, {
        type,
        idempotencyKey: key(),
        sourceType: 'TEST',
        lines: lines.map(([w, l, p, q]) => ({
          warehouseId: w.id,
          locationId: l?.id ?? null,
          productId: p.id,
          bucket: 'UNRESTRICTED' as const,
          quantity: q,
        })),
      })
    )
  await move('RECEIPT', [
    [wa, wa.p1, oil, '100'],
    [wa, wa.p1, filter, '10'],
    [wa, wa.z2, oil, '40'],
    [wb, wb.p1, oil, '7'],
  ])
  const balance = async (p: any, l: any) => {
    const rows = ok(
      await api.get(`${I}/stock/balances?productId=${p.id}&warehouseId=${wa.id}`),
      200
    ) as any[]
    const r = rows.find((x) => (x.location?.id ?? null) === (l?.id ?? null))
    return r ? Number(r.physical) : 0
  }
  const counter = await roleMember(client, s, 'conta', [
    [['inventory.read', 'inventory.counts.manage'], 'LEGAL_ENTITY', leA.id],
  ])
  const approver = await roleMember(client, s, 'aprova', [
    [['inventory.read', 'inventory.counts.approve'], 'LEGAL_ENTITY', leA.id],
  ])
  const outsider = await roleMember(client, s, 'fora', [
    [
      ['inventory.read', 'inventory.counts.manage', 'inventory.counts.approve'],
      'LEGAL_ENTITY',
      leB.id,
    ],
  ])
  return {
    tenant,
    s,
    api,
    leA,
    leB,
    cat,
    oil,
    filter,
    bolt,
    wa,
    wb,
    move,
    balance,
    counter,
    approver,
    outsider,
  }
}

const act = async (api: any, c: any, action: string, b: Record<string, unknown> = {}) =>
  ok(await api.post(`${C}/${c.id}/${action}`, { expectedVersion: c.version, ...b }), 200)
const lineOf = (c: any, sku: string, path: string | null) =>
  c.lines.find((l: any) => l.product.sku === sku && (l.location?.pathCode ?? null) === path)

test.group('Inventário | contagens físicas e ajustes (8.7)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('ciclo cego: plano, snapshot, contagem, diferenças justificadas, aprovação e ajuste imutável', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P = (b: Record<string, unknown>) => o.counter.api.post(C, b)
    assert.include(details(await P({ warehouseId: o.wa.id, description: ' ' })), 'REQUIRED')
    assert.include(details(await P({ warehouseId: o.wb.id, description: 'x' })), 'NOT_FOUND')
    assert.include(
      details(await P({ warehouseId: o.wa.id, description: 'x', locationId: o.wb.z1.id })),
      'NOT_FOUND'
    )
    // Plano: zona Z1 (inclui Z1-P1) — o Z2 fica de fora.
    let c = ok(
      await P({ warehouseId: o.wa.id, description: 'Contagem cíclica Z1', locationId: o.wa.z1.id })
    )
    assert.deepInclude(c, { status: 'DRAFT', blind: true, number: null })
    assert.equal(c.location.pathCode, 'Z1')
    c = await act(o.counter.api, c, 'start')
    assert.equal(c.status, 'COUNTING')
    assert.match(c.number, /^IV-0*1$/)
    assert.equal(c.lines.length, 2)
    // Cega: quem conta não vê o sistema; quem aprova vê.
    assert.isFalse(c.can.seeBook)
    assert.isTrue(c.lines.every((l: any) => l.snapshotQuantity === null && l.difference === null))
    const seen = ok(await o.approver.api.get(`${C}/${c.id}`), 200)
    assert.isTrue(seen.can.seeBook)
    assert.equal(lineOf(seen, 'OLEO', 'Z1-P1').snapshotQuantity, '100.000000')
    // O plano fica fixo depois do início.
    assert.equal(
      code(
        await o.counter.api.put(`${C}/${c.id}`, { expectedVersion: c.version, description: 'y' })
      ),
      'INVALID_STATE'
    )

    // Movimento depois do snapshot: não é anulado pelo ajuste.
    await o.move('ISSUE', [[o.wa, o.wa.p1, o.oil, '-5']])
    const oil = lineOf(c, 'OLEO', 'Z1-P1')
    const flt = lineOf(c, 'FILTRO', 'Z1-P1')
    assert.include(
      details(
        await o.counter.api.post(`${C}/${c.id}/count`, {
          expectedVersion: c.version,
          lines: [{ lineId: oil.id, quantity: '-1' }],
        })
      ),
      'INVALID'
    )
    c = await act(o.counter.api, c, 'count', { lines: [{ lineId: oil.id, quantity: '97' }] })
    // Submeter exige tudo contado.
    assert.include(
      details(await o.counter.api.post(`${C}/${c.id}/submit`, { expectedVersion: c.version })),
      'NOT_COUNTED'
    )
    c = await act(o.counter.api, c, 'count', { lines: [{ lineId: flt.id, quantity: '10' }] })
    c = await act(o.counter.api, c, 'submit')
    assert.equal(c.status, 'REVIEW')
    assert.isNull(c.summary.withDifference)

    // Revisão: diferença −3 no óleo (o movimento −5 aparece à parte); por justificar não se aprova.
    let r = ok(await o.approver.api.get(`${C}/${c.id}`), 200)
    assert.deepInclude(lineOf(r, 'OLEO', 'Z1-P1'), {
      difference: '-3.000000',
      movedSinceSnapshot: '-5.000000',
    })
    assert.equal(r.summary.withDifference, 1)
    assert.include(
      details(await o.approver.api.post(`${C}/${c.id}/approve`, { expectedVersion: r.version })),
      'NOT_JUSTIFIED'
    )
    // Cega: quem conta não justifica nem aprova.
    assert.equal(
      code(
        await o.counter.api.post(`${C}/${c.id}/justify`, { expectedVersion: r.version, lines: [] })
      ),
      'OUT_OF_SCOPE'
    )
    assert.equal(
      code(await o.counter.api.post(`${C}/${c.id}/approve`, { expectedVersion: r.version })),
      'OUT_OF_SCOPE'
    )
    assert.include(
      details(
        await o.approver.api.post(`${C}/${c.id}/justify`, {
          expectedVersion: r.version,
          lines: [{ lineId: oil.id, reasonCode: 'NOPE', justification: 'x' }],
        })
      ),
      'INVALID'
    )
    // Enviar o formulário vazio não conta como justificação.
    assert.include(
      details(
        await o.approver.api.post(`${C}/${c.id}/justify`, {
          expectedVersion: r.version,
          lines: [{ lineId: oil.id, reasonCode: '', justification: '' }],
        })
      ),
      'REQUIRED'
    )
    assert.include(
      details(
        await o.approver.api.post(`${C}/${c.id}/justify`, {
          expectedVersion: r.version,
          lines: [{ lineId: flt.id, reasonCode: 'DAMAGE', justification: 'x' }],
        })
      ),
      'NO_DIFFERENCE'
    )
    r = await act(o.approver.api, r, 'justify', {
      lines: [
        {
          lineId: oil.id,
          reasonCode: 'DAMAGE',
          justification: 'Três latas furadas no fundo da palete',
        },
      ],
    })
    assert.equal(await o.balance(o.oil, o.wa.p1), 95)
    r = await act(o.approver.api, r, 'approve')
    assert.equal(r.status, 'APPROVED')
    assert.lengthOf(r.postings, 1)
    // Ajuste = contado − snapshot = −3 sobre o saldo actual (95) → 92; filtro sem diferença; Z2 intocado.
    assert.equal(await o.balance(o.oil, o.wa.p1), 92)
    assert.equal(await o.balance(o.filter, o.wa.p1), 10)
    assert.equal(await o.balance(o.oil, o.wa.z2), 40)
    // Depois da aprovação, quem contou vê o sistema.
    assert.isTrue(ok(await o.counter.api.get(`${C}/${c.id}`), 200).can.seeBook)
    const moves = ok(
      await o.api.get(`${I}/stock/movements?productId=${o.oil.id}&type=ADJUSTMENT`),
      200
    )
    assert.lengthOf(moves, 1)
    assert.deepInclude(moves[0].source, { type: 'STOCK_COUNT', ref: r.number })
    assert.lengthOf(ok(await o.api.get(`${I}/stock/reconciliation`), 200).differences, 0)
    // Fechada: nada muda (estado, linhas, registos de contagem, lançamentos).
    assert.equal(
      code(
        await o.approver.api.post(`${C}/${c.id}/cancel`, {
          expectedVersion: r.version,
          reason: 'x',
        })
      ),
      'INVALID_STATE'
    )
    for (const sql of [
      `update stock_counts set description = 'x' where tenant_id = ?`,
      `update stock_count_lines set counted_quantity = 1 where tenant_id = ?`,
      `delete from stock_count_entries where tenant_id = ?`,
      `delete from stock_count_postings where tenant_id = ?`,
    ])
      await assert.rejects(() => owner().rawQuery(sql, [o.tenant.id]))
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where tenant_id = ? and entity_type = 'stock_count'`,
      [o.tenant.id]
    )
    for (const a of ['created', 'started', 'counted', 'submitted', 'justified', 'approved'])
      assert.include(
        audits.rows.map((x: any) => x.action),
        `inventory.count.${a}`
      )
  })

  test('recontagem renova o snapshot, artigo encontrado, segregação de quem contou e contagem aberta', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Contagem aberta (não cega) de todo o armazém pelo administrador (gere e aprova).
    let c = ok(
      await o.api.post(C, { warehouseId: o.wa.id, description: 'Inventário anual', blind: false })
    )
    c = await act(o.api, c, 'start')
    assert.lengthOf(c.lines, 3)
    assert.isTrue(c.can.approve)
    // Quem gere numa contagem aberta vê o sistema.
    const seen = ok(await o.counter.api.get(`${C}/${c.id}`), 200)
    assert.equal(lineOf(seen, 'OLEO', 'Z2').snapshotQuantity, '40.000000')
    // Outra contagem com os mesmos saldos não arranca; artigo encontrado entra com o físico actual (0).
    const other = ok(
      await o.counter.api.post(C, {
        warehouseId: o.wa.id,
        description: 'Z2',
        locationId: o.wa.z2.id,
      })
    )
    assert.equal(
      code(await o.counter.api.post(`${C}/${other.id}/start`, { expectedVersion: other.version })),
      'COUNT_OVERLAP'
    )
    assert.equal(
      code(
        await o.counter.api.post(`${C}/${c.id}/lines`, {
          expectedVersion: ok(await o.counter.api.get(`${C}/${c.id}`), 200).version,
          productId: o.oil.id,
          locationId: o.wa.z2.id,
        })
      ),
      'LINE_EXISTS'
    )
    c = ok(await o.counter.api.get(`${C}/${c.id}`), 200)
    c = await act(o.counter.api, c, 'lines', { productId: o.bolt.id, locationId: o.wa.z2.id })
    const bolt = lineOf(c, 'PARAF', 'Z2')
    assert.deepInclude(bolt, { addedDuringCount: true, snapshotQuantity: '0.000000' })
    const L = (sku: string, path: string) => lineOf(c, sku, path).id
    c = await act(o.counter.api, c, 'count', {
      lines: [
        { lineId: L('OLEO', 'Z1-P1'), quantity: '100' },
        { lineId: L('FILTRO', 'Z1-P1'), quantity: '4' },
        { lineId: L('OLEO', 'Z2'), quantity: '40' },
        { lineId: bolt.id, quantity: '25' },
      ],
    })
    c = await act(o.counter.api, c, 'submit')
    // Recontagem do filtro (só quem aprova): nova volta, snapshot renovado (entretanto saíram 2).
    await o.move('ISSUE', [[o.wa, o.wa.p1, o.filter, '-2']])
    assert.equal(
      code(
        await o.counter.api.post(`${C}/${c.id}/recount`, {
          expectedVersion: c.version,
          reason: 'x',
          lineIds: [L('FILTRO', 'Z1-P1')],
        })
      ),
      'OUT_OF_SCOPE'
    )
    c = await act(o.approver.api, c, 'recount', {
      reason: 'Diferença grande no filtro',
      lineIds: [L('FILTRO', 'Z1-P1')],
    })
    assert.equal(c.status, 'COUNTING')
    c = ok(await o.counter.api.get(`${C}/${c.id}`), 200)
    assert.deepInclude(lineOf(c, 'FILTRO', 'Z1-P1'), {
      round: 2,
      recountRequested: true,
      countedQuantity: null,
      snapshotQuantity: '8.000000',
    })
    // O administrador reconta: passa a ter contado e já não aprova (segregação).
    c = await act(o.api, c, 'count', { lines: [{ lineId: L('FILTRO', 'Z1-P1'), quantity: '7' }] })
    c = await act(o.counter.api, c, 'submit')
    const mine = ok(await o.api.get(`${C}/${c.id}`), 200)
    assert.isFalse(mine.can.approve)
    // Numa contagem aberta, quem gere justifica.
    c = await act(o.counter.api, c, 'justify', {
      lines: [
        {
          lineId: L('FILTRO', 'Z1-P1'),
          reasonCode: 'THEFT_LOSS',
          justification: 'Falta confirmada na recontagem',
        },
        {
          lineId: bolt.id,
          reasonCode: 'UNRECORDED_RECEIPT',
          justification: 'Entrada sem documento',
        },
      ],
    })
    assert.equal(
      code(await o.api.post(`${C}/${c.id}/approve`, { expectedVersion: c.version })),
      'SELF_APPROVAL'
    )
    // Duas aprovações em simultâneo: uma passa, a outra perde a versão; o ajuste entra uma só vez.
    const [a1, a2] = await Promise.all([
      o.approver.api.post(`${C}/${c.id}/approve`, { expectedVersion: c.version }),
      o.approver.api.post(`${C}/${c.id}/approve`, { expectedVersion: c.version }),
    ])
    assert.sameMembers([a1.status(), a2.status()], [200, 409])
    assert.equal(await o.balance(o.filter, o.wa.p1), 7)
    assert.equal(await o.balance(o.bolt, o.wa.z2), 25)
    assert.equal(await o.balance(o.oil, o.wa.p1), 100)
    const n = await owner().rawQuery(
      `select count(*)::int as n from stock_postings where tenant_id = ? and source_type = 'STOCK_COUNT'`,
      [o.tenant.id]
    )
    assert.equal(n.rows[0].n, 1)
    const entries = await owner().rawQuery(
      `select count(*)::int as n from stock_count_entries where tenant_id = ? and count_id = ?`,
      [o.tenant.id, c.id]
    )
    assert.equal(entries.rows[0].n, 5)
  })

  test('falta depois do snapshot, âmbito, série, anulação e categoria', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Categoria LUB: só o óleo (nas duas zonas).
    let c = ok(
      await o.counter.api.post(C, {
        warehouseId: o.wa.id,
        description: 'Lubrificantes',
        categoryId: o.cat.id,
      })
    )
    c = await act(o.counter.api, c, 'start')
    assert.sameMembers(
      c.lines.map((l: any) => `${l.product.sku}@${l.location.pathCode}`),
      ['OLEO@Z1-P1', 'OLEO@Z2']
    )
    c = await act(o.counter.api, c, 'count', {
      lines: c.lines.map((l: any) => ({
        lineId: l.id,
        quantity: l.location.pathCode === 'Z2' ? '10' : '100',
      })),
    })
    c = await act(o.counter.api, c, 'submit')
    // Depois do snapshot saíram 35 do Z2: o ajuste de −30 já não cabe → pede recontagem.
    await o.move('ISSUE', [[o.wa, o.wa.z2, o.oil, '-35']])
    let r = ok(await o.approver.api.get(`${C}/${c.id}`), 200)
    r = await act(o.approver.api, r, 'justify', {
      lines: [
        {
          lineId: lineOf(r, 'OLEO', 'Z2').id,
          reasonCode: 'COUNT_ERROR',
          justification: 'Paletes mal arrumadas',
        },
      ],
    })
    assert.include(
      details(await o.approver.api.post(`${C}/${c.id}/approve`, { expectedVersion: r.version })),
      'INSUFFICIENT_STOCK'
    )
    assert.equal(await o.balance(o.oil, o.wa.z2), 5)
    // Fora do âmbito: não vê (404) nem lista.
    assert.equal((await o.outsider.api.get(`${C}/${c.id}`)).status(), 404)
    assert.lengthOf(ok(await o.outsider.api.get(C), 200), 0)
    // Sem série na entidade B.
    const b = ok(await o.outsider.api.post(C, { warehouseId: o.wb.id, description: 'B' }))
    assert.equal(
      code(await o.outsider.api.post(`${C}/${b.id}/start`, { expectedVersion: b.version })),
      'NO_SERIES'
    )
    // Anulação com motivo; sem ajuste.
    assert.include(
      details(await o.approver.api.post(`${C}/${c.id}/cancel`, { expectedVersion: r.version })),
      'REQUIRED'
    )
    r = await act(o.approver.api, r, 'cancel', { reason: 'Recomeçar com o armazém fechado' })
    assert.equal(r.status, 'CANCELLED')
    assert.equal(await o.balance(o.oil, o.wa.z2), 5)
    // Versão desactualizada.
    assert.equal(
      (await o.counter.api.post(`${C}/${b.id}/start`, { expectedVersion: 99 })).status(),
      404
    )
    const d = ok(await o.counter.api.post(C, { warehouseId: o.wa.id, description: 'D' }))
    assert.equal(
      code(await o.counter.api.post(`${C}/${d.id}/start`, { expectedVersion: d.version + 1 })),
      'VERSION_CONFLICT'
    )
  })
})
