import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { allocateRequisition } from '#modules/procurement/index'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const P = '/api/v1/procurement'
const R = `${P}/requisitions`
const ORG = '/api/v1/organization'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
let seq = 0
const key = () => `k-${Date.now()}-${++seq}`

async function member(
  client: any,
  admin: Session,
  roleCode: string,
  grants: [string[], string, string?][],
  extraRoleId?: string
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
  if (extraRoleId)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: extraRoleId,
        scopeType: 'TENANT',
      }),
      200
    )
  const ctx = (await as(client, m.session).get('/api/v1/context')).body().data
  return { api: as(client, m.session), membershipId: ctx.membershipId as string }
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000901',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const cc = ok(
    await api.post(`${ORG}/cost-centers`, { code: 'CC1', name: 'Oficina', legalEntityId: le.id })
  )
  const d1 = ok(
    await api.post(`${ORG}/departments`, {
      code: 'MANUT',
      name: 'Manutenção',
      legalEntityId: le.id,
    })
  )
  const d2 = ok(
    await api.post(`${ORG}/departments`, {
      code: 'ADMIN',
      name: 'Administração',
      legalEntityId: le.id,
    })
  )
  const un = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    })
  )
  const pump = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
    })
  )
  // Etapas: chefia (qualquer valor) e direcção a partir de 500 000,00 AOA, só com o perfil de director.
  const director = await createRole(client, s, 'director', ['procurement.requisitions.approve'])
  ok(
    await api.post(`${P}/approval-levels`, {
      code: 'CHEFIA',
      name: 'Chefia',
      sequence: 1,
      minAmount: '0',
    })
  )
  ok(
    await api.post(`${P}/approval-levels`, {
      code: 'DIR',
      name: 'Direcção',
      sequence: 2,
      minAmount: '500000.00',
      approverRoleId: director.id,
    })
  )
  const requester = await member(client, s, 'pede', [
    [['procurement.requisitions.request'], 'DEPARTMENT', d1.id],
  ])
  const chief = await member(client, s, 'chefe', [
    [['procurement.requisitions.approve'], 'DEPARTMENT', d1.id],
  ])
  const chief2 = await member(client, s, 'chefe2', [
    [['procurement.requisitions.approve'], 'DEPARTMENT', d1.id],
  ])
  const boss = await member(client, s, 'dir', [], director.id)
  const buyer = await member(client, s, 'compra', [
    [['procurement.requisitions.process'], 'LEGAL_ENTITY', le.id],
  ])
  const ctx = (await api.get('/api/v1/context')).body().data
  const scope = {
    tenantId: tenant.id,
    userId: admin.id,
    membershipId: ctx.membershipId,
    requestId: 't',
  }
  const body = (extra: Record<string, unknown> = {}) => ({
    departmentId: d1.id,
    priority: 'HIGH',
    neededBy: day(10),
    purpose: 'Reparação da estação de bombagem',
    budgetReference: 'ORC-2026-MANUT',
    lines: [
      { productId: pump.id, quantity: '10', estimatedUnitPrice: '1000', taxRate: '14' },
      {
        description: 'Serviço de reparação',
        quantity: '1',
        estimatedUnitPrice: '2500.5',
        neededBy: day(5),
      },
    ],
    ...extra,
  })
  return {
    tenant,
    s,
    api,
    le,
    cc,
    d1,
    d2,
    un,
    pump,
    director,
    requester,
    chief,
    chief2,
    boss,
    buyer,
    scope,
    body,
  }
}

