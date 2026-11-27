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
import { addMonths } from '#modules/sales/domain/recurring'

const S = '/api/v1/sales'
const R = `${S}/recurring`
const owner = () => db.connection('owner')
const ok = (r: any, status = 200) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const paths = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)
const today = () => new Date().toISOString().slice(0, 10)
const monthStart = (n: number) => addMonths(`${today().slice(0, 7)}-01`, n)
// Valores fiscais ilustrativos de teste, não taxas legais.
const SOURCE = 'Fonte de teste — não é diploma real'

async function member(client: any, admin: Session, roleCode: string, permissions: string[]) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'TENANT',
    })
  )
  return as(client, m.session)
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000931',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    }),
    201
  )
  const approver = await member(client, s, 'aprova_rec', ['sales.recurring.approve'])
  const reader = await member(client, s, 'leitor_rec', ['sales.recurring.read'])
  const issuer = await member(client, s, 'emissor', ['sales.invoices.issue'])
  const confirmer = await member(client, s, 'fiscal_conf', ['sales.fiscal.confirm'])
  const uom = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    }),
    201
  )
  const product = (sku: string, type: string, price: string) =>
    api.post('/api/v1/inventory/products', {
      sku,
      name: sku,
      productType: type,
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: price,
    })
  const hosting = ok(await product('ALOJ', 'SERVICE', '800'), 201)
  const support = ok(await product('SUPORTE', 'SERVICE', '500'), 201)
  const box = ok(await product('CAIXA', 'STOCKABLE', '50'), 201)
  const c1 = ok(
    await api.post(`${S}/customers`, {
      currency: 'AOA',
      paymentTermsDays: 15,
      partner: {
        code: 'CLI-1',
        name: 'Cliente Um',
        partnerType: 'ORGANIZATION',
        taxId: '5417000071',
        countryCode: 'AO',
      },
    }),
    201
  )
  const year = Number(today().slice(0, 4))
  let t10 = ok(
    await api.post(`${S}/fiscal/tax-codes`, {
      countryCode: 'AO',
      code: 'T10',
      name: 'Imposto de teste',
      kind: 'TAX',
      taxType: 'VAT',
    }),
    201
  )
  t10 = ok(
    await api.post(`${S}/fiscal/tax-codes/${t10.id}/rates`, {
      rate: '10',
      validFrom: `${year - 2}-01-01`,
      legalSource: SOURCE,
    }),
    201
  )
  ok(
    await confirmer.post(`${S}/fiscal/tax-rates/${t10.rates[0].id}/confirm`, {
      expectedVersion: t10.rates[0].version,
    })
  )
  for (const y of [year - 1, year]) {
    const x = ok(
      await api.post(`${S}/fiscal/series`, {
        legalEntityId: le.id,
        documentKind: 'INVOICE',
        fiscalCode: 'FT',
        code: `FT${y}`,
        fiscalYear: y,
        prefix: `FT ${y}/`,
      }),
      201
    )
    ok(await api.post(`${S}/fiscal/series/${x.id}/activate`, { expectedVersion: x.version }))
  }
  const contract = async (input: Record<string, unknown> = {}) =>
    ok(
      await api.post(R, {
        reference: 'REF-1',
        description: 'Alojamento e suporte mensal',
        legalEntityId: le.id,
        customerId: c1.id,
        frequency: 'MONTHLY',
        billingTiming: 'ADVANCE',
        startDate: monthStart(-2),
        ...input,
      }),
      201
    )
  const lines = (price: string | null) => [
    { productId: hosting.id, quantity: '1', unitPrice: price, taxCodeIds: [t10.id] },
    { productId: support.id, quantity: '2', unitPrice: null, taxCodeIds: [t10.id] },
  ]
  const approve = async (c: any, versionNo = 1) => {
    const v = c.versions.find((x: any) => x.versionNo === versionNo)
    return ok(
      await approver.post(`${S}/recurring-versions/${v.id}/approve`, { expectedVersion: v.version })
    )
  }
  return {
    tenant,
    api,
    le,
    approver,
    reader,
    issuer,
    hosting,
    support,
    box,
    c1,
    t10,
    contract,
    lines,
    approve,
  }
}

