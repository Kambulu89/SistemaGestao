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
const R = `${I}/requisitions`
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
  const ctx = (await as(client, m.session).get('/api/v1/context')).body().data
  return { api: as(client, m.session), membershipId: ctx.membershipId as string }
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
  const leA = await le('LEA', '5000000861')
  const leB = await le('LEB', '5000000862')
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: leA.id,
      documentType: 'STOCK_REQUISITION',
      code: 'RQ',
      prefix: 'RQ-',
    })
  )
  const dept = async (c: string, l: any) =>
    ok(await api.post(`${ORG}/departments`, { code: c, name: `Dep ${c}`, legalEntityId: l.id }))
  const d1 = await dept('MANUT', leA)
  const d2 = await dept('ADMIN', leA)
  const dB = await dept('LOJA', leB)
  const ccA = ok(
    await api.post(`${ORG}/cost-centers`, {
      code: 'CC1',
      name: 'Manutenção',
      legalEntityId: leA.id,
    })
  )
  const ccB = ok(
    await api.post(`${ORG}/cost-centers`, { code: 'CCB', name: 'Loja', legalEntityId: leB.id })
  )
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const oil = ok(
    await api.post(`${I}/products`, {
      sku: 'OLEO',
      name: 'Óleo',
      productType: 'STOCKABLE',
      baseUomId: un.id,
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
    const z = ok(await api.post(`${I}/warehouses/${w.id}/locations`, { code: 'Z1' }))
    const b = ok(
      await api.post(`${I}/warehouses/${w.id}/locations`, {
        parentId: z.locations[0].id,
        code: 'P1',
        holdsStock: true,
      })
    )
    return { ...w, bin: b.locations.find((x: any) => x.pathCode === 'Z1-P1') }
  }
  const wa = await mkWh('WA', leA)
  const wb = await mkWh('WB', leB)
  const ctx = (await api.get('/api/v1/context')).body().data
  await runInTenant(
    { tenantId: tenant.id, userId: admin.id, membershipId: ctx.membershipId, requestId: 't' },
    (scope) =>
      postStock(scope, {
        type: 'RECEIPT',
        idempotencyKey: key(),
        sourceType: 'TEST',
        lines: [
          {
            warehouseId: wa.id,
            locationId: wa.bin.id,
            productId: oil.id,
            bucket: 'UNRESTRICTED',
            quantity: '100',
          },
        ],
      })
  )
  const totals = async () => {
    const rows = ok(
      await api.get(`${I}/stock/balances?productId=${oil.id}&warehouseId=${wa.id}`),
      200
    ) as any[]
    const sum = (f: string) => rows.reduce((t, r) => t + Number(r[f]), 0)
    return { physical: sum('physical'), reserved: sum('reserved'), available: sum('available') }
  }
  const requester = await roleMember(client, s, 'pede', [
    [['inventory.requisitions.request'], 'DEPARTMENT', d1.id],
  ])
  const approver = await roleMember(client, s, 'aprova', [
    [['inventory.requisitions.approve'], 'DEPARTMENT', d1.id],
  ])
  const keeper = await roleMember(client, s, 'fiel', [
    [['inventory.read', 'inventory.requisitions.fulfil'], 'LEGAL_ENTITY', leA.id],
  ])
  const body = (extra: Record<string, unknown> = {}) => ({
    warehouseId: wa.id,
    departmentId: d1.id,
    costCenterId: ccA.id,
    purpose: 'Manutenção da viatura 12',
    neededBy: '2026-12-01',
    lines: [{ productId: oil.id, quantity: '30', sourceLocationId: wa.bin.id }],
    ...extra,
  })
  return {
    tenant,
    s,
    api,
    leA,
    leB,
    d1,
    d2,
    dB,
    ccA,
    ccB,
    oil,
    wa,
    wb,
    totals,
    requester,
    approver,
    keeper,
    body,
  }
}

const act = async (api: any, r: any, action: string, b: Record<string, unknown> = {}) =>
  ok(await api.post(`${R}/${r.id}/${action}`, { expectedVersion: r.version, ...b }), 200)

test.group('Inventário | requisições internas e reservas (8.6)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('ciclo: pedido, aprovação com reserva, separação, entregas parciais e libertação do resto', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P = (b: Record<string, unknown>) => o.requester.api.post(R, b)
    // Validações.
    assert.include(details(await P(o.body({ purpose: ' ' }))), 'REQUIRED')
    assert.include(details(await P(o.body({ lines: [] }))), 'REQUIRED')
    assert.include(details(await P(o.body({ departmentId: o.dB.id }))), 'OTHER_LEGAL_ENTITY')
    assert.include(details(await P(o.body({ costCenterId: o.ccB.id }))), 'OTHER_LEGAL_ENTITY')
    // Âmbito do departamento: não requisita para outro departamento.
    assert.equal(code(await P(o.body({ departmentId: o.d2.id }))), 'OUT_OF_SCOPE')

    let r = ok(await P(o.body()))
    assert.equal(r.status, 'DRAFT')
    assert.equal(r.costCenter.code, 'CC1')
    assert.deepInclude(await o.totals(), { physical: 100, reserved: 0 })
    r = await act(o.requester.api, r, 'submit')
    assert.equal(r.status, 'REQUESTED')
    // Quem pede não aprova (nem tem a permissão); o aprovador do departamento aprova.
    assert.equal(
      code(await o.requester.api.post(`${R}/${r.id}/approve`, { expectedVersion: r.version })),
      'OUT_OF_SCOPE'
    )
    r = await act(o.approver.api, r, 'approve')
    assert.equal(r.status, 'APPROVED')
    assert.match(r.number, /^RQ-0*1$/)
    // Reservado baixa o disponível, não o físico.
    assert.deepEqual(await o.totals(), { physical: 100, reserved: 30, available: 70 })
    const res = ok(await o.api.get(`${I}/reservations?productId=${o.oil.id}`), 200)
    assert.lengthOf(res, 1)
    assert.deepInclude(res[0].source, { type: 'INTERNAL_REQUISITION', ref: r.number })
    assert.equal(res[0].quantity, '30.000000')

    // Atendimento pelo fiel: separa 25, entrega 20, não pode entregar acima do separado.
    assert.equal(
      code(
        await o.requester.api.post(`${R}/${r.id}/pick`, { expectedVersion: r.version, lines: [] })
      ),
      'OUT_OF_SCOPE'
    )
    const line = r.lines[0]
    r = await act(o.keeper.api, r, 'pick', { lines: [{ lineId: line.id, pickedQuantity: '25' }] })
    assert.equal(r.status, 'PICKED')
    const k = key()
    const v = r.version
    r = await act(o.keeper.api, r, 'issue', {
      idempotencyKey: k,
      lines: [{ lineId: line.id, quantity: '20' }],
    })
    assert.equal(r.status, 'PARTIAL')
    ok(
      await o.keeper.api.post(`${R}/${r.id}/issue`, {
        expectedVersion: v,
        idempotencyKey: k,
        lines: [{ lineId: line.id, quantity: '20' }],
      }),
      200
    )
    assert.deepEqual(await o.totals(), { physical: 80, reserved: 10, available: 70 })
    assert.include(
      details(
        await o.keeper.api.post(`${R}/${r.id}/issue`, {
          expectedVersion: r.version,
          idempotencyKey: key(),
          lines: [{ lineId: line.id, quantity: '6' }],
        })
      ),
      'INVALID'
    )
    // O resto já não é preciso: liberta-se com motivo.
    assert.include(
      details(
        await o.keeper.api.post(`${R}/${r.id}/release`, {
          expectedVersion: r.version,
          idempotencyKey: key(),
        })
      ),
      'REQUIRED'
    )
    r = await act(o.keeper.api, r, 'release', {
      idempotencyKey: key(),
      reason: 'Óleo restante já não é necessário',
    })
    assert.equal(r.status, 'COMPLETED')
    assert.deepInclude(r.lines[0], {
      issuedQuantity: '20.000000',
      releasedQuantity: '10.000000',
      openQuantity: '0.000000',
    })
    assert.deepEqual(await o.totals(), { physical: 80, reserved: 0, available: 80 })
    assert.lengthOf(ok(await o.api.get(`${I}/reservations?productId=${o.oil.id}`), 200), 0)
    assert.sameMembers(
      r.events.map((e: any) => e.kind),
      ['RESERVE', 'ISSUE', 'RELEASE']
    )
    // Movimentos com a origem e o número; reconciliação; auditoria.
    const moves = ok(await o.api.get(`${I}/stock/movements?productId=${o.oil.id}&type=ISSUE`), 200)
    assert.isTrue(
      moves.every((m: any) => m.source.type === 'INTERNAL_REQUISITION' && m.source.ref === r.number)
    )
    assert.lengthOf(ok(await o.api.get(`${I}/stock/reconciliation`), 200).differences, 0)
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where tenant_id = ? and entity_type = 'stock_requisition'`,
      [o.tenant.id]
    )
    for (const a of ['created', 'submitted', 'approved', 'picked', 'issued', 'released'])
      assert.include(
        audits.rows.map((x: any) => x.action),
        `inventory.requisition.${a}`
      )
    // A base protege eventos e as linhas depois de reservadas.
    await assert.rejects(() =>
      owner().rawQuery('delete from stock_requisition_events where tenant_id = ?', [o.tenant.id])
    )
    await assert.rejects(() =>
      owner().rawQuery('update stock_requisition_lines set quantity = 1 where tenant_id = ?', [
        o.tenant.id,
      ])
    )
  })

  test('segregação, âmbito por departamento e próprias, falta de stock, anulação, rejeição e série', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // O administrador pede e não pode aprovar o próprio pedido.
    let mine = await act(o.api, ok(await o.api.post(R, o.body())), 'submit')
    assert.equal(
      code(await o.api.post(`${R}/${mine.id}/approve`, { expectedVersion: mine.version })),
      'SELF_APPROVAL'
    )
    // Âmbito "próprio": requisita para qualquer departamento, mas só vê as suas.
    const own = await roleMember(client, o.s, 'proprio', [
      [['inventory.requisitions.request'], 'OWN'],
    ])
    const ownReq = ok(await own.api.post(R, o.body({ departmentId: o.d2.id })))
    assert.sameMembers(
      ok(await own.api.get(R), 200).map((x: any) => x.id),
      [ownReq.id]
    )
    // O requisitante e o aprovador do departamento 1 não vêem a do departamento 2.
    assert.equal((await o.requester.api.get(`${R}/${ownReq.id}`)).status(), 404)
    assert.equal((await o.approver.api.get(`${R}/${ownReq.id}`)).status(), 404)
    assert.include(
      ok(await o.approver.api.get(R), 200).map((x: any) => x.id),
      mine.id
    )
    // Aprovar acima do disponível: a reserva falha e nada muda.
    let big = await act(
      o.requester.api,
      ok(
        await o.requester.api.post(R, o.body({ lines: [{ productId: o.oil.id, quantity: '101' }] }))
      ),
      'submit'
    )
    assert.equal(
      code(await o.approver.api.post(`${R}/${big.id}/approve`, { expectedVersion: big.version })),
      'OVER_RESERVED'
    )
    big = ok(await o.approver.api.get(`${R}/${big.id}`), 200)
    assert.equal(big.status, 'REQUESTED')
    assert.isNull(big.number)
    big = await act(o.approver.api, big, 'reject', { reason: 'Quantidade excessiva' })
    assert.equal(big.status, 'REJECTED')
    // Anular depois de aprovada liberta a reserva; depois de entregas não se anula.
    mine = await act(o.approver.api, mine, 'approve')
    assert.deepInclude(await o.totals(), { reserved: 30 })
    mine = await act(o.api, mine, 'cancel', { reason: 'Trabalho adiado' })
    assert.equal(mine.status, 'CANCELLED')
    assert.deepInclude(await o.totals(), { reserved: 0, available: 100 })
    let r = await act(
      o.requester.api,
      ok(
        await o.requester.api.post(R, o.body({ lines: [{ productId: o.oil.id, quantity: '5' }] }))
      ),
      'submit'
    )
    r = await act(o.approver.api, r, 'approve')
    // Linha sem localização: sair de "sem posição" falha; quem atende escolhe a posição onde está o stock.
    assert.equal(
      code(
        await o.keeper.api.post(`${R}/${r.id}/issue`, {
          expectedVersion: r.version,
          idempotencyKey: key(),
          lines: [{ lineId: r.lines[0].id, quantity: '5' }],
        })
      ),
      'INSUFFICIENT_STOCK'
    )
    r = await act(o.keeper.api, r, 'issue', {
      idempotencyKey: key(),
      lines: [{ lineId: r.lines[0].id, quantity: '5', sourceLocationId: o.wa.bin.id }],
    })
    assert.equal(r.status, 'COMPLETED')
    assert.equal(
      code(await o.api.post(`${R}/${r.id}/cancel`, { expectedVersion: r.version, reason: 'x' })),
      'INVALID_STATE'
    )
    // Entidade sem série STOCK_REQUISITION: a aprovação explica o que falta.
    let b = await act(
      o.api,
      ok(
        await o.api.post(
          R,
          o.body({
            warehouseId: o.wb.id,
            departmentId: o.dB.id,
            costCenterId: null,
            lines: [{ productId: o.oil.id, quantity: '1' }],
          })
        )
      ),
      'submit'
    )
    const boss = await roleMember(client, o.s, 'chefe', [
      [['inventory.requisitions.approve'], 'TENANT'],
    ])
    assert.equal(
      code(await boss.api.post(`${R}/${b.id}/approve`, { expectedVersion: b.version })),
      'NO_SERIES'
    )
    b = ok(await boss.api.get(`${R}/${b.id}`), 200)
    assert.equal(b.status, 'REQUESTED')
    assert.lengthOf(ok(await o.api.get(`${I}/stock/reconciliation`), 200).differences, 0)
  })
})
