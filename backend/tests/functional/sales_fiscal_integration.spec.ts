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
const F = `${S}/fiscal`
const owner = () => db.connection('owner')
const ok = (r: any, status = 200) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const today = () => new Date().toISOString().slice(0, 10)
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
  const manager = await member(client, s, 'integracao', ['sales.fiscal.manage'])
  const reader = await member(client, s, 'leitor_fiscal', ['sales.fiscal.read'])
  const confirmer = await member(client, s, 'fiscal_conf', [
    'sales.fiscal.confirm',
    'sales.notes.issue',
  ])
  const uom = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    }),
    201
  )
  const sv = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'INST',
      name: 'Instalação',
      productType: 'SERVICE',
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: '500',
    }),
    201
  )
  const c1 = ok(
    await api.post(`${S}/customers`, {
      currency: 'AOA',
      paymentTermsDays: 30,
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
    await api.post(`${F}/tax-codes`, {
      countryCode: 'AO',
      code: 'T10',
      name: 'Imposto de teste',
      kind: 'TAX',
      taxType: 'VAT',
    }),
    201
  )
  t10 = ok(
    await api.post(`${F}/tax-codes/${t10.id}/rates`, {
      rate: '10',
      validFrom: `${year - 1}-01-01`,
      legalSource: SOURCE,
    }),
    201
  )
  ok(
    await confirmer.post(`${F}/tax-rates/${t10.rates[0].id}/confirm`, {
      expectedVersion: t10.rates[0].version,
    })
  )
  for (const [kind, c] of [
    ['INVOICE', 'FT'],
    ['CREDIT_NOTE', 'NC'],
  ]) {
    const x = ok(
      await api.post(`${F}/series`, {
        legalEntityId: le.id,
        documentKind: kind,
        fiscalCode: c,
        code: c,
        fiscalYear: year,
        prefix: `${c} A/`,
      }),
      201
    )
    ok(await api.post(`${F}/series/${x.id}/activate`, { expectedVersion: x.version }))
  }
  const invoice = async () => {
    let i = ok(
      await api.post(`${S}/invoices`, {
        legalEntityId: le.id,
        customerId: c1.id,
        invoiceDate: today(),
        lines: [{ productId: sv.id, quantity: '1', taxCodeIds: [t10.id] }],
      }),
      201
    )
    i = ok(await api.post(`${S}/invoices/${i.id}/issue`, { expectedVersion: i.version }))
    return i
  }
  const sub = async (documentId: string, type = 'SALES_INVOICE') =>
    ok(await reader.get(`${F}/submissions/document/${type}/${documentId}`))
  const settings = async () =>
    ok(await manager.get(`${F}/integration`)).entities.find((e: any) => e.legalEntity.id === le.id)
  const configure = async (input: Record<string, unknown>) => {
    const cur = await settings()
    return manager.put(`${F}/integration/${le.id}`, {
      provider: 'LOCAL_SIMULATOR',
      simulatorScenario: cur.simulatorScenario,
      maxAttempts: cur.maxAttempts,
      expectedVersion: cur.version,
      ...input,
    })
  }
  return { tenant, api, le, manager, reader, confirmer, invoice, sub, settings, configure }
}

test.group('Vendas | integração fiscal electrónica em simulação (10.9)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('fila na emissão, simulador local com cenários, tentativas com espera, idempotência e imutabilidade', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // O adaptador oficial está registado mas indisponível: não se pode escolher.
    const info = ok(await o.reader.get(`${F}/integration`))
    assert.deepEqual(
      info.providers.map((p: any) => [p.code, p.available]),
      [
        ['LOCAL_SIMULATOR', true],
        ['AGT_OFFICIAL', false],
      ]
    )
    assert.equal(code(await o.configure({ provider: 'AGT_OFFICIAL' })), 'PROVIDER_UNAVAILABLE')
    assert.equal(code(await o.reader.put(`${F}/integration/${o.le.id}`, {})), 'OUT_OF_SCOPE')

    // Emissão: na fila, com o payload interno fotografado (não é o formato oficial).
    const a = await o.invoice()
    let s = await o.sub(a.id)
    assert.deepEqual(
      [
        s.status,
        s.provider,
        s.environment,
        s.payloadFormat,
        s.payload.simulation,
        s.payload.documentType,
      ],
      ['QUEUED', 'LOCAL_SIMULATOR', 'SIMULATION', 'SG-SIM-1', true, 'FT']
    )
    assert.deepEqual(
      [
        s.payload.number,
        s.payload.issuer.taxId,
        s.payload.customer.taxId,
        s.payload.totals.payable,
      ],
      [a.number, '5000000931', '5417000071', '550.00']
    )
    assert.equal(a.fiscalStatus, 'PENDING')
    // Quem só consulta não processa.
    assert.equal((await o.reader.post(`${F}/submissions/process`, {})).status(), 403)
    // Processar: envio → pedido recebido → consulta → aceite (simulação); a factura fica "aceite".
    let run = ok(await o.manager.post(`${F}/submissions/process`, {}))
    assert.deepEqual(
      run.results.map((r: any) => r.outcome),
      ['RECEIVED', 'ACCEPTED']
    )
    s = await o.sub(a.id)
    assert.deepEqual(
      [s.status, s.resultCode, s.attempts, s.requestId.startsWith('SIM-')],
      ['ACCEPTED', 'SIM-000', 1, true]
    )
    assert.deepEqual(
      s.history.map((h: any) => [h.action, h.outcome]),
      [
        ['SUBMIT', 'OK'],
        ['POLL', 'ACCEPTED'],
      ]
    )
    assert.equal(ok(await o.api.get(`${S}/invoices/${a.id}`)).fiscalStatus, 'ACCEPTED')
    assert.equal(
      code(await o.manager.post(`${F}/submissions/${s.id}/process`, {})),
      'INVALID_STATE'
    )

    // Rejeição pelo simulador: a factura fica "rejeitada" (corrige-se por nota); não se repete.
    ok(await o.configure({ simulatorScenario: 'REJECT' }))
    const b = await o.invoice()
    ok(await o.manager.post(`${F}/submissions/process`, {}))
    s = await o.sub(b.id)
    assert.deepEqual([s.status, s.resultCode], ['REJECTED', 'SIM-422'])
    assert.equal(ok(await o.api.get(`${S}/invoices/${b.id}`)).fiscalStatus, 'REJECTED')
    assert.equal(
      code(
        await o.manager.post(`${F}/submissions/${s.id}/requeue`, {
          expectedVersion: s.version,
          reason: 'Teste',
        })
      ),
      'INVALID_STATE'
    )

    // Indisponível: falha transitória, espera crescente, esgota as tentativas; repete-se com motivo.
    ok(await o.configure({ simulatorScenario: 'UNAVAILABLE', maxAttempts: 2 }))
    const c = await o.invoice()
    run = ok(await o.manager.post(`${F}/submissions/process`, {}))
    assert.deepEqual(
      run.results.map((r: any) => r.outcome),
      ['TRANSIENT']
    )
    s = await o.sub(c.id)
    assert.deepEqual([s.status, s.failures, s.resultCode], ['QUEUED', 1, 'SIM-503'])
    assert.isTrue(new Date(s.nextAttemptAt).getTime() > Date.now())
    // Ainda não venceu: o processamento periódico não lhe toca.
    assert.equal(ok(await o.manager.post(`${F}/submissions/process`, {})).processed, 0)
    s = ok(await o.manager.post(`${F}/submissions/${s.id}/process`, {}))
    assert.deepEqual([s.status, s.failures, s.attempts], ['FAILED', 2, 2])
    assert.equal(ok(await o.api.get(`${S}/invoices/${c.id}`)).fiscalStatus, 'PENDING')
    assert.equal(
      code(
        await o.manager.post(`${F}/submissions/${s.id}/requeue`, { expectedVersion: s.version })
      ),
      'VALIDATION_ERROR'
    )
    ok(await o.configure({ simulatorScenario: 'ACCEPT', maxAttempts: 5 }))
    s = ok(
      await o.manager.post(`${F}/submissions/${s.id}/requeue`, {
        expectedVersion: s.version,
        reason: 'Serviço reposto',
      })
    )
    assert.deepEqual([s.status, s.failures], ['QUEUED', 0])
    ok(await o.manager.post(`${F}/submissions/process`, {}))
    assert.equal((await o.sub(c.id)).status, 'ACCEPTED')

    // Atraso: a consulta fica pendente e repete mais tarde.
    ok(await o.configure({ simulatorScenario: 'DELAYED' }))
    const d = await o.invoice()
    run = ok(await o.manager.post(`${F}/submissions/process`, {}))
    assert.deepEqual(
      run.results.map((r: any) => r.outcome),
      ['RECEIVED', 'PENDING']
    )
    s = await o.sub(d.id)
    assert.equal(s.status, 'AWAITING')
    s = ok(await o.manager.post(`${F}/submissions/${s.id}/process`, {}))
    assert.equal(s.status, 'ACCEPTED')

    // Resposta perdida depois do envio: o reenvio com a mesma chave devolve o mesmo pedido (idempotente).
    ok(await o.configure({ simulatorScenario: 'ACCEPT' }))
    const e = await o.invoice()
    s = await o.sub(e.id)
    ok(await o.manager.post(`${F}/submissions/${s.id}/process`, {}))
    const first = (await o.sub(e.id)).requestId
    await owner().rawQuery(
      `update fiscal_submissions set status = 'QUEUED', request_id = null where id = ?`,
      [s.id]
    )
    s = ok(await o.manager.post(`${F}/submissions/${s.id}/process`, {}))
    assert.equal(s.requestId, first)
    const sims = await owner().rawQuery(
      `select count(*)::int as n from fiscal_simulator_requests where idempotency_key = ?`,
      [s.idempotencyKey]
    )
    assert.equal(sims.rows[0].n, 1)
    // Envio interrompido (reclamado e nunca terminado): passado o prazo, é retomado.
    await owner().rawQuery(
      `update fiscal_submissions set status = 'SENDING', updated_at = now() - interval '10 minutes' where id = ?`,
      [s.id]
    )
    ok(await o.manager.post(`${F}/submissions/process`, {}))
    assert.equal((await o.sub(e.id)).status, 'ACCEPTED')

    // Concorrência: dois processamentos em paralelo nunca enviam o mesmo documento duas vezes.
    const many = [await o.invoice(), await o.invoice(), await o.invoice()]
    await Promise.all([
      o.manager.post(`${F}/submissions/process`, {}),
      o.manager.post(`${F}/submissions/process`, {}),
    ])
    for (const x of many) {
      const v = await o.sub(x.id)
      assert.equal(v.status, 'ACCEPTED')
      assert.equal(v.history.filter((h: any) => h.action === 'SUBMIT').length, 1)
    }

    // Base: o payload fotografado não muda, a decisão não volta atrás, as tentativas não se apagam.
    const acc = await o.sub(a.id)
    for (const sql of [
      `update fiscal_submissions set payload = '{}' where id = '${acc.id}'`,
      `update fiscal_submissions set status = 'QUEUED' where id = '${acc.id}'`,
      `delete from fiscal_submissions where id = '${acc.id}'`,
      `delete from fiscal_submission_attempts where submission_id = '${acc.id}'`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
    // Uma só submissão por documento.
    const dup = await owner().rawQuery(
      `select count(*)::int as n from fiscal_submissions where document_id = ?`,
      [a.id]
    )
    assert.equal(dup.rows[0].n, 1)
  })

  test('contingência: documentos retidos e enviados depois; notas de crédito na mesma fila', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    let st = await o.settings()
    assert.equal(
      code(
        await o.manager.post(`${F}/integration/${o.le.id}/contingency`, {
          active: true,
          expectedVersion: st.version,
        })
      ),
      'VALIDATION_ERROR'
    )
    ok(
      await o.manager.post(`${F}/integration/${o.le.id}/contingency`, {
        active: true,
        reason: 'Sem ligação ao serviço',
        expectedVersion: st.version,
      })
    )
    st = await o.settings()
    assert.deepEqual([st.contingency, st.contingencyReason], [true, 'Sem ligação ao serviço'])
    const a = await o.invoice()
    let s = await o.sub(a.id)
    assert.deepEqual([s.status, s.inContingency], ['CONTINGENCY', true])
    assert.equal(ok(await o.api.get(`${S}/invoices/${a.id}`)).fiscalStatus, 'CONTINGENCY')
    // Retido: o processamento não o envia.
    assert.equal(ok(await o.manager.post(`${F}/submissions/process`, {})).processed, 0)
    const end = ok(
      await o.manager.post(`${F}/integration/${o.le.id}/contingency`, {
        active: false,
        reason: 'Ligação reposta',
        expectedVersion: st.version,
      })
    )
    assert.equal(end.released, 1)
    ok(await o.manager.post(`${F}/submissions/process`, {}))
    s = await o.sub(a.id)
    assert.deepEqual([s.status, s.inContingency], ['ACCEPTED', true])
    assert.deepEqual(
      s.history.map((h: any) => h.action),
      ['CONTINGENCY', 'REQUEUE', 'SUBMIT', 'POLL']
    )
    assert.equal(ok(await o.api.get(`${S}/invoices/${a.id}`)).fiscalStatus, 'ACCEPTED')

    // Nota de crédito: entra na mesma fila com a referência ao original.
    let nc = ok(
      await o.api.post(`${S}/notes`, {
        kind: 'CREDIT',
        invoiceId: a.id,
        reasonCode: 'DISCOUNT',
        reason: 'Desconto acordado',
        noteDate: today(),
        lines: [{ invoiceLineId: a.lines[0].id, mode: 'VALUE', amount: '100' }],
      }),
      201
    )
    nc = ok(await o.confirmer.post(`${S}/notes/${nc.id}/issue`, { expectedVersion: nc.version }))
    s = await o.sub(nc.id, 'SALES_NOTE')
    assert.deepEqual(
      [s.status, s.payload.documentType, s.payload.reference.number, s.payload.totals.payable],
      ['QUEUED', 'NC', a.number, '110.00']
    )
    ok(await o.manager.post(`${F}/submissions/process`, {}))
    assert.equal(ok(await o.api.get(`${S}/notes/${nc.id}`)).fiscalStatus, 'ACCEPTED')
    // Lista com filtros e auditoria das decisões.
    const list = ok(await o.reader.get(`${F}/submissions?documentType=SALES_NOTE`))
    assert.deepEqual(
      list.map((x: any) => x.documentNumber),
      [nc.number]
    )
    const audits = await owner().rawQuery(
      `select action from audit_events where tenant_id = ? and action like 'fiscal_%' order by created_at`,
      [o.tenant.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      [
        'fiscal_integration.contingency_started',
        'fiscal_integration.contingency_ended',
        'fiscal_submission.accepted',
      ]
    )
  })
})
