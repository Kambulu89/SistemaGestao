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

const S = '/api/v1/sales'
const C = `${S}/customers`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)

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
  const seller = await member(client, s, 'vendas', ['sales.customers.manage'])
  const credit = await member(client, s, 'credito', ['sales.customers.credit'])
  const viewer = await member(client, s, 'leitor', ['sales.customers.read'])
  const nobody = await member(client, s, 'nada', ['procurement.suppliers.read'])
  return { tenant, api, seller, credit, viewer, nobody }
}

const newCustomer = (extra: Record<string, unknown> = {}) => ({
  currency: 'AOA',
  paymentTermsDays: 30,
  partner: {
    code: 'CLI-1',
    name: 'Cliente Um, Lda.',
    partnerType: 'ORGANIZATION',
    taxId: '5417000071',
    countryCode: 'AO',
    email: 'Geral@Cliente.ao',
    addressLine: 'Rua da Missão 10',
    city: 'Luanda',
  },
  ...extra,
})

test.group('Vendas | clientes (10.1)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('ficha sobre o terceiro, condições, moradas, contactos, versões dos dados fiscais e estado', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const V = o.seller
    // Validação e âmbito.
    assert.includeMembers(
      details(
        await V.post(C, {
          currency: 'kz',
          paymentTermsDays: 400,
          partner: { code: '', partnerType: 'X', countryCode: 'A' },
        })
      ),
      ['INVALID', 'INVALID_CODE', 'INVALID']
    )
    assert.equal(code(await o.viewer.post(C, newCustomer())), 'OUT_OF_SCOPE')
    assert.equal(code(await o.nobody.get(C)), 'OUT_OF_SCOPE')
    // Quem vende não define o limite de crédito.
    assert.include(details(await V.post(C, newCustomer({ creditLimit: '1000' }))), 'OUT_OF_SCOPE')
    let c = ok(await V.post(C, newCustomer()))
    assert.deepInclude(c, {
      status: 'ACTIVE',
      currency: 'AOA',
      paymentTermsDays: 30,
      creditLimit: null,
      alsoSupplier: false,
    })
    assert.deepInclude(c.partner, { code: 'CLI-1', email: 'geral@cliente.ao', taxId: '5417000071' })
    // A primeira versão dos dados fiscais (morada do terceiro, sem morada de facturação própria).
    assert.lengthOf(c.versions, 1)
    assert.deepInclude(c.versions[0].data, { name: 'Cliente Um, Lda.', taxId: '5417000071' })
    assert.equal(c.versions[0].data.billingAddress.addressLine, 'Rua da Missão 10')
    // O mesmo NIF não cria outro terceiro; o terceiro não é cliente duas vezes.
    assert.equal(
      code(await V.post(C, newCustomer({ partner: { ...newCustomer().partner, code: 'CLI-2' } }))),
      'TAX_ID_TAKEN'
    )
    assert.equal(
      code(await V.post(C, { partnerId: c.partner.id, currency: 'AOA' })),
      'ALREADY_CUSTOMER'
    )
    // Morada de facturação (a primeira é a por omissão) e de entrega; a versão acompanha a de facturação.
    c = ok(
      await V.post(`${C}/${c.id}/addresses`, {
        kind: 'BILLING',
        label: 'Sede',
        addressLine: 'Av. 4 de Fevereiro 100',
        municipality: 'Ingombota',
        province: 'Luanda',
        countryCode: 'ao',
      })
    )
    c = ok(
      await V.post(`${C}/${c.id}/addresses`, {
        kind: 'DELIVERY',
        label: 'Armazém de Viana',
        addressLine: 'Estrada de Catete km 12',
        countryCode: 'AO',
      })
    )
    assert.deepEqual(
      c.addresses.map((a: any) => [a.kind, a.label, a.isDefault]),
      [
        ['BILLING', 'Sede', true],
        ['DELIVERY', 'Armazém de Viana', true],
      ]
    )
    assert.lengthOf(c.versions, 2)
    assert.equal(c.versions[0].data.billingAddress.addressLine, 'Av. 4 de Fevereiro 100')
    // Mudar o nome cria a versão 3; mudar só condições de venda não cria versões.
    c = ok(
      await V.patch(`${C}/${c.id}`, {
        expectedVersion: c.version,
        paymentTermsDays: 45,
        partner: { expectedVersion: c.partner.version, name: 'Cliente Um, S.A.' },
      }),
      200
    )
    assert.deepEqual(
      c.versions.map((v: any) => v.versionNo),
      [3, 2, 1]
    )
    assert.equal(c.versions[0].data.name, 'Cliente Um, S.A.')
    assert.equal(c.versions[2].data.name, 'Cliente Um, Lda.')
    c = ok(await V.patch(`${C}/${c.id}`, { expectedVersion: c.version, notes: 'Bom pagador' }), 200)
    assert.lengthOf(c.versions, 3)
    // Versão em vigor para os documentos; repetida não duplica.
    const cur = ok(await o.viewer.get(`${C}/${c.id}/current-version`), 200)
    assert.deepInclude(cur, {
      versionNo: 3,
      status: 'ACTIVE',
      currency: 'AOA',
      paymentTermsDays: 45,
    })
    assert.equal(
      ok(await o.viewer.get(`${C}/${c.id}/current-version`), 200).versionId,
      cur.versionId
    )
    // As versões e o histórico não mudam na base.
    await assert.rejects(() => owner().rawQuery(`update customer_versions set data = '{}'`))
    await assert.rejects(() => owner().rawQuery(`delete from customer_events`))
    await assert.rejects(() => owner().rawQuery(`delete from customers`))
    // Limite de crédito: só com a permissão própria e motivo; versão optimista.
    assert.equal(
      code(
        await V.post(`${C}/${c.id}/credit`, {
          expectedVersion: c.version,
          creditLimit: '5000',
          reason: 'Novo',
        })
      ),
      'OUT_OF_SCOPE'
    )
    assert.include(
      details(
        await o.credit.post(`${C}/${c.id}/credit`, {
          expectedVersion: c.version,
          creditLimit: '-1',
        })
      ),
      'REQUIRED'
    )
    c = ok(
      await o.credit.post(`${C}/${c.id}/credit`, {
        expectedVersion: c.version,
        creditLimit: '250000,5',
        reason: 'Histórico de pagamentos em dia',
      }),
      200
    )
    assert.equal(c.creditLimit, '250000.50')
    assert.equal(
      (
        await o.credit.post(`${C}/${c.id}/credit`, {
          expectedVersion: c.version - 1,
          creditLimit: '1',
          reason: 'xxx',
        })
      ).status(),
      409
    )
    // Contacto principal (no terceiro).
    c = ok(
      await V.post(`${C}/${c.id}/contacts`, {
        name: 'Ana Silva',
        email: 'ana@cliente.ao',
        isPrimary: true,
      })
    )
    assert.equal(c.partner.contacts[0].name, 'Ana Silva')
    // Estado: bloquear exige motivo; reactivar limpa o motivo.
    assert.include(
      details(
        await V.post(`${C}/${c.id}/status`, { expectedVersion: c.version, status: 'BLOCKED' })
      ),
      'REQUIRED'
    )
    c = ok(
      await V.post(`${C}/${c.id}/status`, {
        expectedVersion: c.version,
        status: 'BLOCKED',
        reason: 'Dívida vencida há 90 dias',
      }),
      200
    )
    assert.deepInclude(c, { status: 'BLOCKED', statusReason: 'Dívida vencida há 90 dias' })
    assert.equal(
      code(
        await V.post(`${C}/${c.id}/status`, {
          expectedVersion: c.version,
          status: 'BLOCKED',
          reason: 'xxx',
        })
      ),
      'INVALID_STATE'
    )
    c = ok(
      await V.post(`${C}/${c.id}/status`, { expectedVersion: c.version, status: 'ACTIVE' }),
      200
    )
    assert.deepInclude(c, { status: 'ACTIVE', statusReason: null })
    // Lista e pesquisa por NIF.
    const list = ok(await o.viewer.get(`${C}?q=5417000071`), 200)
    assert.lengthOf(list, 1)
    assert.deepInclude(list[0], { code: 'CLI-1', creditLimit: '250000.50', status: 'ACTIVE' })
    assert.lengthOf(ok(await o.viewer.get(`${C}?status=BLOCKED`), 200), 0)
    const kinds = c.history.map((h: any) => h.kind)
    assert.includeMembers(kinds, [
      'CREATED',
      'ADDRESS_ADDED',
      'VERSION',
      'CREDIT_LIMIT',
      'STATUS',
      'CONTACT_ADDED',
    ])
    const actions = (
      await owner().rawQuery(
        `select distinct action from audit_events where action like 'customer.%' order by action`
      )
    ).rows.map((r: any) => r.action)
    assert.includeMembers(actions, [
      'customer.created',
      'customer.updated',
      'customer.credit_limit_changed',
      'customer.status_changed',
      'customer.address_added',
    ])
  })

  test('o fornecedor também é cliente sem duplicar o terceiro; mudança pelo fornecedor gera versão; segmentos', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Fornecedor existente (terceiro com NIF).
    const sup = ok(
      await o.api.post('/api/v1/procurement/suppliers', {
        supplierType: 'GOODS',
        currency: 'AOA',
        paymentTermsDays: 30,
        partner: {
          code: 'FORN-1',
          name: 'Fornecedor e Cliente, Lda.',
          partnerType: 'ORGANIZATION',
          taxId: '5417000081',
          countryCode: 'AO',
        },
      })
    )
    const found = ok(await o.seller.get(`${C}/lookup?countryCode=AO&taxId=5417000081`), 200)
    assert.deepInclude(found, { customerId: null })
    assert.equal(found.partner.code, 'FORN-1')
    // Segmentos: só com sales.settings.
    assert.equal(
      (await o.seller.post(`${S}/segments`, { code: 'GROSSISTA', name: 'Grossistas' })).status(),
      403
    )
    const seg = ok(await o.api.post(`${S}/segments`, { code: 'grossista', name: 'Grossistas' }))
    assert.equal(
      code(await o.api.post(`${S}/segments`, { code: 'GROSSISTA', name: 'Outro' })),
      'CODE_TAKEN'
    )
    let c = ok(
      await o.seller.post(C, { partnerId: found.partner.id, currency: 'USD', segmentId: seg.id })
    )
    assert.deepInclude(c, { alsoSupplier: true, currency: 'USD' })
    assert.equal(c.segment.code, 'GROSSISTA')
    const terceiros = (
      await owner().rawQuery(
        `select count(*)::int as n from business_partners where tax_id = '5417000081'`
      )
    ).rows[0] as any
    assert.equal(terceiros.n, 1)
    // O fornecedor muda o nome do terceiro: o documento seguinte do cliente usa uma versão nova.
    const s2 = ok(await o.api.get(`/api/v1/procurement/suppliers/${sup.id}`), 200)
    ok(
      await o.api.patch(`/api/v1/procurement/suppliers/${sup.id}`, {
        expectedVersion: s2.version,
        partner: { expectedVersion: s2.partner.version, name: 'Fornecedor e Cliente, S.A.' },
      }),
      200
    )
    const cur = ok(await o.viewer.get(`${C}/${c.id}/current-version`), 200)
    assert.deepInclude(cur, { versionNo: 2 })
    assert.equal(cur.data.name, 'Fornecedor e Cliente, S.A.')
    c = ok(await o.viewer.get(`${C}/${c.id}`), 200)
    assert.equal(c.versions[1].data.name, 'Fornecedor e Cliente, Lda.')
    // Segmento inactivo não se atribui; a lista mostra quantos clientes tem.
    const segs = ok(await o.viewer.get(`${S}/segments`), 200)
    assert.deepInclude(segs[0], { code: 'GROSSISTA', customers: 1 })
    ok(
      await o.api.patch(`${S}/segments/${seg.id}`, {
        expectedVersion: segs[0].version,
        status: 'INACTIVE',
      }),
      200
    )
    assert.include(
      details(
        await o.seller.patch(`${C}/${c.id}`, { expectedVersion: c.version, segmentId: seg.id })
      ),
      'NOT_FOUND'
    )
    assert.lengthOf(ok(await o.viewer.get(`${C}?segmentId=${seg.id}`), 200), 1)
  })
})