test.group('Vendas | facturação recorrente (10.11)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('versões de preço aprovadas por outra pessoa, geração segura por período só em rascunho', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    let c = await o.contract()
    assert.deepEqual([c.status, c.periodsGenerated, c.can.activate], ['DRAFT', 0, false])
    // A primeira versão começa no início; só serviços.
    assert.include(
      paths(
        await o.api.post(`${R}/${c.id}/versions`, {
          validFrom: monthStart(-1),
          lines: o.lines('1000'),
        })
      ),
      'validFrom'
    )
    assert.include(
      paths(
        await o.api.post(`${R}/${c.id}/versions`, {
          validFrom: monthStart(-2),
          lines: [{ productId: o.box.id, quantity: '1', taxCodeIds: [o.t10.id] }],
        })
      ),
      'lines.0.productId'
    )
    c = ok(
      await o.api.post(`${R}/${c.id}/versions`, {
        validFrom: monthStart(-2),
        lines: o.lines('1000'),
      }),
      201
    )
    assert.equal(
      code(await o.api.post(`${R}/${c.id}/activate`, { expectedVersion: c.version })),
      'NO_VERSION'
    )
    // Quem preparou não aprova; o leitor também não.
    const v1 = c.versions[0]
    assert.equal(
      code(
        await o.api.post(`${S}/recurring-versions/${v1.id}/approve`, {
          expectedVersion: v1.version,
        })
      ),
      'SELF_APPROVAL'
    )
    assert.equal(
      (
        await o.reader.post(`${S}/recurring-versions/${v1.id}/approve`, {
          expectedVersion: v1.version,
        })
      ).status(),
      403
    )
    c = await o.approve(c)
    assert.equal(c.can.activate, false) // o aprovador não gere o contrato
    c = ok(await o.api.get(`${R}/${c.id}`))
    assert.deepEqual([c.versions[0].status, c.can.activate], ['APPROVED', true])
    // Aprovada é imutável.
    assert.equal(
      code(
        await o.api.patch(`${S}/recurring-versions/${v1.id}`, {
          expectedVersion: c.versions[0].version,
          validFrom: monthStart(-2),
          lines: o.lines('1'),
        })
      ),
      'INVALID_STATE'
    )
    c = ok(await o.api.post(`${R}/${c.id}/activate`, { expectedVersion: c.version }))
    assert.equal(c.status, 'ACTIVE')
    // Nova versão de preço a partir deste mês (a anterior continua nos meses passados).
    c = ok(
      await o.api.post(`${R}/${c.id}/versions`, {
        validFrom: monthStart(0),
        lines: o.lines('1200'),
      }),
      201
    )
    c = await o.approve(c, 2)
    c = ok(await o.api.get(`${R}/${c.id}`))
    assert.deepEqual(
      c.schedule.slice(0, 3).map((p: any) => [p.periodStart, p.versionNo, p.due]),
      [
        [monthStart(-2), 1, true],
        [monthStart(-1), 1, true],
        [monthStart(0), 2, true],
      ]
    )
    // Geração: 3 rascunhos (um por período); em paralelo e repetida nunca duplica.
    const [g1, g2] = await Promise.all([
      o.api.post(`${R}/${c.id}/generate`, {}),
      o.api.post(`${R}/${c.id}/generate`, {}),
    ])
    assert.equal(ok(g1).generated + ok(g2).generated, 3)
    assert.equal(ok(await o.api.post(`${R}/${c.id}/generate`, {})).generated, 0)
    c = ok(await o.api.get(`${R}/${c.id}`))
    assert.equal(c.periodsGenerated, 3)
    const runs = c.runs.filter((r: any) => r.status === 'GENERATED')
    assert.equal(runs.length, 3)
    const byStart = Object.fromEntries(runs.map((r: any) => [r.periodStart, r]))
    // Nunca emite: tudo rascunho, sem comunicação fiscal.
    assert.isTrue(runs.every((r: any) => r.invoice.status === 'DRAFT'))
    const fiscal = await owner().rawQuery(
      `select count(*)::int as n from fiscal_submissions where tenant_id = ?`,
      [o.tenant.id]
    )
    assert.equal(fiscal.rows[0].n, 0)
    // Preço do contrato (CONTRACT) e da tabela/catálogo à data; v1 nos meses passados, v2 neste.
    const first = ok(await o.api.get(`${S}/invoices/${byStart[monthStart(-2)].invoice.id}`))
    assert.deepEqual(
      [
        first.lines[0].priceSource,
        first.lines[0].netUnitPrice,
        first.lines[1].netUnitPrice,
        first.payableTotal,
      ],
      ['CONTRACT', '1000.0000', '500.0000', '2200.00']
    )
    assert.deepEqual(
      [
        first.invoiceDate,
        first.recurring.reference,
        first.recurring.periodStart,
        first.paymentTermsDays,
      ],
      [monthStart(-2), 'REF-1', monthStart(-2), 15]
    )
    assert.include(first.lines[0].description, `período ${monthStart(-2)}`)
    assert.equal(byStart[monthStart(0)].invoice.payable, '2420.00')
    // A emissão é de uma pessoa (com a permissão própria) e aceita o preço do contrato.
    const issued = ok(
      await o.issuer.post(`${S}/invoices/${first.id}/issue`, { expectedVersion: first.version })
    )
    assert.deepEqual([issued.status, issued.lines[0].priceSource], ['ISSUED', 'CONTRACT'])
    // Não se muda o preço de períodos já gerados.
    assert.include(
      paths(
        await o.api.post(`${R}/${c.id}/versions`, { validFrom: monthStart(0), lines: o.lines('9') })
      ),
      'validFrom'
    )
    // Base: períodos só de acréscimo; o índice não recua; o essencial do contrato activo não muda.
    for (const sql of [
      `delete from sales_recurring_runs where contract_id = '${c.id}'`,
      `update sales_recurring_contracts set periods_generated = 0 where id = '${c.id}'`,
      `update sales_recurring_contracts set start_date = '2000-01-01' where id = '${c.id}'`,
      `update sales_recurring_version_lines set unit_price = 1 where version_id = '${v1.id}'`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
  })

  test('falhas registadas sem duplicar, suspensão, fim e facturação no fim do período', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    let c = await o.contract({ reference: 'REF-2', startDate: monthStart(-1) })
    c = ok(
      await o.api.post(`${R}/${c.id}/versions`, {
        validFrom: monthStart(-1),
        lines: o.lines('1000'),
      }),
      201
    )
    c = await o.approve(c)
    c = ok(await o.api.post(`${R}/${c.id}/activate`, { expectedVersion: c.version }))
    // Cliente bloqueado: o período falha com o motivo, sem rascunho; repetir não duplica a falha.
    const cust = ok(await o.api.get(`${S}/customers/${o.c1.id}`))
    ok(
      await o.api.post(`${S}/customers/${o.c1.id}/status`, {
        expectedVersion: cust.version,
        status: 'BLOCKED',
        reason: 'Dívida em atraso',
      })
    )
    let g = ok(await o.api.post(`${R}/${c.id}/generate`, {}))
    assert.equal(g.generated, 0)
    assert.include(g.failed, 'CUSTOMER_BLOCKED')
    ok(await o.api.post(`${R}/${c.id}/generate`, {}))
    c = ok(await o.api.get(`${R}/${c.id}`))
    assert.deepEqual(
      c.runs.map((r: any) => r.status),
      ['FAILED']
    )
    assert.equal(c.periodsGenerated, 0)
    const blocked = ok(await o.api.get(`${S}/customers/${o.c1.id}`))
    ok(
      await o.api.post(`${S}/customers/${o.c1.id}/status`, {
        expectedVersion: blocked.version,
        status: 'ACTIVE',
        reason: 'Regularizado',
      })
    )
    g = ok(await o.api.post(`${R}/${c.id}/generate`, {}))
    assert.equal(g.generated, 2)
    // Suspenso: não gera; retomar; terminar com motivo é final.
    c = ok(await o.api.get(`${R}/${c.id}`))
    assert.include(
      paths(await o.api.post(`${R}/${c.id}/suspend`, { expectedVersion: c.version })),
      'reason'
    )
    c = ok(
      await o.api.post(`${R}/${c.id}/suspend`, {
        expectedVersion: c.version,
        reason: 'Pedido do cliente',
      })
    )
    assert.equal(c.can.generate, false)
    c = ok(await o.api.post(`${R}/${c.id}/resume`, { expectedVersion: c.version }))
    c = ok(
      await o.api.post(`${R}/${c.id}/end`, {
        expectedVersion: c.version,
        reason: 'Contrato rescindido',
      })
    )
    assert.deepEqual([c.status, c.statusReason], ['ENDED', 'Contrato rescindido'])
    assert.equal(
      code(await o.api.patch(`${R}/${c.id}`, { expectedVersion: c.version, description: 'Outra' })),
      'INVALID_STATE'
    )
    // Facturação no fim do período: o período deste mês ainda não venceu.
    let a = await o.contract({
      reference: 'REF-3',
      startDate: monthStart(-1),
      billingTiming: 'ARREARS',
    })
    a = ok(
      await o.api.post(`${R}/${a.id}/versions`, {
        validFrom: monthStart(-1),
        lines: o.lines(null),
      }),
      201
    )
    a = await o.approve(a)
    a = ok(await o.api.post(`${R}/${a.id}/activate`, { expectedVersion: a.version }))
    assert.equal(ok(await o.api.post(`${R}/${a.id}/generate`, {})).generated, 1)
    a = ok(await o.api.get(`${R}/${a.id}`))
    const run = a.runs.find((r: any) => r.status === 'GENERATED')
    const lastDay = new Date(`${monthStart(0)}T00:00:00Z`)
    lastDay.setUTCDate(lastDay.getUTCDate() - 1)
    assert.equal(run.invoiceDate, lastDay.toISOString().slice(0, 10))
    // Sem preço fixado: o catálogo (800 + 2×500) = 1 800 + 10 %.
    assert.equal(run.invoice.payable, '1980.00')
    // Lista com o próximo período e a auditoria.
    const list = ok(await o.reader.get(`${R}?status=ACTIVE`))
    assert.deepEqual(
      list.map((x: any) => x.reference),
      ['REF-3']
    )
    const audits = await owner().rawQuery(
      `select action from audit_events where tenant_id = ? and action like 'sales_recurring.%'`,
      [o.tenant.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      [
        'sales_recurring.created',
        'sales_recurring.version_created',
        'sales_recurring.version_approved',
        'sales_recurring.activated',
        'sales_recurring.period_generated',
        'sales_recurring.suspended',
        'sales_recurring.ended',
      ]
    )
  })
})