test.group('Compras | requisições (9.2)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('rascunho, totais exactos, numeração, aprovação por valor em etapas segregadas, recusa e cópia', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P1 = o.requester.api
    // Validações e âmbito.
    assert.equal(code(await P1.post(R, o.body({ departmentId: o.d2.id }))), 'OUT_OF_SCOPE')
    assert.include(details(await P1.post(R, o.body({ lines: [] }))), 'REQUIRED')
    assert.include(details(await P1.post(R, o.body({ neededBy: 'amanhã' }))), 'INVALID')
    assert.include(
      details(await P1.post(R, o.body({ lines: [{ quantity: '2', description: 'X' }] }))),
      'REQUIRED'
    )
    let r = ok(await P1.post(R, o.body()))
    assert.deepInclude(r, {
      status: 'DRAFT',
      number: null,
      currency: 'AOA',
      totalNet: '12500.50',
      totalTax: '1400.00',
      totalAmount: '13900.50',
    })
    // O centro de custo vem do departamento quando não é indicado (aqui não tem): fica vazio.
    assert.isNull(r.costCenter)
    assert.deepInclude(r.lines[0], {
      description: 'Bomba de água',
      netAmount: '10000.00',
      taxAmount: '1400.00',
    })
    assert.equal(r.lines[0].uom.code, 'UN')
    // Editar o rascunho (substitui as linhas) com versão.
    r = ok(
      await P1.put(`${R}/${r.id}`, {
        ...o.body({ costCenterId: o.cc.id }),
        expectedVersion: r.version,
      }),
      200
    )
    assert.equal(r.costCenter.code, 'CC1')
    assert.equal((await P1.put(`${R}/${r.id}`, { ...o.body(), expectedVersion: 1 })).status(), 409)
    // Sem série não há número.
    assert.equal(
      code(await P1.post(`${R}/${r.id}/submit`, { expectedVersion: r.version })),
      'NO_SERIES'
    )
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.le.id,
        documentType: 'PURCHASE_REQUISITION',
        code: 'RC',
        prefix: 'RC-',
      })
    )
    r = ok(await P1.post(`${R}/${r.id}/submit`, { expectedVersion: r.version }), 200)
    assert.deepInclude(r, { status: 'PENDING_APPROVAL', totalFunctional: '13900.50' })
    assert.match(r.number, /^RC-0*1$/)
    assert.deepEqual(
      r.approval.map((a: any) => [a.code, a.decision]),
      [['CHEFIA', null]]
    )
    // Submetida: não se edita; o solicitante não decide.
    assert.equal(
      code(await P1.put(`${R}/${r.id}`, { ...o.body(), expectedVersion: r.version })),
      'INVALID_STATE'
    )
    assert.equal(
      code(await P1.post(`${R}/${r.id}/approve`, { expectedVersion: r.version })),
      'OUT_OF_SCOPE'
    )
    // A chefia vê-a nas que esperam por si.
    const waiting = ok(await o.chief.api.get(`${R}?awaitingMe=true`), 200)
    assert.deepEqual(
      waiting.map((x: any) => x.id),
      [r.id]
    )
    // Duas chefias ao mesmo tempo: uma decide, a outra recebe conflito.
    const both = await Promise.all([
      o.chief.api.post(`${R}/${r.id}/approve`, { expectedVersion: r.version }),
      o.chief2.api.post(`${R}/${r.id}/approve`, { expectedVersion: r.version }),
    ])
    assert.sameMembers(
      both.map((x) => x.status()),
      [200, 409]
    )
    r = ok(await o.api.get(`${R}/${r.id}`), 200)
    assert.equal(r.status, 'APPROVED')
    assert.lengthOf(
      r.approval.filter((a: any) => a.decision === 'APPROVE'),
      1
    )

    // Requisição em USD acima do limiar: sem câmbio não segue; com câmbio exige chefia e direcção.
    let big = ok(
      await P1.post(
        R,
        o.body({
          currency: 'USD',
          lines: [{ productId: o.pump.id, quantity: '1000', estimatedUnitPrice: '600' }],
        })
      )
    )
    assert.equal(
      code(await P1.post(`${R}/${big.id}/submit`, { expectedVersion: big.version })),
      'NO_RATE'
    )
    ok(
      await o.api.post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '900',
        validOn: day(-1),
      })
    )
    big = ok(await P1.post(`${R}/${big.id}/submit`, { expectedVersion: big.version }), 200)
    assert.deepInclude(big, { totalAmount: '600000.00', totalFunctional: '540000000.00' })
    assert.deepEqual(
      big.approval.map((a: any) => a.code),
      ['CHEFIA', 'DIR']
    )
    big = ok(
      await o.chief.api.post(`${R}/${big.id}/approve`, { expectedVersion: big.version }),
      200
    )
    assert.equal(big.status, 'PENDING_APPROVAL')
    // A etapa seguinte exige o perfil de director: a outra chefia não a decide; a mesma pessoa também não.
    assert.equal(
      code(await o.chief2.api.post(`${R}/${big.id}/approve`, { expectedVersion: big.version })),
      'ROLE_REQUIRED'
    )
    const chiefAndDirector = await member(
      client,
      o.s,
      'chefedir',
      [[['procurement.requisitions.approve'], 'DEPARTMENT', o.d1.id]],
      o.director.id
    )
    // (outra pessoa com o perfil decide normalmente; quem já decidiu a etapa 1 não pode decidir a 2)
    assert.isTrue(ok(await chiefAndDirector.api.get(`${R}/${big.id}`), 200).can.decide)
    const sameRole = await o.chief.api.get(`${R}/${big.id}`)
    assert.isFalse(ok(sameRole, 200).can.decide)
    big = ok(await o.boss.api.post(`${R}/${big.id}/approve`, { expectedVersion: big.version }), 200)
    assert.equal(big.status, 'APPROVED')
    assert.deepEqual(
      big.approval.map((a: any) => a.decision),
      ['APPROVE', 'APPROVE']
    )

    // Recusa com motivo termina a requisição; copiar cria um rascunho novo.
    let third = ok(await P1.post(R, o.body({ priority: 'LOW' })))
    third = ok(await P1.post(`${R}/${third.id}/submit`, { expectedVersion: third.version }), 200)
    assert.include(
      details(
        await o.chief.api.post(`${R}/${third.id}/reject`, { expectedVersion: third.version })
      ),
      'REQUIRED'
    )
    third = ok(
      await o.chief.api.post(`${R}/${third.id}/reject`, {
        expectedVersion: third.version,
        reason: 'Já existe stock no armazém central',
      }),
      200
    )
    assert.deepInclude(third, {
      status: 'REJECTED',
      rejectReason: 'Já existe stock no armazém central',
    })
    assert.equal(
      code(
        await P1.post(`${R}/${third.id}/cancel`, { expectedVersion: third.version, reason: 'x' })
      ),
      'INVALID_STATE'
    )
    const copy = ok(await P1.post(`${R}/${third.id}/copy`))
    assert.deepInclude(copy, {
      status: 'DRAFT',
      number: null,
      copiedFromId: third.id,
      totalAmount: '13900.50',
    })
    assert.lengthOf(copy.lines, 2)
    const cancelled = ok(
      await P1.post(`${R}/${copy.id}/cancel`, {
        expectedVersion: copy.version,
        reason: 'Duplicada',
      }),
      200
    )
    assert.equal(cancelled.status, 'CANCELLED')
    assert.deepEqual(
      ok(await o.api.get(`${R}/${third.id}`), 200).history.map((h: any) => h.kind),
      ['REJECTED', 'SUBMITTED', 'CREATED']
    )

    // A base de dados guarda o que foi decidido.
    for (const sql of [
      `update purchase_requisition_lines set quantity = 1 where requisition_id = '${r.id}'`,
      `update purchase_requisitions set total_amount = 1, total_net = 1, total_tax = 0 where id = '${r.id}'`,
      `update purchase_requisitions set status = 'DRAFT' where id = '${third.id}'`,
      `delete from purchase_requisition_approvals`,
      `delete from purchase_requisition_events`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where action like 'purchase_%'`
    )
    assert.includeMembers(
      (audits.rows as any[]).map((x) => x.action),
      [
        'purchase_approval_level.created',
        'purchase_requisition.created',
        'purchase_requisition.updated',
        'purchase_requisition.submitted',
        'purchase_requisition.approved',
        'purchase_requisition.step_approved',
        'purchase_requisition.rejected',
        'purchase_requisition.copied',
        'purchase_requisition.cancelled',
      ]
    )
  })

  test('atendimento parcial, necessidades consolidadas, fecho do resto e âmbito', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.le.id,
        documentType: 'PURCHASE_REQUISITION',
        code: 'RC',
        prefix: 'RC-',
      })
    )
    const approved = async (lines: unknown[], neededBy = day(10)) => {
      let r = ok(await o.requester.api.post(R, o.body({ lines, neededBy })))
      r = ok(await o.requester.api.post(`${R}/${r.id}/submit`, { expectedVersion: r.version }), 200)
      return ok(await o.chief.api.post(`${R}/${r.id}/approve`, { expectedVersion: r.version }), 200)
    }
    const a = await approved([
      { productId: o.pump.id, quantity: '10', estimatedUnitPrice: '1000' },
      { description: 'Serviço de reparação', quantity: '1', estimatedUnitPrice: '2500' },
    ])
    const b = await approved(
      [{ productId: o.pump.id, quantity: '5', estimatedUnitPrice: '1100' }],
      day(3)
    )
    // Necessidades: as bombas das duas requisições juntam-se; o serviço fica à parte.
    let demand = ok(await o.buyer.api.get(`${R}/demand`), 200)
    const pumps = demand.find((g: any) => g.product?.sku === 'BOMBA')
    assert.deepInclude(pumps, {
      open: '15.000000',
      estimatedValue: '15500.00',
      neededBy: day(3),
      uom: 'UN',
    })
    assert.lengthOf(pumps.lines, 2)
    assert.lengthOf(demand, 2)
    assert.equal(code(await o.requester.api.get(`${R}/demand`)), 'OUT_OF_SCOPE')

    // Contrato de afectação (ordens de compra do 9.5): parcial, repetição, chave reutilizada, acima do aberto.
    const alloc = (lineId: string, quantity: string, k = key()) =>
      runInTenant(o.scope, (scope) =>
        allocateRequisition(scope, {
          lineId,
          quantity,
          sourceType: 'PURCHASE_ORDER',
          sourceId: '00000000-0000-4000-8000-000000000001',
          idempotencyKey: k,
        })
      )
    const k1 = key()
    assert.deepEqual(await alloc(a.lines[0].id, '6', k1), {
      replayed: false,
      requisitionStatus: 'PARTIALLY_ORDERED',
    })
    assert.isTrue((await alloc(a.lines[0].id, '6', k1)).replayed)
    await assert.rejects(() => alloc(a.lines[0].id, '7', k1), /Esta chave já foi usada/)
    await assert.rejects(() => alloc(a.lines[0].id, '4.5'), /Só há 4.000000 em aberto/)
    await alloc(a.lines[0].id, '4')
    assert.equal((await alloc(a.lines[1].id, '1')).requisitionStatus, 'ORDERED')
    assert.equal((await alloc(a.lines[0].id, '-2')).requisitionStatus, 'PARTIALLY_ORDERED')
    await assert.rejects(() => alloc(a.lines[1].id, '-2'), /Só há 1.000000 encomendado/)
    let ra = ok(await o.requester.api.get(`${R}/${a.id}`), 200)
    assert.deepInclude(ra.lines[0], { orderedQuantity: '8.000000', openQuantity: '2.000000' })
    demand = ok(await o.buyer.api.get(`${R}/demand`), 200)
    assert.equal(demand.find((g: any) => g.product?.sku === 'BOMBA').open, '7.000000')
    // Anular uma requisição com encomendas já não é possível; fechar o resto sim (comprador, com motivo).
    assert.equal(
      code(
        await o.requester.api.post(`${R}/${a.id}/cancel`, {
          expectedVersion: ra.version,
          reason: 'x',
        })
      ),
      'INVALID_STATE'
    )
    assert.equal(
      code(
        await o.requester.api.post(`${R}/${a.id}/close`, {
          expectedVersion: ra.version,
          reason: 'x',
        })
      ),
      'OUT_OF_SCOPE'
    )
    ra = ok(
      await o.buyer.api.post(`${R}/${a.id}/close`, {
        expectedVersion: ra.version,
        reason: 'Restantes 2 bombas vêm da transferência',
      }),
      200
    )
    assert.equal(ra.status, 'CLOSED')
    assert.deepInclude(ra.lines[0], { closedQuantity: '2.000000', openQuantity: '0.000000' })
    // O que volta de uma ordem anulada numa requisição fechada não reabre.
    await alloc(a.lines[0].id, '-3')
    ra = ok(await o.buyer.api.get(`${R}/${a.id}`), 200)
    assert.deepInclude(ra.lines[0], {
      orderedQuantity: '5.000000',
      closedQuantity: '5.000000',
      openQuantity: '0.000000',
    })
    assert.equal(ra.status, 'CLOSED')
    demand = ok(await o.buyer.api.get(`${R}/demand`), 200)
    assert.deepEqual(
      demand.map((g: any) => [g.description, g.open]),
      [['Bomba de água', '5.000000']]
    )
    assert.equal(b.status, 'APPROVED')

    // Âmbito: outra chefia de outro departamento não vê; quem não tem permissões de compras também não.
    const other = await member(client, o.s, 'outro', [
      [['procurement.requisitions.approve'], 'DEPARTMENT', o.d2.id],
    ])
    assert.equal((await other.api.get(`${R}/${a.id}`)).status(), 404)
    assert.lengthOf(ok(await other.api.get(R), 200), 0)
    const nobody = await member(client, o.s, 'nada', [[['members.read'], 'TENANT']])
    assert.lengthOf(ok(await nobody.api.get(R), 200), 0)
    assert.equal(code(await nobody.api.post(R, o.body())), 'OUT_OF_SCOPE')
    assert.equal((await nobody.api.get(`${P}/approval-levels`)).status(), 403)
    // O comprador vê todas as da entidade; o solicitante só as do seu departamento.
    assert.lengthOf(ok(await o.buyer.api.get(R), 200), 2)
    assert.lengthOf(ok(await o.requester.api.get(`${R}?mine=true`), 200), 2)
    // Configuração: etapa com código repetido e alterar sem permissão.
    assert.equal(
      code(
        await o.api.post(`${P}/approval-levels`, {
          code: 'chefia',
          name: 'Repetida',
          sequence: 3,
          minAmount: '0',
        })
      ),
      'CODE_TAKEN'
    )
    assert.equal(
      (
        await o.buyer.api.post(`${P}/approval-levels`, {
          code: 'X',
          name: 'X',
          sequence: 3,
          minAmount: '0',
        })
      ).status(),
      403
    )
    const opts = ok(await o.requester.api.get(`${R}/options`), 200)
    assert.deepEqual(
      opts.departments.map((d: any) => d.code),
      ['MANUT']
    )
    assert.deepEqual(
      opts.products.map((p: any) => p.sku),
      ['BOMBA']
    )
  })
})
