import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import {
  as,
  cleanDatabase,
  createRole,
  lastTokenFor,
  memberWithRoles,
  PASSWORD,
  signIn,
  subscribe,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const ORG = '/api/v1/organization'
const owner = () => db.connection('owner')

/** IBAN válido (dígitos de controlo ISO 13616) a partir do BBAN. */
function iban(country: string, bban: string) {
  const digits = (bban + country + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let r = 0
  for (const ch of digits) r = (r * 10 + Number(ch)) % 97
  return `${country}${String(98 - r).padStart(2, '0')}${bban}`
}

async function admin(client: any) {
  const { tenant, admin: user } = await tenantWithAdmin()
  const s = await signIn(client, user.email, tenant.id)
  const me = (await as(client, s).get('/api/v1/context')).body().data.membershipId as string
  return { s, tenantId: tenant.id, me, userId: user.id as string }
}

async function legalEntity(client: any, s: Session, code = 'LE1', taxId = '5000000001') {
  const r = await as(client, s).post(`${ORG}/legal-entities`, {
    code,
    legalName: `Entidade ${code}, Lda.`,
    taxId,
    countryCode: 'AO',
    functionalCurrency: 'AOA',
  })
  if (r.status() !== 201) throw new Error(JSON.stringify(r.body()))
  return r.body().data
}

test.group('administração | estrutura organizacional completa', (group) => {
  group.each.setup(() => cleanDatabase())

  test('entidade legal com regime, contactos, morada e representante; validações', async ({
    client,
    assert,
  }) => {
    const { s } = await admin(client)
    const le = await legalEntity(client, s)
    assert.deepInclude(le, { vatRegistered: false, fiscalYearStartMonth: 1, email: null })
    const bad = await as(client, s).patch(`${ORG}/legal-entities/${le.id}`, {
      expectedVersion: 1,
      email: 'não é email',
      website: 'ftp://x',
      fiscalYearStartMonth: 13,
      phone: 'abc',
    })
    bad.assertStatus(422)
    assert.includeMembers(
      bad.body().error.details.map((d: any) => d.path),
      ['email', 'website', 'fiscalYearStartMonth', 'phone']
    )
    const ok = await as(client, s).patch(`${ORG}/legal-entities/${le.id}`, {
      expectedVersion: 1,
      taxRegime: 'Regime geral',
      vatRegistered: true,
      fiscalYearStartMonth: 1,
      email: 'Geral@Empresa.AO',
      phone: '+244 923 000 000',
      website: 'https://empresa.ao',
      province: 'Luanda',
      municipality: 'Belas',
      commune: 'Talatona',
      neighbourhood: 'Camama',
      addressLine: 'Rua 1, n.º 2',
      representativeName: 'Maria Silva',
      representativeRole: 'Gerente',
    })
    ok.assertStatus(200)
    assert.deepInclude(ok.body().data, {
      email: 'geral@empresa.ao',
      vatRegistered: true,
      province: 'Luanda',
    })
  })

  test('responsável tem de ser membro activo desta empresa; centro de custo da mesma entidade', async ({
    client,
    assert,
  }) => {
    const { s, me } = await admin(client)
    const le = await legalEntity(client, s)
    const other = await legalEntity(client, s, 'LE2', '5000000002')
    const cc = (
      await as(client, s).post(`${ORG}/cost-centers`, {
        code: 'CC1',
        name: 'Centro 1',
        legalEntityId: other.id,
      })
    ).body().data
    const foreign = await admin(client)
    const branch = await as(client, s).post(`${ORG}/branches`, {
      code: 'B1',
      name: 'Filial 1',
      legalEntityId: le.id,
      managerMembershipId: foreign.me,
      costCenterId: cc.id,
    })
    branch.assertStatus(422)
    assert.sameMembers(
      branch.body().error.details.map((d: any) => `${d.path}:${d.code}`),
      ['managerMembershipId:NOT_FOUND', 'costCenterId:OTHER_LEGAL_ENTITY']
    )
    const ok = await as(client, s).post(`${ORG}/branches`, {
      code: 'B1',
      name: 'Filial 1',
      legalEntityId: le.id,
      managerMembershipId: me,
      email: 'filial@empresa.ao',
      municipality: 'Viana',
    })
    ok.assertStatus(201)
    assert.equal(ok.body().data.managerMembershipId, me)
  })

  test('não se inactiva com dependências activas; organograma com responsável', async ({
    client,
    assert,
  }) => {
    const { s, me } = await admin(client)
    const le = await legalEntity(client, s)
    const dep = (
      await as(client, s).post(`${ORG}/departments`, {
        code: 'D1',
        name: 'Direcção',
        legalEntityId: le.id,
        managerMembershipId: me,
      })
    ).body().data
    const child = (
      await as(client, s).post(`${ORG}/departments`, {
        code: 'D2',
        name: 'Contabilidade',
        legalEntityId: le.id,
        parentId: dep.id,
      })
    ).body().data
    await as(client, s).post(`${ORG}/positions`, {
      code: 'P1',
      name: 'Contabilista',
      departmentId: child.id,
      jobFamily: 'Finanças',
      jobFunction: 'Registo contabilístico',
      requirements: 'Licenciatura',
      responsibilities: 'Lançamentos',
    })

    const deps = (await as(client, s).get(`${ORG}/departments/${dep.id}/dependents`)).body().data
    assert.deepInclude(deps, { label: 'Subdepartamentos activos', count: 1 })

    const blocked = await as(client, s).patch(`${ORG}/legal-entities/${le.id}`, {
      expectedVersion: 1,
      status: 'INACTIVE',
    })
    blocked.assertStatus(409)
    assert.equal(blocked.body().error.code, 'HAS_ACTIVE_DEPENDENTS')
    assert.include(
      blocked
        .body()
        .error.details.map((d: any) => d.message)
        .join(),
      'Departamentos activos: 2'
    )
    const blockedChild = await as(client, s).patch(`${ORG}/departments/${child.id}`, {
      expectedVersion: 1,
      status: 'INACTIVE',
    })
    assert.equal(blockedChild.body().error.details[0].message, 'Cargos activos: 1')

    const tree = (await as(client, s).get(`${ORG}/departments/tree`)).body().data
    assert.lengthOf(tree, 2)
    assert.deepInclude(
      tree.find((n: any) => n.code === 'D2'),
      { parentId: dep.id }
    )
    assert.isString(tree.find((n: any) => n.code === 'D1').managerName)
    ;(await as(client, s).get(`${ORG}/positions/tree`)).assertStatus(404)
  })
})

test.group('administração | perfil e configurações', (group) => {
  group.each.setup(() => cleanDatabase())

  test('perfil: valores por omissão, gravação com versão, idioma e fuso, logótipo só imagem do perfil', async ({
    client,
    assert,
  }) => {
    const { s, tenantId } = await admin(client)
    const initial = (await as(client, s).get('/api/v1/company/profile')).body().data
    assert.equal(initial.version, 0)
    assert.equal(initial.displayName, initial.tenant.name)
    const saved = await as(client, s).put('/api/v1/company/profile', {
      expectedVersion: 0,
      displayName: 'Acme Angola',
      legalNameRef: 'Acme Angola, Lda.',
      taxIdRef: '5417000000',
      sector: 'Comércio',
      email: 'geral@acme.ao',
      province: 'Luanda',
      locale: 'pt-AO',
      timezone: 'Africa/Luanda',
    })
    saved.assertStatus(200)
    assert.deepInclude(saved.body().data, {
      version: 1,
      displayName: 'Acme Angola',
      sector: 'Comércio',
    })
    assert.deepInclude(saved.body().data.tenant, { locale: 'pt-AO', timezone: 'Africa/Luanda' })
    ;(
      await as(client, s).put('/api/v1/company/profile', { expectedVersion: 0, sector: 'x' })
    ).assertStatus(409)
    ;(
      await as(client, s).put('/api/v1/company/profile', {
        expectedVersion: 1,
        timezone: 'Lua/Nada',
      })
    ).assertStatus(422)
    ;(
      await as(client, s).put('/api/v1/company/profile', { expectedVersion: 1, displayName: '' })
    ).assertStatus(422)

    const pdf = await client
      .post('/api/v1/attachments')
      .header('cookie', s.cookie)
      .header('x-xsrf-token', s.xsrf)
      .header('x-tenant-id', s.tenantId)
      .field('subjectType', 'tenant_profile')
      .field('subjectId', tenantId)
      .file('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'estatutos.pdf' })
    pdf.assertStatus(201)
    const notImage = await as(client, s).put('/api/v1/company/profile', {
      expectedVersion: 1,
      logoAttachmentId: pdf.body().data.id,
    })
    assert.equal(notImage.body().error.details[0].code, 'NOT_AN_IMAGE')

    const reader = await memberWithRoles(client, s, [
      (await createRole(client, s, 'leitura_cfg', ['settings.read'])).id,
    ])
    ;(await as(client, reader.session).get('/api/v1/company/profile')).assertStatus(200)
    ;(
      await as(client, reader.session).put('/api/v1/company/profile', { expectedVersion: 1 })
    ).assertStatus(403)
    const events = (
      await as(client, s).get('/api/v1/audit-events?action=company_profile.updated')
    ).body().data
    assert.lengthOf(events, 1)
  })

  test('configurações: limites, validade dos convites e notificações desligáveis', async ({
    client,
    assert,
  }) => {
    const { s } = await admin(client)
    const defaults = (await as(client, s).get('/api/v1/settings')).body().data
    assert.deepInclude(defaults, { amountScale: 2, invitationTtlDays: 7, version: 0 })
    const bad = await as(client, s).put('/api/v1/settings', {
      expectedVersion: 0,
      amountScale: 9,
      roundingMode: 'UP',
      invitationTtlDays: 0,
    })
    assert.sameMembers(
      bad.body().error.details.map((d: any) => d.path),
      ['amountScale', 'roundingMode', 'invitationTtlDays']
    )
    const saved = await as(client, s).put('/api/v1/settings', {
      expectedVersion: 0,
      invitationTtlDays: 2,
      roundingMode: 'HALF_EVEN',
      notifyApprovalPending: false,
    })
    saved.assertStatus(200)

    await as(client, s).post('/api/v1/members/invitations', { email: 'ttl@teste.invalid' })
    const token = await owner().rawQuery(
      `select extract(epoch from (expires_at - created_at))::int as secs from one_time_tokens where purpose = 'INVITATION' order by created_at desc limit 1`
    )
    assert.closeTo(token.rows[0].secs, 2 * 86400, 60)

    // Aprovação pendente sem notificação (desligada); a tarefa continua a existir.
    const role = await createRole(client, s, 'pede', ['approvals.request'])
    const requester = await memberWithRoles(client, s, [role.id])
    const approver = await memberWithRoles(client, s, [])
    const wfRes = await as(client, s).post('/api/v1/approvals/workflows', {
      code: 'WF',
      name: 'Workflow',
      subjectType: 'manual',
      steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: approver.memberId }],
    })
    wfRes.assertStatus(201)
    const wf = wfRes.body().data
    await as(client, s).post(`/api/v1/approvals/workflows/${wf.id}/publish`, {
      expectedVersion: wf.version,
    })
    await as(client, requester.session).post('/api/v1/approvals/requests', {
      workflowId: wf.id,
      title: 'Sem aviso',
    })
    assert.equal(
      (await as(client, approver.session).get('/api/v1/me/notifications')).body().meta.total,
      0
    )
    assert.lengthOf((await as(client, approver.session).get('/api/v1/me/tasks')).body().data, 1)
  })
})

test.group('administração | câmbios, séries e calendários', (group) => {
  group.each.setup(() => cleanDatabase())

  test('câmbios: taxa em texto decimal, um por par e data, consulta do mais recente', async ({
    client,
    assert,
  }) => {
    const { s } = await admin(client)
    const a = await as(client, s).post('/api/v1/exchange-rates', {
      fromCurrency: 'usd',
      toCurrency: 'AOA',
      rate: '912.5',
      validOn: '2026-01-02',
    })
    a.assertStatus(201)
    assert.equal(a.body().data.rate, '912.5000000000')
    ;(
      await as(client, s).post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '0.000123456789',
        validOn: '2026-02-01',
      })
    ).assertStatus(422)
    ;(
      await as(client, s).post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '0.0001234568',
        validOn: '2026-02-01',
      })
    ).assertStatus(201)
    ;(
      await as(client, s).post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '1',
        validOn: '2026-01-02',
      })
    ).assertStatus(409)
    const bad = await as(client, s).post('/api/v1/exchange-rates', {
      fromCurrency: 'AOA',
      toCurrency: 'AOA',
      rate: '-1',
      validOn: 'ontem',
    })
    assert.includeMembers(
      bad.body().error.details.map((d: any) => d.path),
      ['rate', 'validOn', 'toCurrency']
    )
    const jan = (
      await as(client, s).get('/api/v1/exchange-rates/lookup?from=USD&to=AOA&date=2026-01-31')
    ).body().data
    assert.deepInclude(jan, { rate: '912.5000000000', validOn: '2026-01-02' })
    const feb = (
      await as(client, s).get('/api/v1/exchange-rates/lookup?from=USD&to=AOA&date=2026-03-01')
    ).body().data
    assert.equal(feb.rate, '0.0001234568')
    ;(
      await as(client, s).get('/api/v1/exchange-rates/lookup?from=USD&to=AOA&date=2025-12-31')
    ).assertStatus(404)
    const imm = await as(client, s).patch(`/api/v1/exchange-rates/${a.body().data.id}`, {
      expectedVersion: 1,
      validOn: '2026-01-03',
    })
    assert.equal(imm.body().error.details[0].code, 'IMMUTABLE')
  })

  test('séries: numeração sequencial sem saltos nem repetições em concorrência; não recua; fechada recusa', async ({
    client,
    assert,
  }) => {
    const { s, tenantId, me } = await admin(client)
    const le = await legalEntity(client, s)
    const created = await as(client, s).post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'invoice',
      code: 'FT2026',
      prefix: 'FT2026/',
      padding: 4,
      fiscalYear: 2026,
    })
    created.assertStatus(201)
    const series = created.body().data
    assert.deepInclude(series, { documentType: 'INVOICE', nextFormatted: 'FT2026/0001' })
    ;(
      await as(client, s).post('/api/v1/document-series', {
        legalEntityId: le.id,
        documentType: 'INVOICE',
        code: 'FT2026',
      })
    ).assertStatus(409)

    const users = await owner().rawQuery('select user_id from tenant_memberships where id = ?', [
      me,
    ])
    const context = {
      tenantId,
      userId: users.rows[0].user_id,
      membershipId: me,
      requestId: 'teste',
    }
    const numbers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runInTenant({ ...context, requestId: `r${i}` }, (scope) =>
          reserveDocumentNumber(scope, series.id, '2026-05-01')
        )
      )
    )
    assert.sameMembers(
      numbers.map((n) => n.number),
      Array.from({ length: 12 }, (_, i) => i + 1)
    )
    assert.include(
      numbers.map((n) => n.formatted),
      'FT2026/0012'
    )
    // Uma emissão que falha desfaz a reserva.
    await runInTenant(context, async (scope) => {
      await reserveDocumentNumber(scope, series.id, '2026-05-01')
      throw new Error('emissão falhou')
    }).catch(() => undefined)
    assert.equal(
      (await as(client, s).get(`/api/v1/document-series/${series.id}/preview`)).body().data.next,
      'FT2026/0013'
    )

    const current = (await as(client, s).get(`/api/v1/document-series/${series.id}`)).body().data
    const back = await as(client, s).patch(`/api/v1/document-series/${series.id}`, {
      expectedVersion: current.version,
      nextNumber: 5,
    })
    assert.equal(back.body().error.details[0].code, 'NO_GOING_BACK')
    await as(client, s).patch(`/api/v1/document-series/${series.id}`, {
      expectedVersion: current.version,
      status: 'CLOSED',
    })
    await assert.rejects(() =>
      runInTenant(context, (scope) => reserveDocumentNumber(scope, series.id, '2026-05-01'))
    )
  })

  test('calendários: feriados únicos por dia e dias úteis sem fins-de-semana nem feriados', async ({
    client,
    assert,
  }) => {
    const { s } = await admin(client)
    const cal = await as(client, s).post('/api/v1/calendars', {
      code: 'AO-LDA',
      name: 'Luanda',
      countryCode: 'ao',
      province: 'Luanda',
    })
    cal.assertStatus(201)
    const id = cal.body().data.id
    assert.deepEqual(cal.body().data.weekendDays, [6, 7])
    // 2026-02-02 (segunda) a 2026-02-08 (domingo): 5 dias úteis; com um feriado na quarta, 4.
    const before = (
      await as(client, s).get(`/api/v1/calendars/${id}/working-days?from=2026-02-02&to=2026-02-08`)
    ).body().data
    assert.equal(before.workingDays, 5)
    ;(
      await as(client, s).post(`/api/v1/calendars/${id}/holidays`, {
        date: '2026-02-04',
        name: 'Feriado de teste',
        kind: 'COMPANY',
      })
    ).assertStatus(201)
    ;(
      await as(client, s).post(`/api/v1/calendars/${id}/holidays`, {
        date: '2026-02-04',
        name: 'Outro',
      })
    ).assertStatus(409)
    const after = (
      await as(client, s).get(`/api/v1/calendars/${id}/working-days?from=2026-02-02&to=2026-02-08`)
    ).body().data
    assert.equal(after.workingDays, 4)
    const detail = (await as(client, s).get(`/api/v1/calendars/${id}`)).body().data
    assert.lengthOf(detail.holidays, 1)
    ;(
      await as(client, s).delete(`/api/v1/calendars/${id}/holidays/${detail.holidays[0].id}`)
    ).assertStatus(200)
    ;(
      await as(client, s).get(`/api/v1/calendars/${id}/working-days?from=2026-02-08&to=2026-02-02`)
    ).assertStatus(422)
  })
})

