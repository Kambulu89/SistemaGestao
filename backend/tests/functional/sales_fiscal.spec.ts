import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { allocateFiscalNumber } from '#modules/sales/index'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const F = '/api/v1/sales/fiscal'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const paths = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)

async function member(client: any, admin: Session, roleCode: string, permissions: string[]) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'TENANT',
    }),
    200
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
    })
  )
  const preparer = await member(client, s, 'fiscal_prep', ['sales.fiscal.manage'])
  const confirmer = await member(client, s, 'fiscal_conf', ['sales.fiscal.confirm'])
  const reader = await member(client, s, 'fiscal_ler', ['sales.fiscal.read'])
  const me = (
    await owner().rawQuery(
      `select m.id, m.user_id from tenant_memberships m join users u on u.id = m.user_id where m.tenant_id = ? and u.email = ?`,
      [tenant.id, admin.email]
    )
  ).rows[0]
  const context = {
    tenantId: tenant.id,
    userId: me.user_id,
    membershipId: me.id,
    requestId: 'teste',
  }
  return { tenant, api, le, preparer, confirmer, reader, context }
}

// Valores ilustrativos de teste, não taxas legais.
const SOURCE = 'Fonte de teste — não é diploma real'

test.group('Vendas | motor fiscal e séries (10.5)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('taxas com fonte, confirmação por outra pessoa, vigência, isenção obrigatória a 0 % e retenção', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P = o.preparer
    assert.equal((await o.reader.post(`${F}/tax-codes`, {})).status(), 403)
    let vat = ok(
      await P.post(`${F}/tax-codes`, {
        countryCode: 'AO',
        code: 'T1',
        name: 'Imposto de teste',
        kind: 'TAX',
        taxType: 'VAT',
      })
    )
    assert.equal(
      code(
        await P.post(`${F}/tax-codes`, {
          countryCode: 'AO',
          code: 't1',
          name: 'Outro',
          kind: 'TAX',
          taxType: 'VAT',
        })
      ),
      'CODE_TAKEN'
    )
    assert.include(
      paths(
        await P.post(`${F}/tax-codes/${vat.id}/rates`, { rate: '10', validFrom: '2026-01-01' })
      ),
      'legalSource'
    )
    vat = ok(
      await P.post(`${F}/tax-codes/${vat.id}/rates`, {
        rate: '10',
        validFrom: '2026-01-01',
        validTo: '2026-06-30',
        legalSource: SOURCE,
      })
    )
    vat = ok(
      await P.post(`${F}/tax-codes/${vat.id}/rates`, {
        rate: '12',
        validFrom: '2026-07-01',
        legalSource: SOURCE,
      })
    )
    const [r12, r10] = vat.rates
    // Rascunho não conta.
    const sim = (date: string, lines: any[]) =>
      o.reader.post(`${F}/simulate`, { legalEntityId: o.le.id, date, lines })
    assert.equal(
      code(await sim('2026-03-01', [{ netAmount: '100.00', taxCodeIds: [vat.id] }])),
      'VALIDATION_ERROR'
    )
    // Quem prepara não confirma; outra pessoa confirma; confirmada não muda.
    assert.equal(
      (await P.post(`${F}/tax-rates/${r10.id}/confirm`, { expectedVersion: r10.version })).status(),
      403
    )
    const adminSelf = await o.api.post(`${F}/tax-codes/${vat.id}/rates`, {
      rate: '99',
      validFrom: '2030-01-01',
      legalSource: SOURCE,
    })
    const own = ok(adminSelf).rates.find((x: any) => x.rate === '99.0000')
    assert.equal(
      code(await o.api.post(`${F}/tax-rates/${own.id}/confirm`, { expectedVersion: own.version })),
      'SELF_CONFIRMATION'
    )
    ok(await o.api.delete(`${F}/tax-rates/${own.id}`), 200)
    vat = ok(
      await o.confirmer.post(`${F}/tax-rates/${r10.id}/confirm`, { expectedVersion: r10.version }),
      200
    )
    vat = ok(
      await o.confirmer.post(`${F}/tax-rates/${r12.id}/confirm`, { expectedVersion: r12.version }),
      200
    )
    assert.deepEqual(
      vat.rates.map((r: any) => r.status),
      ['CONFIRMED', 'CONFIRMED']
    )
    assert.equal(
      code(await P.patch(`${F}/tax-rates/${r10.id}`, { expectedVersion: 99, rate: '1' })),
      'VERSION_CONFLICT'
    )
    const fresh = vat.rates.find((x: any) => x.id === r10.id)
    assert.equal(
      code(
        await P.patch(`${F}/tax-rates/${r10.id}`, { expectedVersion: fresh.version, rate: '1' })
      ),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update tax_rates set rate = 1 where id = ?`, [r10.id])
    )
    await assert.rejects(() => owner().rawQuery(`delete from tax_rates where id = ?`, [r10.id]))
    // Sobreposição de vigências confirmadas.
    vat = ok(
      await P.post(`${F}/tax-codes/${vat.id}/rates`, {
        rate: '11',
        validFrom: '2026-05-01',
        legalSource: SOURCE,
      })
    )
    const r11 = vat.rates.find((x: any) => x.rate === '11.0000')
    assert.equal(
      code(
        await o.confirmer.post(`${F}/tax-rates/${r11.id}/confirm`, { expectedVersion: r11.version })
      ),
      'OVERLAP'
    )
    // A taxa em vigor na data escolhe-se pela vigência.
    const march = ok(await sim('2026-03-01', [{ netAmount: '100.00', taxCodeIds: [vat.id] }]), 200)
    const august = ok(await sim('2026-08-01', [{ netAmount: '100.00', taxCodeIds: [vat.id] }]), 200)
    assert.deepEqual([march.totals.tax, august.totals.tax], ['10.00', '12.00'])
    assert.equal(march.mode, 'SIMULATION')
    assert.equal(march.ratesUsed[0].legalSource, SOURCE)

    // Taxa 0 % exige motivo de isenção confirmado.
    let zero = ok(
      await P.post(`${F}/tax-codes`, {
        countryCode: 'AO',
        code: 'T0',
        name: 'Isento de teste',
        kind: 'TAX',
        taxType: 'VAT',
      })
    )
    zero = ok(
      await P.post(`${F}/tax-codes/${zero.id}/rates`, {
        rate: '0',
        validFrom: '2026-01-01',
        legalSource: SOURCE,
      })
    )
    ok(
      await o.confirmer.post(`${F}/tax-rates/${zero.rates[0].id}/confirm`, {
        expectedVersion: zero.rates[0].version,
      }),
      200
    )
    assert.include(
      paths(await sim('2026-03-01', [{ netAmount: '100.00', taxCodeIds: [zero.id] }])),
      'lines.0.exemptionCode'
    )
    const ex = ok(
      await P.post(`${F}/exemptions`, {
        countryCode: 'AO',
        code: 'X01',
        description: 'Isenção de teste',
        legalSource: SOURCE,
      })
    )
    assert.include(
      paths(
        await sim('2026-03-01', [
          { netAmount: '100.00', taxCodeIds: [zero.id], exemptionCode: 'X01' },
        ])
      ),
      'lines.0.exemptionCode'
    )
    ok(
      await o.confirmer.post(`${F}/exemptions/${ex.id}/confirm`, { expectedVersion: ex.version }),
      200
    )
    const exempt = ok(
      await sim('2026-03-01', [
        { netAmount: '100.00', taxCodeIds: [zero.id], exemptionCode: 'x01' },
      ]),
      200
    )
    assert.equal(exempt.summary[0].exemptionCode, 'X01')
    assert.equal(exempt.totals.tax, '0.00')

    // Retenção com base mínima, e arredondamento por documento configurado.
    let wh = ok(
      await P.post(`${F}/tax-codes`, {
        countryCode: 'AO',
        code: 'R1',
        name: 'Retenção de teste',
        kind: 'WITHHOLDING',
        taxType: 'INCOME',
      })
    )
    wh = ok(
      await P.post(`${F}/tax-codes/${wh.id}/rates`, {
        rate: '5',
        minBase: '1000',
        validFrom: '2026-01-01',
        legalSource: SOURCE,
      })
    )
    ok(
      await o.confirmer.post(`${F}/tax-rates/${wh.rates[0].id}/confirm`, {
        expectedVersion: wh.rates[0].version,
      }),
      200
    )
    const withheld = ok(
      await sim('2026-03-01', [
        { netAmount: '600.00', taxCodeIds: [vat.id, wh.id] },
        { netAmount: '600.00', taxCodeIds: [vat.id, wh.id] },
      ]),
      200
    )
    assert.deepEqual(withheld.totals, {
      net: '1200.00',
      tax: '120.00',
      gross: '1320.00',
      withholding: '60.00',
      payable: '1260.00',
    })
    ok(await P.put(`${F}/settings/${o.le.id}`, { roundingLevel: 'DOCUMENT' }), 200)
    const half = Array.from({ length: 3 }, () => ({ netAmount: '0.05', taxCodeIds: [vat.id] }))
    assert.equal(ok(await sim('2026-03-01', half), 200).totals.tax, '0.02')
    ok(await P.put(`${F}/settings/${o.le.id}`, { roundingLevel: 'LINE' }), 200)
    assert.equal(ok(await sim('2026-03-01', half), 200).totals.tax, '0.03')
    // Retirar com motivo: deixa de valer.
    const conf = ok(await o.reader.get(`${F}/tax-codes/${wh.id}`), 200).rates[0]
    ok(
      await o.confirmer.post(`${F}/tax-rates/${conf.id}/retire`, {
        expectedVersion: conf.version,
        reason: 'Revogada (teste)',
      }),
      200
    )
    assert.include(
      paths(await sim('2026-03-01', [{ netAmount: '1.00', taxCodeIds: [wh.id] }])),
      'lines.0.taxCodeIds'
    )
    const audits = await owner().rawQuery(
      `select action from audit_events where entity_type = 'tax_code' and entity_id = ?`,
      [vat.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      ['tax_code.created', 'tax_rate.created', 'tax_rate.confirmed']
    )
  })

  test('séries fiscais: só simulação, configuração fixa ao activar, sequência sem saltos e cronológica sob concorrência', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P = o.preparer
    const base = {
      legalEntityId: o.le.id,
      documentKind: 'INVOICE',
      fiscalCode: 'ft',
      fiscalYear: 2026,
      padding: 3,
    }
    assert.include(
      paths(await P.post(`${F}/series`, { ...base, code: 'A', prefix: 'A/', mode: 'PRODUCTION' })),
      'mode'
    )
    let a = ok(await P.post(`${F}/series`, { ...base, code: 'A', prefix: 'FT A/' }))
    const b = ok(await P.post(`${F}/series`, { ...base, code: 'B', prefix: 'FT B/' }))
    assert.deepEqual(
      [a.mode, a.status, a.fiscalCode, a.next],
      ['SIMULATION', 'DRAFT', 'FT', 'FT A/001']
    )
    assert.equal(
      code(await P.post(`${F}/series`, { ...base, code: 'a', prefix: 'x' })),
      'CODE_TAKEN'
    )
    const alloc = (seriesId: string, issueDate: string, documentId: string, kind = 'INVOICE') =>
      runInTenant({ ...o.context, requestId: documentId }, (scope) =>
        allocateFiscalNumber(scope, {
          seriesId,
          legalEntityId: o.le.id,
          documentKind: kind as any,
          issueDate,
          documentType: 'teste',
          documentId,
        })
      )
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    await assert.rejects(() => alloc(a.id, '2026-03-01', uuid(1)), /não está activa/)
    a = ok(await P.post(`${F}/series/${a.id}/activate`, { expectedVersion: a.version }), 200)
    ok(await P.post(`${F}/series/${b.id}/activate`, { expectedVersion: b.version }), 200)
    assert.equal(
      code(await P.patch(`${F}/series/${a.id}`, { expectedVersion: a.version, prefix: 'X/' })),
      'INVALID_STATE'
    )
    a = ok(
      await P.patch(`${F}/series/${a.id}`, {
        expectedVersion: a.version,
        authorityReference: 'Ref. comunicação (teste)',
      }),
      200
    )
    // 20 atribuições simultâneas em duas séries: números consecutivos, sem saltos nem repetições.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => alloc(i % 2 ? b.id : a.id, '2026-03-01', uuid(100 + i)))
    )
    const nums = await owner().rawQuery(
      `select series_id, array_agg(number order by number) as n from fiscal_numbers group by series_id`
    )
    for (const r of nums.rows) assert.deepEqual(r.n, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // Falha dentro da transacção do documento: o número não se gasta.
    await runInTenant(o.context, async (scope) => {
      await allocateFiscalNumber(scope, {
        seriesId: a.id,
        legalEntityId: o.le.id,
        documentKind: 'INVOICE',
        issueDate: '2026-03-02',
        documentType: 'teste',
        documentId: uuid(500),
      })
      throw new Error('emissão falhou')
    }).catch(() => undefined)
    const next = await alloc(a.id, '2026-03-02', uuid(501))
    assert.equal(next.formatted, 'FT A/011')
    // Cronologia, ano, tipo, documento repetido.
    await assert.rejects(() => alloc(a.id, '2026-03-01', uuid(502)), /não pode recuar/)
    await assert.rejects(() => alloc(a.id, '2027-01-01', uuid(503)), /2026/)
    await assert.rejects(
      () => alloc(a.id, '2026-03-05', uuid(504), 'CREDIT_NOTE'),
      /tipo de documento/
    )
    await assert.rejects(() => alloc(a.id, '2026-03-05', uuid(501)), /já tem número/)
    // A base não deixa recuar a numeração, saltar números nem mexer no registo.
    await assert.rejects(() =>
      owner().rawQuery(`update fiscal_series set next_number = 5 where id = ?`, [a.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update fiscal_series set next_number = next_number + 2 where id = ?`, [
        a.id,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update fiscal_numbers set formatted = 'x' where series_id = ?`, [a.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update fiscal_series set mode = 'PRODUCTION' where id = ?`, [a.id])
    )
    const list = ok(await o.reader.get(`${F}/series/${a.id}/numbers?limit=2`), 200)
    assert.deepEqual(
      list.map((x: any) => x.formatted),
      ['FT A/011', 'FT A/010']
    )
    // Fechar com motivo: não atribui mais.
    const cur = ok(await o.reader.get(`${F}/series`), 200).items.find((x: any) => x.id === a.id)
    assert.equal(cur.issued, 11)
    ok(
      await P.post(`${F}/series/${a.id}/close`, {
        expectedVersion: cur.version,
        reason: 'Fim do período de teste',
      }),
      200
    )
    await assert.rejects(() => alloc(a.id, '2026-03-05', uuid(600)), /não está activa/)
  })
})
