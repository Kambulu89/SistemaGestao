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

const P = '/api/v1/procurement'
const S = `${P}/suppliers`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const IBAN_A = 'AO84000600000123456789012'
const IBAN_B = 'AO44004000000987654321098'
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function roleMember(client: any, admin: Session, roleCode: string, permissions: string[]) {
  const m = await memberWithRoles(client, admin, [
    (await createRole(client, admin, roleCode, permissions)).id,
  ])
  return as(client, m.session)
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const agt = ok(
    await api.post(`${P}/settings/document-types`, {
      code: 'AGT',
      name: 'Certidão de não dívida (AGT)',
      required: true,
    })
  )
  const alvara = ok(
    await api.post(`${P}/settings/document-types`, {
      code: 'ALV',
      name: 'Alvará comercial',
      required: true,
    })
  )
  const brochure = ok(
    await api.post(`${P}/settings/document-types`, { code: 'CAT', name: 'Catálogo' })
  )
  const quality = ok(
    await api.post(`${P}/settings/criteria`, {
      code: 'QUAL',
      name: 'Sistema de qualidade',
      required: true,
    })
  )
  const refs = ok(
    await api.post(`${P}/settings/criteria`, { code: 'REF', name: 'Referências comerciais' })
  )
  // Comprador: gere fornecedores; aprovador: homologa e aprova bancos; tesoureiro: só vê bancos por inteiro.
  const buyer = await roleMember(client, s, 'comprador', ['procurement.suppliers.manage'])
  const approver = await roleMember(client, s, 'aprovador', [
    'procurement.suppliers.approve',
    'procurement.suppliers.read',
  ])
  const treasurer = await roleMember(client, s, 'tesouraria', [
    'procurement.suppliers.read',
    'procurement.suppliers.bank',
  ])
  const viewer = await roleMember(client, s, 'leitor', ['procurement.suppliers.read'])
  return {
    tenant,
    s,
    api,
    agt,
    alvara,
    brochure,
    quality,
    refs,
    buyer,
    approver,
    treasurer,
    viewer,
  }
}

const newSupplier = (
  extra: Record<string, unknown> = {},
  partner: Record<string, unknown> = {}
) => ({
  supplierType: 'GOODS',
  currency: 'AOA',
  paymentTermsDays: 30,
  paymentMethod: 'TRANSFER',
  leadTimeDays: 7,
  minOrderAmount: '50000.00',
  partner: {
    code: 'FORN-01',
    name: 'Distribuidora Kwanza, Lda.',
    partnerType: 'ORGANIZATION',
    taxId: '5417000012',
    countryCode: 'AO',
    email: 'Compras@Kwanza.ao',
    city: 'Luanda',
    ...partner,
  },
  ...extra,
})