test.group('administração | contas bancárias e aprovação', (group) => {
  group.each.setup(() => cleanDatabase())

  test('IBAN validado, dados bancários imutáveis, uma conta por omissão por moeda, lista mascarada', async ({
    client,
    assert,
  }) => {
    const { s } = await admin(client)
    const le = await legalEntity(client, s)
    const bad = await as(client, s).post('/api/v1/bank-accounts', {
      legalEntityId: le.id,
      holderName: 'Empresa',
      bankName: 'Banco',
      iban: 'AO06 0000 0000 0000 0000 0000 0',
      currency: 'AOA',
    })
    assert.equal(bad.body().error.details[0].code, 'INVALID_IBAN')
    const first = await as(client, s).post('/api/v1/bank-accounts', {
      legalEntityId: le.id,
      holderName: 'Empresa, Lda.',
      bankName: 'Banco Um',
      iban: iban('AO', '00400000123456789010 1'.replace(/\s/g, '')),
      swiftBic: 'BAIPAOLU',
      currency: 'AOA',
      isDefault: true,
    })
    first.assertStatus(201)
    assert.deepInclude(first.body().data, { status: 'ACTIVE', isDefault: true })
    const second = (
      await as(client, s).post('/api/v1/bank-accounts', {
        legalEntityId: le.id,
        holderName: 'Empresa, Lda.',
        bankName: 'Banco Dois',
        accountNumber: '1234-5678',
        currency: 'AOA',
      })
    ).body().data
    const swap = await as(client, s).patch(`/api/v1/bank-accounts/${second.id}`, {
      expectedVersion: second.version,
      isDefault: true,
    })
    swap.assertStatus(200)
    const list = (await as(client, s).get(`/api/v1/bank-accounts?legalEntityId=${le.id}`)).body()
      .data
    assert.deepEqual(
      list.filter((a: any) => a.isDefault).map((a: any) => a.id),
      [second.id]
    )
    assert.match(
      list.find((a: any) => a.id === first.body().data.id).ibanMasked,
      /^AO\d\d •••• \d{4}$/
    )
    const imm = await as(client, s).patch(`/api/v1/bank-accounts/${second.id}`, {
      expectedVersion: 2,
      accountNumber: '9999',
    })
    assert.equal(imm.body().error.details[0].code, 'IMMUTABLE')
    ;(
      await as(client, s).post('/api/v1/bank-accounts', {
        legalEntityId: le.id,
        holderName: 'Empresa',
        bankName: 'Banco',
        iban: first.body().data.iban,
        currency: 'USD',
      })
    ).assertStatus(409)
    const reader = await memberWithRoles(client, s, [
      (await createRole(client, s, 'cfg', ['settings.manage'])).id,
    ])
    ;(await as(client, reader.session).get('/api/v1/bank-accounts')).assertStatus(403)
  })

  test('com workflow configurado a conta fica pendente; aprovada activa, rejeitada não; sem aprovações contratadas recusa', async ({
    client,
    assert,
  }) => {
    const { s, userId: adminUserId } = await admin(client)
    const le = await legalEntity(client, s)
    const approver = await memberWithRoles(client, s, [])
    const wf = (
      await as(client, s).post('/api/v1/approvals/workflows', {
        code: 'BANCO',
        name: 'Contas bancárias',
        subjectType: 'bank_account',
        steps: [
          { name: 'Finanças', approverType: 'MEMBER', approverMembershipId: approver.memberId },
        ],
      })
    ).body().data
    ;(
      await as(client, s).put('/api/v1/settings', {
        expectedVersion: 0,
        bankAccountWorkflowId: wf.id,
      })
    ).assertStatus(422)
    await as(client, s).post(`/api/v1/approvals/workflows/${wf.id}/publish`, {
      expectedVersion: wf.version,
    })
    ;(
      await as(client, s).put('/api/v1/settings', {
        expectedVersion: 0,
        bankAccountWorkflowId: wf.id,
      })
    ).assertStatus(200)

    const account = (
      await as(client, s).post('/api/v1/bank-accounts', {
        legalEntityId: le.id,
        holderName: 'Empresa, Lda.',
        bankName: 'Banco Três',
        iban: iban('AO', '004000001234567890102'),
        currency: 'AOA',
        isDefault: true,
      })
    ).body().data
    assert.deepInclude(account, { status: 'PENDING_APPROVAL', isDefault: false })
    assert.isString(account.approvalRequestId)
    ;(
      await as(client, s).patch(`/api/v1/bank-accounts/${account.id}`, {
        expectedVersion: account.version,
        isDefault: true,
      })
    ).assertStatus(422)

    const decided = await as(client, approver.session).post(
      `/api/v1/approvals/requests/${account.approvalRequestId}/decisions`,
      { decision: 'APPROVE' }
    )
    decided.assertStatus(200)
    assert.equal(
      (await as(client, s).get(`/api/v1/bank-accounts/${account.id}`)).body().data.status,
      'ACTIVE'
    )

    const second = (
      await as(client, s).post('/api/v1/bank-accounts', {
        legalEntityId: le.id,
        holderName: 'Outro',
        bankName: 'Banco',
        accountNumber: '55555',
        currency: 'USD',
      })
    ).body().data
    await as(client, approver.session).post(
      `/api/v1/approvals/requests/${second.approvalRequestId}/decisions`,
      { decision: 'REJECT', comment: 'Titular errado' }
    )
    assert.equal(
      (await as(client, s).get(`/api/v1/bank-accounts/${second.id}`)).body().data.status,
      'REJECTED'
    )
    const events = (
      await as(client, s).get(`/api/v1/audit-events?entityType=bank_account&entityId=${account.id}`)
    ).body().data
    assert.includeMembers(
      events.map((e: any) => e.action),
      ['bank_account.created', 'bank_account.approved']
    )

    // Plano sem aprovações: não se contorna o controlo.
    const { PlatformSubscriptionService } = await import('#modules/subscription/index')
    const plans = new PlatformSubscriptionService()
    const tenant = await owner().rawQuery(`select tenant_id from tenant_settings limit 1`)
    const sub = (await plans.tenantSubscription(tenant.rows[0].tenant_id)).subscription!
    const plan = await plans.createPlan({
      code: 'SEM_APROV',
      name: 'Sem aprovações',
      features: [{ featureCode: 'organization' }, { featureCode: 'legal_entities.max' }],
    })
    await plans.setPlanStatus(plan.id, 'ACTIVE')
    await plans.transition(
      sub.id,
      'CHANGE_PLAN',
      { expectedVersion: sub.version, planId: plan.id },
      adminUserId
    )
    const refused = await as(client, s).post('/api/v1/bank-accounts', {
      legalEntityId: le.id,
      holderName: 'Titular X',
      bankName: 'Banco Y',
      accountNumber: '777777',
      currency: 'EUR',
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'APPROVAL_UNAVAILABLE')
    void subscribe
  })
})

test.group('administração | convites', (group) => {
  group.each.setup(() => cleanDatabase())

  test('reenviar invalida a ligação anterior; revogar impede aceitar; validade visível', async ({
    client,
    assert,
  }) => {
    const { s } = await admin(client)
    const invited = (
      await as(client, s).post('/api/v1/members/invitations', { email: 'reenvio@teste.invalid' })
    ).body().data.member
    assert.isString(invited.invitationExpiresAt)
    const first = await lastTokenFor('reenvio@teste.invalid', 'INVITATION')
    ;(await as(client, s).post(`/api/v1/members/${invited.id}/invitation/resend`)).assertStatus(200)
    const second = await lastTokenFor('reenvio@teste.invalid', 'INVITATION')
    assert.notEqual(first, second)
    ;(
      await client
        .post('/api/v1/auth/invitations/accept')
        .json({ token: first, password: PASSWORD })
    ).assertStatus(400)

    const revoked = await as(client, s).delete(`/api/v1/members/${invited.id}/invitation`)
    revoked.assertStatus(200)
    assert.equal(revoked.body().data.status, 'REVOKED')
    ;(
      await client
        .post('/api/v1/auth/invitations/accept')
        .json({ token: second, password: PASSWORD })
    ).assertStatus(400)
    ;(await as(client, s).post(`/api/v1/members/${invited.id}/invitation/resend`)).assertStatus(409)
  })
})