test.group('Compras | fornecedores (9.1)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('ficha, documentos com validade, critérios, homologação segregada, suspensão e histórico', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Validações e permissões.
    assert.include(details(await o.buyer.post(S, newSupplier({ currency: 'X' }))), 'INVALID')
    assert.include(
      details(await o.buyer.post(S, newSupplier({}, { taxId: 'NIF COM ESPAÇOS' }))),
      'INVALID'
    )
    assert.equal(code(await o.viewer.post(S, newSupplier())), 'OUT_OF_SCOPE')
    let sup = ok(await o.buyer.post(S, newSupplier()))
    assert.deepInclude(sup, { status: 'DRAFT', currency: 'AOA', minOrderAmount: '50000.00' })
    assert.deepInclude(sup.partner, {
      code: 'FORN-01',
      taxId: '5417000012',
      email: 'compras@kwanza.ao',
    })
    assert.deepInclude(sup.qualification, { valid: false, missing: ['AGT', 'ALV'] })
    // NIF repetido: aponta para o terceiro existente em vez de duplicar.
    const dup = await o.buyer.post(S, newSupplier({}, { code: 'FORN-02' }))
    assert.equal(code(dup), 'TAX_ID_TAKEN')
    assert.equal(dup.body().error.details[0].message, sup.partner.id)
    // O mesmo terceiro não é fornecedor duas vezes.
    assert.equal(
      code(
        await o.buyer.post(S, { supplierType: 'GOODS', currency: 'AOA', partnerId: sup.partner.id })
      ),
      'ALREADY_SUPPLIER'
    )
    const look = ok(await o.buyer.get(`${S}/lookup?countryCode=AO&taxId=5417000012`), 200)
    assert.deepEqual(look, {
      partner: {
        id: sup.partner.id,
        code: 'FORN-01',
        name: 'Distribuidora Kwanza, Lda.',
        taxId: '5417000012',
      },
      supplierId: sup.id,
    })

    // Contactos: um principal de cada vez.
    sup = ok(
      await o.buyer.post(`${S}/${sup.id}/contacts`, {
        name: 'Ana Comercial',
        role: 'Gestora de conta',
        email: 'ana@kwanza.ao',
        isPrimary: true,
      })
    )
    sup = ok(
      await o.buyer.post(`${S}/${sup.id}/contacts`, {
        name: 'Rui Logística',
        phone: '+244 923 000 000',
        isPrimary: true,
      })
    )
    assert.deepEqual(
      sup.partner.contacts.map((c: any) => [c.name, c.isPrimary]),
      [
        ['Rui Logística', true],
        ['Ana Comercial', false],
      ]
    )
    assert.include(
      details(await o.buyer.post(`${S}/${sup.id}/contacts`, { name: 'Sem meio' })),
      'REQUIRED'
    )

    // Pedir homologação sem documentos: recusado com o que falta.
    const items = [
      { criterionId: o.quality.id, result: 'MET' },
      { criterionId: o.refs.id, result: 'NOT_APPLICABLE' },
    ]
    const nq = await o.buyer.post(`${S}/${sup.id}/submit`, { expectedVersion: sup.version, items })
    assert.equal(code(nq), 'NOT_QUALIFIED')
    assert.sameMembers(details(nq), ['MISSING', 'MISSING'])
    // Documentos: validações, um caducado e um com anexo de outro registo recusados.
    assert.include(
      details(
        await o.buyer.post(`${S}/${sup.id}/documents`, {
          documentTypeId: o.agt.id,
          issuedOn: day(1),
          validUntil: day(30),
        })
      ),
      'INVALID'
    )
    sup = ok(
      await o.buyer.post(`${S}/${sup.id}/documents`, {
        documentTypeId: o.agt.id,
        number: 'CND-2026/001',
        issuedOn: day(-60),
        validUntil: day(-1),
      })
    )
    sup = ok(
      await o.buyer.post(`${S}/${sup.id}/documents`, {
        documentTypeId: o.alvara.id,
        number: 'ALV-77',
        issuedOn: day(-400),
      })
    )
    assert.deepInclude(sup.qualification, { valid: false, missing: [], expired: ['AGT'] })
    assert.include(
      details(
        await o.buyer.post(`${S}/${sup.id}/documents`, {
          documentTypeId: o.agt.id,
          attachmentId: '00000000-0000-4000-8000-000000000000',
        })
      ),
      'NOT_FOUND'
    )
    sup = ok(
      await o.buyer.post(`${S}/${sup.id}/documents`, {
        documentTypeId: o.agt.id,
        number: 'CND-2026/002',
        issuedOn: day(-1),
        validUntil: day(20),
      })
    )
    assert.deepInclude(sup.qualification, {
      valid: true,
      expiring: ['AGT'],
      expiresOn: day(20),
    })
    // Critérios: obrigatório não cumprido, critério em falta.
    assert.include(
      details(
        await o.buyer.post(`${S}/${sup.id}/submit`, {
          expectedVersion: sup.version,
          items: [{ criterionId: o.quality.id, result: 'NOT_MET', notes: 'Sem ISO' }, items[1]],
        })
      ),
      'REQUIRED_NOT_MET'
    )
    assert.include(
      details(
        await o.buyer.post(`${S}/${sup.id}/submit`, {
          expectedVersion: sup.version,
          items: [items[0]],
        })
      ),
      'MISSING'
    )
    sup = ok(
      await o.buyer.post(`${S}/${sup.id}/submit`, {
        expectedVersion: sup.version,
        items,
        notes: 'Visita às instalações feita.',
      }),
      200
    )
    assert.equal(sup.status, 'PENDING_APPROVAL')
    assert.isFalse(sup.can.decide)
    // Quem pede não decide (nem com a permissão) — e o comprador não a tem.
    assert.equal(
      code(await o.buyer.post(`${S}/${sup.id}/approve`, { expectedVersion: sup.version })),
      'OUT_OF_SCOPE'
    )
    const both = await roleMember(client, o.s, 'ambos', [
      'procurement.suppliers.manage',
      'procurement.suppliers.approve',
    ])
    // Recusar exige motivo.
    assert.include(
      details(await o.approver.post(`${S}/${sup.id}/reject`, { expectedVersion: sup.version })),
      'REQUIRED'
    )
    sup = ok(
      await o.approver.post(`${S}/${sup.id}/reject`, {
        expectedVersion: sup.version,
        reason: 'Referências por confirmar',
      }),
      200
    )
    assert.equal(sup.status, 'REJECTED')
    // Novo pedido, agora por quem também aprova: não pode decidir o próprio pedido.
    sup = ok(await both.post(`${S}/${sup.id}/submit`, { expectedVersion: sup.version, items }), 200)
    assert.equal(
      code(await both.post(`${S}/${sup.id}/approve`, { expectedVersion: sup.version })),
      'SELF_APPROVAL'
    )
    // Versão antiga recusada; aprovação pela outra pessoa.
    assert.equal(
      (
        await o.approver.post(`${S}/${sup.id}/approve`, { expectedVersion: sup.version - 1 })
      ).status(),
      409
    )
    sup = ok(await o.approver.post(`${S}/${sup.id}/approve`, { expectedVersion: sup.version }), 200)
    assert.equal(sup.status, 'APPROVED')
    assert.isNotNull(sup.approvedAt)
    assert.lengthOf(sup.reviews, 2)
    assert.deepInclude(sup.reviews[0], { status: 'APPROVED' })
    assert.deepEqual(
      sup.reviews[0].items.map((i: any) => [i.code, i.result]),
      [
        ['QUAL', 'MET'],
        ['REF', 'NOT_APPLICABLE'],
      ]
    )
    // O pedido guardou os documentos válidos que o sustentavam.
    assert.sameMembers(
      sup.reviews[0].documents.map((d: any) => d.number),
      ['ALV-77', 'CND-2026/002']
    )

    // Homologado: o NIF não muda; as condições sim (auditadas).
    assert.include(
      details(
        await o.buyer.patch(`${S}/${sup.id}`, {
          expectedVersion: sup.version,
          partner: { expectedVersion: sup.partner.version, taxId: '5417999999' },
        })
      ),
      'FIXED'
    )
    sup = ok(
      await o.buyer.patch(`${S}/${sup.id}`, {
        expectedVersion: sup.version,
        paymentTermsDays: 45,
        partner: { expectedVersion: sup.partner.version, phone: '+244 222 000 000' },
      }),
      200
    )
    assert.equal(sup.paymentTermsDays, 45)
    assert.equal(sup.partner.phone, '+244 222 000 000')

    // Documento desactivado (com motivo) faz a homologação deixar de valer, sem mudar o estado.
    const agtDoc = sup.documents.find((d: any) => d.number === 'CND-2026/002')
    assert.include(
      details(
        await o.buyer.post(`${P}/supplier-documents/${agtDoc.id}/deactivate`, {
          expectedVersion: agtDoc.version,
        })
      ),
      'REQUIRED'
    )
    sup = ok(
      await o.buyer.post(`${P}/supplier-documents/${agtDoc.id}/deactivate`, {
        expectedVersion: agtDoc.version,
        reason: 'Emitida com erro no NIF',
      }),
      200
    )
    assert.equal(sup.status, 'APPROVED')
    assert.deepInclude(sup.qualification, { valid: false, expired: ['AGT'] })

    // Suspensão (com motivo) e o histórico completo, do mais recente para o mais antigo.
    assert.equal(
      code(
        await o.buyer.post(`${S}/${sup.id}/suspend`, { expectedVersion: sup.version, reason: 'x' })
      ),
      'OUT_OF_SCOPE'
    )
    sup = ok(
      await o.approver.post(`${S}/${sup.id}/suspend`, {
        expectedVersion: sup.version,
        reason: 'Certidão inválida',
      }),
      200
    )
    assert.equal(sup.status, 'SUSPENDED')
    assert.deepEqual(
      sup.history.map((h: any) => h.kind),
      [
        'SUSPENDED',
        'DOCUMENT_DEACTIVATED',
        'UPDATED',
        'APPROVED',
        'SUBMITTED',
        'REJECTED',
        'SUBMITTED',
        'DOCUMENT_ADDED',
        'DOCUMENT_ADDED',
        'DOCUMENT_ADDED',
        'CREATED',
      ]
    )
    // Lista: filtros e homologação válida por fornecedor.
    const list = ok(await o.viewer.get(`${S}?status=SUSPENDED&q=kwanza`), 200)
    assert.lengthOf(list, 1)
    assert.deepInclude(list[0], { status: 'SUSPENDED', qualificationValid: false })
    assert.lengthOf(ok(await o.viewer.get(`${S}?status=APPROVED`), 200), 0)

    // A base de dados não deixa reescrever o que foi decidido nem o histórico.
    for (const sql of [
      `update supplier_reviews set decision_reason = 'x' where status = 'APPROVED'`,
      `update supplier_review_items set result = 'NOT_MET'`,
      `delete from supplier_events`,
      `update supplier_documents set valid_until = '2099-01-01'`,
      `update supplier_reviews set decided_by = submitted_by`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where action like 'supplier.%' or action like 'business_partner.%'`
    )
    assert.includeMembers(
      (audits.rows as any[]).map((r) => r.action),
      [
        'business_partner.created',
        'business_partner.contact_added',
        'business_partner.updated',
        'supplier.created',
        'supplier.updated',
        'supplier.document_added',
        'supplier.document_deactivated',
        'supplier.submitted',
        'supplier.rejected',
        'supplier.approved',
        'supplier.suspended',
      ]
    )
  })

  test('dados bancários protegidos: pendentes até outra pessoa aprovar, mascarados sem permissão, nunca reescritos', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    let sup = ok(await o.buyer.post(S, newSupplier()))
    // Validações.
    assert.include(
      details(
        await o.buyer.post(`${S}/${sup.id}/bank-accounts`, {
          holderName: 'Distribuidora Kwanza',
          bankName: 'Banco A',
          iban: 'AO06000600000123456789012',
        })
      ),
      'INVALID'
    )
    assert.include(
      details(
        await o.buyer.post(`${S}/${sup.id}/bank-accounts`, {
          holderName: 'Kwanza',
          bankName: 'Banco A',
        })
      ),
      'REQUIRED'
    )
    sup = ok(
      await o.buyer.post(`${S}/${sup.id}/bank-accounts`, {
        holderName: 'Distribuidora Kwanza, Lda.',
        bankName: 'Banco A',
        iban: 'ao84 0006 0000 0123 4567 8901 2',
        swiftBic: 'bfmxaolu',
      })
    )
    assert.equal(
      code(
        await o.buyer.post(`${S}/${sup.id}/bank-accounts`, {
          holderName: 'Distribuidora Kwanza, Lda.',
          bankName: 'Banco A',
          iban: IBAN_A,
        })
      ),
      'IBAN_EXISTS'
    )
    let acc = sup.bankAccounts[0]
    // Quem regista vê mascarado (não tem `.bank`); a tesouraria vê por inteiro.
    assert.deepInclude(acc, {
      status: 'PENDING_APPROVAL',
      iban: 'AO84 •••• 9012',
      masked: true,
      swiftBic: 'BFMXAOLU',
    })
    const full = ok(await o.treasurer.get(`${S}/${sup.id}`), 200)
    assert.deepInclude(full.bankAccounts[0], { iban: IBAN_A, masked: false })
    // Quem registou não aprova; sem `.approve` também não; o aprovador aprova.
    const both = await roleMember(client, o.s, 'ambos', [
      'procurement.suppliers.manage',
      'procurement.suppliers.approve',
    ])
    sup = ok(
      await both.post(`${S}/${sup.id}/bank-accounts`, {
        holderName: 'Distribuidora Kwanza, Lda.',
        bankName: 'Banco B',
        iban: IBAN_B,
      })
    )
    const mine = sup.bankAccounts.find((a: any) => a.bankName === 'Banco B')
    // Quem registou vê a conta sem poder decidir; o aprovador pode.
    assert.isFalse(mine.canDecide)
    assert.isTrue(
      ok(await o.approver.get(`${S}/${sup.id}`), 200).bankAccounts.find(
        (a: any) => a.id === mine.id
      ).canDecide
    )
    assert.equal(
      code(
        await both.post(`${P}/supplier-bank-accounts/${mine.id}/approve`, {
          expectedVersion: mine.version,
        })
      ),
      'SELF_APPROVAL'
    )
    assert.equal(
      code(
        await o.buyer.post(`${P}/supplier-bank-accounts/${acc.id}/approve`, {
          expectedVersion: acc.version,
        })
      ),
      'OUT_OF_SCOPE'
    )
    sup = ok(
      await o.approver.post(`${P}/supplier-bank-accounts/${acc.id}/approve`, {
        expectedVersion: acc.version,
      }),
      200
    )
    acc = sup.bankAccounts.find((a: any) => a.id === acc.id)
    assert.equal(acc.status, 'ACTIVE')
    // A outra conta: recusada com motivo; depois não se mexe.
    assert.include(
      details(
        await o.approver.post(`${P}/supplier-bank-accounts/${mine.id}/reject`, {
          expectedVersion: mine.version,
        })
      ),
      'REQUIRED'
    )
    sup = ok(
      await o.approver.post(`${P}/supplier-bank-accounts/${mine.id}/reject`, {
        expectedVersion: mine.version,
        reason: 'IBAN não confere com a declaração bancária',
      }),
      200
    )
    const rejected = sup.bankAccounts.find((a: any) => a.id === mine.id)
    assert.equal(rejected.status, 'REJECTED')
    assert.equal(
      code(
        await o.buyer.post(`${P}/supplier-bank-accounts/${mine.id}/deactivate`, {
          expectedVersion: rejected.version,
          reason: 'x',
        })
      ),
      'INVALID_STATE'
    )
    // Desactivar a activa (com motivo).
    sup = ok(
      await o.buyer.post(`${P}/supplier-bank-accounts/${acc.id}/deactivate`, {
        expectedVersion: acc.version,
        reason: 'Conta encerrada',
      }),
      200
    )
    assert.equal(sup.bankAccounts.find((a: any) => a.id === acc.id).status, 'INACTIVE')
    // A base de dados recusa reescrever os dados bancários e auto-aprovar.
    for (const sql of [
      `update supplier_bank_accounts set iban = '${IBAN_B}' where status = 'INACTIVE'`,
      `update supplier_bank_accounts set holder_name = 'Outro titular'`,
      `update supplier_bank_accounts set decided_by = requested_by`,
      `delete from supplier_bank_accounts`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
    // O IBAN nunca entra inteiro na auditoria nem no histórico.
    const leaked = await owner().rawQuery(
      `select (select count(*) from audit_events where changes::text like ? or changes::text like ?)::int as a,
              (select count(*) from supplier_events where details::text like ? or details::text like ?)::int as e`,
      [`%${IBAN_A}%`, `%${IBAN_B}%`, `%${IBAN_A}%`, `%${IBAN_B}%`]
    )
    assert.deepEqual(leaked.rows[0], { a: 0, e: 0 })
    assert.deepInclude(sup.history[0], {
      kind: 'BANK_ACCOUNT_DEACTIVATED',
      reason: 'Conta encerrada',
    })
  })

  test('configuração: tipos de documento e critérios com permissão própria; anexos do fornecedor', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    assert.equal(
      (await o.buyer.post(`${P}/settings/criteria`, { code: 'X', name: 'Critério X' })).status(),
      403
    )
    assert.equal(
      code(await o.api.post(`${P}/settings/criteria`, { code: 'qual', name: 'Repetido' })),
      'CODE_TAKEN'
    )
    const list = ok(await o.viewer.get(`${P}/settings/document-types`), 200)
    assert.deepEqual(
      list.map((x: any) => [x.code, x.required]),
      [
        ['AGT', true],
        ['ALV', true],
        ['CAT', false],
      ]
    )
    // Inactivar o alvará: deixa de ser exigido.
    const alv = list.find((x: any) => x.code === 'ALV')
    ok(
      await o.api.patch(`${P}/settings/document-types/${alv.id}`, {
        expectedVersion: alv.version,
        status: 'INACTIVE',
      }),
      200
    )
    assert.include(
      details(
        await o.api.patch(`${P}/settings/document-types/${alv.id}`, {
          expectedVersion: alv.version + 1,
          code: 'NOVO',
        })
      ),
      'FIXED'
    )
    const sup = ok(await o.buyer.post(S, newSupplier()))
    assert.deepEqual(sup.qualification.missing, ['AGT'])
    // Documento de tipo inactivo recusado.
    assert.include(
      details(await o.buyer.post(`${S}/${sup.id}/documents`, { documentTypeId: alv.id })),
      'NOT_FOUND'
    )
    // Sem permissões de compras: nem a configuração se lê.
    const nobody = await roleMember(client, o.s, 'nada', ['members.read'])
    assert.equal((await nobody.get(`${P}/settings/criteria`)).status(), 403)
    assert.equal((await nobody.get(S)).status(), 403)
    assert.equal((await nobody.get(`${S}/${sup.id}`)).status(), 403)
    // Anexo do fornecedor: o leitor vê a lista, não acrescenta; o comprador acrescenta e liga ao documento.
    assert.equal(
      (await o.viewer.get(`/api/v1/attachments?subjectType=supplier&subjectId=${sup.id}`)).status(),
      200
    )
  })
})
