import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const MODULES = ['customers', 'prospecting']

const owner = <T>(sql: string, tenant: Tenant) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

/** Tenant com clientes e prospecção: uma organização e um administrador. */
async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, MODULES)
  for (const code of MODULES) {
    const enabled = await http.post(`/api/v1/tenant/modules/${code}/enable`, {})
    if (enabled.status() !== 200) throw new Error(`${code}: ${JSON.stringify(enabled.body())}`)
  }
  const org = await must<any>(
    await http.post('/api/v1/organizations', {
      code: 'EMP',
      legalName: 'Empresa, Lda.',
      countryCode: 'AO',
      baseCurrency: 'AOA',
    }),
    201
  )
  return { client, tenant, admin, http, org }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function memberWith(ctx: { client: any; tenant: Tenant; http: Http }, permissions: string[]) {
  const actor = await newActor(ctx.client, ctx.tenant)
  const role = await must<{ id: string }>(
    await ctx.http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await ctx.http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return api(ctx.client, ctx.tenant, actor)
}

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

let counter = 0
const uid = () => `${Date.now().toString(36)}${counter++}`

const newLead = async (ctx: Ctx, extra: Record<string, unknown> = {}) =>
  must<any>(
    await ctx.http.post('/api/v1/leads', {
      name: 'Maria Silva',
      source: 'web',
      email: `maria.${uid()}@exemplo.invalid`,
      ...extra,
    }),
    201
  )

const count = async (ctx: Ctx, table: string) =>
  (await owner<{ n: number }>(`select count(*)::int as n from ${table}`, ctx.tenant))[0]!.n

const stagesOf = async (ctx: Ctx) => must<any[]>(await ctx.http.get('/api/v1/pipeline-stages'), 200)

const hooks = (group: any) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })
}

test.group('prospecção | leads', (group) => {
  hooks(group)

  test('cria, valida, altera e qualifica; repetir não faz nada', async ({ client, assert }) => {
    const ctx = await setup(client)
    const lead = await newLead(ctx, { phone: '+244 923 000 000', companyName: 'Acme, Lda.' })
    assert.equal(lead.status, 'NEW')
    assert.equal(lead.consentStatus, 'UNKNOWN')
    assert.equal(lead.ownerMembershipId, ctx.admin.membershipId)
    const bad = await ctx.http.post('/api/v1/leads', {
      name: 'X',
      source: 'web',
      email: 'sem-arroba',
    })
    assert.equal(bad.status(), 422)
    assert.equal(code(bad), 'INVALID_EMAIL')
    assert.equal(
      code(
        await ctx.http.post('/api/v1/leads', { name: 'X', source: 'web', consentStatus: 'TALVEZ' })
      ),
      'INVALID'
    )
    const updated = await must<any>(
      await ctx.http.patch(`/api/v1/leads/${lead.id}`, {
        expectedVersion: lead.version,
        name: 'Maria Silva Costa',
      }),
      200
    )
    assert.equal(updated.name, 'Maria Silva Costa')
    assert.equal(
      (
        await ctx.http.patch(`/api/v1/leads/${lead.id}`, {
          expectedVersion: lead.version,
          name: 'x',
        })
      ).status(),
      409
    )
    const q1 = await must<any>(await ctx.http.post(`/api/v1/leads/${lead.id}/qualify`, {}), 200)
    const q2 = await must<any>(await ctx.http.post(`/api/v1/leads/${lead.id}/qualify`, {}), 200)
    assert.equal(q1.status, 'QUALIFIED')
    assert.equal(q2.version, q1.version)
    assert.equal(
      (await ctx.http.post(`/api/v1/leads/${lead.id}/disqualify`, { reason: ' ' })).status(),
      422
    )
    const dq = await must<any>(
      await ctx.http.post(`/api/v1/leads/${lead.id}/disqualify`, { reason: 'Sem orçamento' }),
      200
    )
    assert.equal(dq.status, 'DISQUALIFIED')
    assert.equal(dq.disqualifyReason, 'Sem orçamento')
    const list = await must<any[]>(
      await ctx.http.get('/api/v1/leads?status=DISQUALIFIED&q=silva'),
      200
    )
    assert.lengthOf(list, 1)
  })

  test('a conversão cria Party, cliente e oportunidade; repetir devolve os mesmos identificadores', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const lead = await newLead(ctx, { companyName: 'Acme, Lda.', phone: '+244923000000' })
    const body = {
      organizationId: ctx.org.id,
      opportunity: { name: 'Venda Acme', expectedValue: '1500.5' },
    }
    const first = await ctx.http.post(`/api/v1/leads/${lead.id}/convert`, body)
    assert.equal(first.status(), 201)
    const done = first.body().data
    assert.isFalse(done.alreadyConverted)
    assert.equal(done.lead.status, 'CONVERTED')
    const parties = await count(ctx, 'parties')
    const customers = await count(ctx, 'customers')
    const opportunities = await count(ctx, 'opportunities')

    const again = await ctx.http.post(`/api/v1/leads/${lead.id}/convert`, body)
    assert.equal(again.status(), 200)
    assert.isTrue(again.body().data.alreadyConverted)
    for (const key of ['partyId', 'customerId', 'opportunityId']) {
      assert.equal(again.body().data[key], done[key], key)
    }
    assert.equal(await count(ctx, 'parties'), parties)
    assert.equal(await count(ctx, 'customers'), customers)
    assert.equal(await count(ctx, 'opportunities'), opportunities)

    const opportunity = await must<any>(
      await ctx.http.get(`/api/v1/opportunities/${done.opportunityId}`),
      200
    )
    assert.equal(opportunity.name, 'Venda Acme')
    assert.equal(opportunity.expectedValue, '1500.5000')
    assert.equal(opportunity.currency, 'AOA')
    assert.equal(opportunity.customerId, done.customerId)
    assert.equal(opportunity.stageCode, 'NEW')
    assert.lengthOf(opportunity.history, 1)
    const party = await must<any>(await ctx.http.get(`/api/v1/parties/${done.partyId}`), 200)
    assert.equal(party.displayName, 'Acme, Lda.')
    assert.isTrue(party.contacts.some((c: any) => c.type === 'EMAIL'))
    // A lead convertida é imutável na identidade, mas o consentimento ainda se altera.
    const optOut = await must<any>(
      await ctx.http.patch(`/api/v1/leads/${lead.id}`, {
        expectedVersion: done.lead.version,
        consentStatus: 'OPT_OUT',
      }),
      200
    )
    assert.equal(optOut.consentStatus, 'OPT_OUT')
    assert.equal(optOut.customerId, done.customerId)
    assert.equal(
      (await ctx.http.post(`/api/v1/leads/${lead.id}/disqualify`, { reason: 'x' })).status(),
      409
    )
  })

  test('conversões concorrentes da mesma lead criam uma só Party, um só cliente e uma só oportunidade', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const lead = await newLead(ctx, { companyName: 'Paralela, SA' })
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.http.post(`/api/v1/leads/${lead.id}/convert`, { organizationId: ctx.org.id })
      )
    )
    assert.sameMembers(results.map((r) => r.status()).sort(), [200, 200, 201])
    const ids = new Set(results.map((r) => r.body().data.opportunityId))
    assert.equal(ids.size, 1)
    assert.equal(await count(ctx, 'customers'), 1)
    assert.equal(await count(ctx, 'opportunities'), 1)
    assert.equal(await count(ctx, 'parties'), 1)
  })

  test('uma falha a meio reverte tudo: nem Party nem cliente ficam a meio', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const taken = await newLead(ctx, { companyName: 'Primeira, Lda.' })
    await must(
      await ctx.http.post(`/api/v1/leads/${taken.id}/convert`, {
        organizationId: ctx.org.id,
        customerCode: 'CLI-1',
      }),
      201
    )
    const parties = await count(ctx, 'parties')
    const customers = await count(ctx, 'customers')
    const second = await newLead(ctx, { companyName: 'Segunda, Lda.' })
    const clash = await ctx.http.post(`/api/v1/leads/${second.id}/convert`, {
      organizationId: ctx.org.id,
      customerCode: 'CLI-1',
    })
    assert.equal(clash.status(), 409)
    // A Party da segunda lead chegou a ser criada dentro da transacção, mas reverteu com o erro do cliente.
    assert.equal(await count(ctx, 'parties'), parties)
    assert.equal(await count(ctx, 'customers'), customers)
    const stillNew = await must<any>(await ctx.http.get(`/api/v1/leads/${second.id}`), 200)
    assert.equal(stillNew.status, 'NEW')
    assert.isNull(stillNew.partyId)
    // Com outro código, a mesma lead converte-se.
    await must(
      await ctx.http.post(`/api/v1/leads/${second.id}/convert`, {
        organizationId: ctx.org.id,
        customerCode: 'CLI-2',
      }),
      201
    )
  })

  test('resolve a Party: a indicada, a que tem o mesmo email ou uma pessoa nova; reutiliza o cliente existente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    // Pessoa nova a partir do nome e do apelido.
    const person = await newLead(ctx, { name: 'João Pedro Santos' })
    const personDone = await must<any>(
      await ctx.http.post(`/api/v1/leads/${person.id}/convert`, { organizationId: ctx.org.id }),
      201
    )
    const personParty = await must<any>(
      await ctx.http.get(`/api/v1/parties/${personDone.partyId}`),
      200
    )
    assert.equal(personParty.person.givenNames, 'João Pedro')
    assert.equal(personParty.person.familyName, 'Santos')

    // Mesmo email → reutiliza a Party e o cliente já existentes.
    const email = personParty.contacts[0].value as string
    const same = await newLead(ctx, { name: 'João Santos', email })
    const sameDone = await must<any>(
      await ctx.http.post(`/api/v1/leads/${same.id}/convert`, { organizationId: ctx.org.id }),
      201
    )
    assert.equal(sameDone.partyId, personDone.partyId)
    assert.equal(sameDone.customerId, personDone.customerId)
    assert.notEqual(sameDone.opportunityId, personDone.opportunityId)
    assert.equal(await count(ctx, 'customers'), 1)

    // Party indicada à mão.
    const org = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', { legalName: 'Existente, SA' }),
      201
    )
    const manual = await newLead(ctx, { companyName: 'Outro nome' })
    const manualDone = await must<any>(
      await ctx.http.post(`/api/v1/leads/${manual.id}/convert`, {
        organizationId: ctx.org.id,
        partyId: org.id,
      }),
      201
    )
    assert.equal(manualDone.partyId, org.id)
    assert.equal(
      (
        await ctx.http.post(`/api/v1/leads/${(await newLead(ctx)).id}/convert`, {
          organizationId: ctx.org.id,
          partyId: '00000000-0000-4000-8000-000000000000',
        })
      ).status(),
      422
    )
  })

  test('recusa converter sem apelido, desqualificada ou sem as permissões de criar Party e cliente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const single = await newLead(ctx, { name: 'Madonna' })
    const parties = await count(ctx, 'parties')
    const r = await ctx.http.post(`/api/v1/leads/${single.id}/convert`, {
      organizationId: ctx.org.id,
    })
    assert.equal(r.status(), 422)
    assert.equal(code(r), 'PARTY_NAME_INCOMPLETE')
    assert.equal(await count(ctx, 'parties'), parties)

    const dq = await newLead(ctx, { companyName: 'Desq, Lda.' })
    await must(await ctx.http.post(`/api/v1/leads/${dq.id}/disqualify`, { reason: 'x' }), 200)
    const blocked = await ctx.http.post(`/api/v1/leads/${dq.id}/convert`, {
      organizationId: ctx.org.id,
    })
    assert.equal(blocked.status(), 409)
    assert.equal(code(blocked), 'LEAD_DISQUALIFIED')

    const ok = await newLead(ctx, { companyName: 'Boa, Lda.' })
    const onlyCrm = await memberWith(ctx, ['crm.read', 'crm.manage'])
    const denied = await onlyCrm.post(`/api/v1/leads/${ok.id}/convert`, {
      organizationId: ctx.org.id,
    })
    assert.equal(denied.status(), 403)
    assert.equal((await must<any>(await ctx.http.get(`/api/v1/leads/${ok.id}`), 200)).status, 'NEW')
    const full = await memberWith(ctx, [
      'crm.read',
      'crm.manage',
      'customer.create',
      'party.create',
      'party.read',
      'customer.read',
    ])
    assert.equal(
      (await full.post(`/api/v1/leads/${ok.id}/convert`, { organizationId: ctx.org.id })).status(),
      201
    )
  })
})

test.group('prospecção | pipeline e oportunidades', (group) => {
  hooks(group)

  /** Uma oportunidade aberta de uma lead convertida. */
  async function opportunity(ctx: Ctx, name = 'Negócio') {
    const lead = await newLead(ctx, { companyName: `${name}, Lda.` })
    const done = await must<any>(
      await ctx.http.post(`/api/v1/leads/${lead.id}/convert`, {
        organizationId: ctx.org.id,
        opportunity: { name, expectedValue: '200' },
      }),
      201
    )
    return { id: done.opportunityId as string, customerId: done.customerId as string }
  }
  const stageByCode = (stages: any[], codeOf: string) => stages.find((s) => s.code === codeOf)

  test('um tenant novo recebe as etapas por omissão e o pipeline pode ser configurado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const stages = await stagesOf(ctx)
    assert.deepEqual(
      stages.map((s) => s.code),
      ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']
    )
    assert.equal((await stagesOf(ctx)).length, 6)
    const won = stageByCode(stages, 'WON')
    assert.equal(won.outcome, 'WON')
    assert.isTrue(won.terminal)
    const updated = await must<any>(
      await ctx.http.patch(`/api/v1/pipeline-stages/${won.id}`, {
        expectedVersion: won.version,
        requiresEvidence: true,
      }),
      200
    )
    assert.isTrue(updated.requiresEvidence)
    const custom = await must<any>(
      await ctx.http.post('/api/v1/pipeline-stages', {
        code: 'DEMO',
        name: 'Demonstração',
        position: 3,
        probability: '0.4',
      }),
      201
    )
    assert.equal(custom.probability, '0.4000')
    assert.equal(
      (
        await ctx.http.post('/api/v1/pipeline-stages', {
          code: 'DEMO',
          name: 'x',
          position: 3,
          probability: '0.4',
        })
      ).status(),
      409
    )
    assert.equal(
      code(
        await ctx.http.post('/api/v1/pipeline-stages', {
          code: 'BAD',
          name: 'x',
          position: 3,
          probability: '1.5',
        })
      ),
      'INVALID_PROBABILITY'
    )
    assert.equal(
      code(
        await ctx.http.patch(`/api/v1/pipeline-stages/${custom.id}`, {
          expectedVersion: custom.version,
          outcome: 'WON',
        })
      ),
      'IMMUTABLE'
    )
    assert.equal(
      code(
        await ctx.http.post('/api/v1/pipeline-stages', {
          code: 'EVI',
          name: 'x',
          position: 4,
          probability: '0.5',
          requiresEvidence: true,
        })
      ),
      'ONLY_WON'
    )
    // Uma etapa de ganho não se desactiva; uma com oportunidades também não.
    assert.equal(
      (
        await ctx.http.patch(`/api/v1/pipeline-stages/${updated.id}`, {
          expectedVersion: updated.version,
          active: false,
        })
      ).status(),
      409
    )
    const op = await opportunity(ctx)
    const first = stageByCode(await stagesOf(ctx), 'NEW')
    const inUse = await ctx.http.patch(`/api/v1/pipeline-stages/${first.id}`, {
      expectedVersion: first.version,
      active: false,
    })
    assert.equal(inUse.status(), 409)
    assert.equal(inUse.body().error.code, 'STAGE_IN_USE')
    assert.isString(op.id)
  })

  test('mover regista a transição, exige motivo na perda e evidência no ganho e não reabre', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const stages = await stagesOf(ctx)
    const won = stageByCode(stages, 'WON')
    await must(
      await ctx.http.patch(`/api/v1/pipeline-stages/${won.id}`, {
        expectedVersion: won.version,
        requiresEvidence: true,
      }),
      200
    )
    const op = await opportunity(ctx)
    const move = (stageId: string, extra: Record<string, unknown> = {}) =>
      ctx.http.post(`/api/v1/opportunities/${op.id}/move`, { stageId, ...extra })

    const proposal = await must<any>(await move(stageByCode(stages, 'PROPOSAL').id), 200)
    assert.equal(proposal.stageCode, 'PROPOSAL')
    assert.equal(proposal.probability, '0.5000')
    const repeated = await must<any>(await move(stageByCode(stages, 'PROPOSAL').id), 200)
    assert.equal(repeated.version, proposal.version)

    const noEvidence = await move(won.id)
    assert.equal(noEvidence.status(), 422)
    assert.equal(code(noEvidence), 'EVIDENCE_REQUIRED')
    const lostNoReason = await move(stageByCode(stages, 'LOST').id)
    assert.equal(lostNoReason.status(), 422)
    assert.equal(code(lostNoReason), 'LOSS_REASON_REQUIRED')
    assert.equal(
      (await move(stageByCode(stages, 'NEGOTIATION').id, { expectedVersion: 99 })).status(),
      409
    )

    const closed = await must<any>(
      await move(won.id, { winEvidence: 'Proposta aceite por email' }),
      200
    )
    assert.equal(closed.outcome, 'WON')
    assert.isNotNull(closed.closedAt)
    assert.equal(closed.winEvidence, 'Proposta aceite por email')
    const reopen = await move(stageByCode(stages, 'NEW').id)
    assert.equal(reopen.status(), 409)
    assert.equal(reopen.body().error.code, 'OPPORTUNITY_CLOSED')
    assert.equal(
      (
        await ctx.http.patch(`/api/v1/opportunities/${op.id}`, {
          expectedVersion: closed.version,
          name: 'x',
        })
      ).status(),
      409
    )

    const history = await must<any[]>(
      await ctx.http.get(`/api/v1/opportunities/${op.id}/history`),
      200
    )
    assert.deepEqual(
      history.map((h) => h.toStageId),
      [stageByCode(stages, 'NEW').id, stageByCode(stages, 'PROPOSAL').id, won.id]
    )
    assert.isNull(history[0].fromStageId)
    // Ganhar não cria nenhum recebimento nem factura.
    assert.equal((await count(ctx, 'outbox_events')) > 0, true)
  })

  test('perder grava o motivo; o histórico é só de acrescentar também por SQL', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const stages = await stagesOf(ctx)
    const op = await opportunity(ctx)
    const lost = await must<any>(
      await ctx.http.post(`/api/v1/opportunities/${op.id}/move`, {
        stageId: stageByCode(stages, 'LOST').id,
        lossReason: 'Escolheu a concorrência',
      }),
      200
    )
    assert.equal(lost.outcome, 'LOST')
    assert.equal(lost.lossReason, 'Escolheu a concorrência')
    for (const sql of [
      `update opportunity_stage_history set moved_at = now()`,
      `delete from opportunity_stage_history`,
    ]) {
      let message = ''
      try {
        await owner(sql, ctx.tenant)
      } catch (error) {
        message = (error as Error).message
      }
      assert.match(message, /CRM_APPEND_ONLY/)
    }
  })

  test('mover exige crm.manage; ler só exige crm.read', async ({ client, assert }) => {
    const ctx = await setup(client)
    const stages = await stagesOf(ctx)
    const op = await opportunity(ctx)
    const reader = await memberWith(ctx, ['crm.read'])
    const outsider = await memberWith(ctx, ['customer.read'])
    assert.equal((await reader.get(`/api/v1/opportunities/${op.id}`)).status(), 200)
    assert.equal((await outsider.get(`/api/v1/opportunities/${op.id}`)).status(), 403)
    const denied = await reader.post(`/api/v1/opportunities/${op.id}/move`, {
      stageId: stageByCode(stages, 'PROPOSAL').id,
    })
    assert.equal(denied.status(), 403)
    const still = await must<any>(await ctx.http.get(`/api/v1/opportunities/${op.id}`), 200)
    assert.equal(still.stageCode, 'NEW')
    assert.equal(still.history.length, 1)
  })

  test('as métricas usam as datas das transições, não só o estado actual', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const stages = await stagesOf(ctx)
    const a = await opportunity(ctx, 'A')
    const b = await opportunity(ctx, 'B')
    await opportunity(ctx, 'C')
    const to = async (id: string, stage: string, extra: Record<string, unknown> = {}) =>
      must<any>(
        await ctx.http.post(`/api/v1/opportunities/${id}/move`, {
          stageId: stageByCode(stages, stage).id,
          ...extra,
        }),
        200
      )
    await to(a.id, 'PROPOSAL')
    await to(a.id, 'WON')
    await to(b.id, 'LOST', { lossReason: 'Preço' })
    const metrics = await must<any>(await ctx.http.get('/api/v1/opportunities/metrics'), 200)
    const entered = Object.fromEntries(metrics.entered.map((e: any) => [e.code, e.count]))
    assert.equal(entered.NEW, 3)
    assert.equal(entered.PROPOSAL, 1)
    assert.equal(entered.WON, 1)
    assert.equal(entered.LOST, 1)
    assert.equal(metrics.won, 1)
    assert.equal(metrics.lost, 1)
    assert.equal(metrics.winRate, '0.5000')
    assert.deepEqual(metrics.wonValue, [{ currency: 'AOA', value: '200.0000' }])
    assert.deepEqual(metrics.openValue, [{ currency: 'AOA', value: '200.0000' }])
    assert.isNotNull(metrics.averageDaysToWin)
    // Fora do período não entra nada, apesar de o estado actual das oportunidades não mudar.
    const past = await must<any>(
      await ctx.http.get('/api/v1/opportunities/metrics?from=2020-01-01&to=2020-01-31'),
      200
    )
    assert.equal(past.won, 0)
    assert.isNull(past.winRate)
    assert.isTrue(past.entered.every((e: any) => e.count === 0))
    assert.equal(
      (await ctx.http.get('/api/v1/opportunities/metrics?from=2026-02-30')).status(),
      422
    )
    assert.equal(
      (await ctx.http.get('/api/v1/opportunities/metrics?from=2026-03-01&to=2026-02-01')).status(),
      422
    )
  })

  test('cria oportunidade de cliente e de lead, com actividades que se concluem uma só vez', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const base = await opportunity(ctx, 'Base')
    const direct = await must<any>(
      await ctx.http.post('/api/v1/opportunities', {
        name: 'Segunda venda',
        customerId: base.customerId,
        expectedValue: '75.25',
        expectedCloseDate: '2026-12-31',
      }),
      201
    )
    assert.equal(direct.stageCode, 'NEW')
    assert.equal(direct.expectedValue, '75.2500')
    assert.equal(direct.expectedCloseDate, '2026-12-31')
    const lead = await newLead(ctx)
    const fromLead = await must<any>(
      await ctx.http.post('/api/v1/opportunities', {
        name: 'Antes de converter',
        leadId: lead.id,
        organizationId: ctx.org.id,
      }),
      201
    )
    assert.equal(fromLead.leadName, 'Maria Silva')
    for (const body of [
      { name: 'x' },
      { name: 'x', customerId: '00000000-0000-4000-8000-000000000000' },
      { name: 'x', customerId: base.customerId, expectedValue: '1.00001' },
      { name: 'x', customerId: base.customerId, expectedCloseDate: '2026-13-01' },
    ]) {
      assert.equal((await ctx.http.post('/api/v1/opportunities', body)).status(), 422)
    }
    const activity = await must<any>(
      await ctx.http.post(`/api/v1/opportunities/${direct.id}/activities`, {
        kind: 'MEETING',
        subject: 'Reunião',
        dueAt: '2026-11-01T10:00:00Z',
      }),
      201
    )
    assert.equal(
      (
        await ctx.http.post(`/api/v1/opportunities/${direct.id}/activities`, {
          kind: 'FAX',
          subject: 'x',
        })
      ).status(),
      422
    )
    const done = await must<any>(
      await ctx.http.post(`/api/v1/opportunity-activities/${activity.id}/complete`, {}),
      200
    )
    const again = await must<any>(
      await ctx.http.post(`/api/v1/opportunity-activities/${activity.id}/complete`, {}),
      200
    )
    assert.isNotNull(done.doneAt)
    assert.equal(again.version, done.version)
    const detail = await must<any>(await ctx.http.get(`/api/v1/opportunities/${direct.id}`), 200)
    assert.lengthOf(detail.activities, 1)
    const filtered = await must<any[]>(
      await ctx.http.get(`/api/v1/opportunities?customerId=${base.customerId}&status=open`),
      200
    )
    assert.lengthOf(filtered, 2)
  })
})

test.group('prospecção | campanhas', (group) => {
  hooks(group)

  const START = '2026-01-01T00:00:00Z'

  async function campaign(ctx: Ctx, extra: Record<string, unknown> = {}) {
    const created = await must<any>(
      await ctx.http.post('/api/v1/campaigns', {
        name: 'Lançamento',
        channel: 'EMAIL',
        startsAt: START,
        budget: '500',
        subject: 'Novidades',
        message: 'Conheça a nossa nova gama.',
        ...extra,
      }),
      201
    )
    return created as { id: string; version: number }
  }
  const activate = (ctx: Ctx, id: string) =>
    ctx.http.post(`/api/v1/campaigns/${id}/status`, { status: 'ACTIVE' })

  test('gere o estado e valida os dados da campanha', async ({ client, assert }) => {
    const ctx = await setup(client)
    const c = await campaign(ctx)
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/campaigns/${c.id}`), 200)).status,
      'DRAFT'
    )
    assert.equal(
      code(
        await ctx.http.post('/api/v1/campaigns', { name: 'x', channel: 'FAX', startsAt: START })
      ),
      'INVALID'
    )
    assert.equal(
      code(
        await ctx.http.post('/api/v1/campaigns', {
          name: 'x',
          channel: 'EMAIL',
          startsAt: START,
          endsAt: '2025-01-01T00:00:00Z',
        })
      ),
      'BEFORE_START'
    )
    assert.equal(
      (await ctx.http.post(`/api/v1/campaigns/${c.id}/status`, { status: 'COMPLETED' })).status(),
      409
    )
    await must(await activate(ctx, c.id), 200)
    const repeated = await must<any>(await activate(ctx, c.id), 200)
    assert.equal(repeated.status, 'ACTIVE')
    await must(await ctx.http.post(`/api/v1/campaigns/${c.id}/status`, { status: 'PAUSED' }), 200)
    await must(
      await ctx.http.post(`/api/v1/campaigns/${c.id}/status`, { status: 'COMPLETED' }),
      200
    )
    assert.equal((await activate(ctx, c.id)).status(), 409)
    assert.equal(
      (
        await ctx.http.patch(`/api/v1/campaigns/${c.id}`, { expectedVersion: 99, name: 'y' })
      ).status(),
      409
    )
  })

  test('cada destinatário só uma vez; só se retira quem ainda não foi contactado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const c = await campaign(ctx)
    const lead = await newLead(ctx)
    const party = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', { legalName: 'Cliente, Lda.' }),
      201
    )
    const partyId = party.id
    const added = await must<any>(
      await ctx.http.post(`/api/v1/campaigns/${c.id}/members`, {
        leadIds: [lead.id],
        partyIds: [partyId],
      }),
      201
    )
    assert.deepEqual(added, { added: 2, duplicates: 0 })
    const again = await must<any>(
      await ctx.http.post(`/api/v1/campaigns/${c.id}/members`, { leadIds: [lead.id] }),
      201
    )
    assert.deepEqual(again, { added: 0, duplicates: 1 })
    assert.equal(
      (
        await ctx.http.post(`/api/v1/campaigns/${c.id}/members`, {
          leadIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).status(),
      422
    )
    const members = await must<any[]>(await ctx.http.get(`/api/v1/campaigns/${c.id}/members`), 200)
    assert.lengthOf(members, 2)
    const summary = await must<any>(await ctx.http.get(`/api/v1/campaigns/${c.id}`), 200)
    assert.equal(summary.summary.total, 2)
    assert.equal(summary.summary.targeted, 2)
    const target = members.find((m) => m.leadId)
    assert.equal(
      (await ctx.http.delete(`/api/v1/campaigns/${c.id}/members/${target.id}`)).status(),
      204
    )
    assert.lengthOf(
      await must<any[]>(await ctx.http.get(`/api/v1/campaigns/${c.id}/members`), 200),
      1
    )
  })

  test('o envio respeita o consentimento: quem recusou nunca é contactado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const c = await campaign(ctx)
    const optIn = await newLead(ctx, { name: 'Ana Aceita', consentStatus: 'OPT_IN' })
    const optOut = await newLead(ctx, { name: 'Rui Recusa', consentStatus: 'OPT_OUT' })
    const unknown = await newLead(ctx, { name: 'Ula Incerta' })
    const noEmail = await newLead(ctx, { name: 'Sem Email', email: null, consentStatus: 'OPT_IN' })
    await must(
      await ctx.http.post(`/api/v1/campaigns/${c.id}/members`, {
        leadIds: [optIn.id, optOut.id, unknown.id, noEmail.id],
      }),
      201
    )
    // Só uma campanha activa se envia.
    const early = await ctx.http.post(`/api/v1/campaigns/${c.id}/send`, {})
    assert.equal(early.status(), 409)
    assert.equal(early.body().error.code, 'CAMPAIGN_NOT_RUNNING')
    await must(await activate(ctx, c.id), 200)

    const sent = await must<any>(await ctx.http.post(`/api/v1/campaigns/${c.id}/send`, {}), 200)
    assert.deepEqual(sent, { sent: 1, optedOut: 1, noConsent: 1, noDestination: 1 })
    const byStatus = async (status: string) =>
      (
        await must<any[]>(
          await ctx.http.get(`/api/v1/campaigns/${c.id}/members?status=${status}`),
          200
        )
      ).map((m) => m.leadId)
    assert.deepEqual(await byStatus('CONTACTED'), [optIn.id])
    assert.deepEqual(await byStatus('OPTED_OUT'), [optOut.id])
    assert.sameMembers(await byStatus('TARGETED'), [unknown.id, noEmail.id])

    // Repetir o envio não volta a contactar ninguém.
    const repeat = await must<any>(await ctx.http.post(`/api/v1/campaigns/${c.id}/send`, {}), 200)
    assert.equal(repeat.sent, 0)
    const events = await owner<{ n: number }>(
      `select count(*)::int as n from outbox_events where event_type = 'crm.campaign.contact_requested'`,
      ctx.tenant
    )
    assert.equal(events[0]!.n, 1)
  })

  test('a lista de exclusão vale para Party e leads; opt-out põe o contacto na lista e vale para outras campanhas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const excludedEmail = `fora.${uid()}@exemplo.invalid`
    const party = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', {
        legalName: 'Excluída, Lda.',
        contacts: [{ type: 'EMAIL', value: excludedEmail.toUpperCase() }],
      }),
      201
    )
    const okParty = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', {
        legalName: 'Normal, Lda.',
        contacts: [{ type: 'EMAIL', value: `normal.${uid()}@exemplo.invalid` }],
      }),
      201
    )
    const exclusion = await must<any>(
      await ctx.http.post('/api/v1/marketing-exclusions', { kind: 'EMAIL', value: excludedEmail }),
      201
    )
    assert.equal(
      (
        await ctx.http.post('/api/v1/marketing-exclusions', {
          kind: 'EMAIL',
          value: excludedEmail.toUpperCase(),
        })
      ).status(),
      409
    )
    assert.equal(
      (
        await ctx.http.post('/api/v1/marketing-exclusions', { kind: 'EMAIL', value: 'nao-e-email' })
      ).status(),
      422
    )
    const c = await campaign(ctx)
    await must(await activate(ctx, c.id), 200)
    await must(
      await ctx.http.post(`/api/v1/campaigns/${c.id}/members`, {
        partyIds: [party.id, okParty.id],
      }),
      201
    )
    const sent = await must<any>(await ctx.http.post(`/api/v1/campaigns/${c.id}/send`, {}), 200)
    assert.deepEqual(sent, { sent: 1, optedOut: 1, noConsent: 0, noDestination: 0 })

    // Opt-out de um contactado: a lead passa a OPT_OUT e o email entra na lista; outra campanha não lhe chega.
    const lead = await newLead(ctx, { consentStatus: 'OPT_IN' })
    const second = await campaign(ctx, { name: 'Segunda' })
    await must(await activate(ctx, second.id), 200)
    await must(
      await ctx.http.post(`/api/v1/campaigns/${second.id}/members`, { leadIds: [lead.id] }),
      201
    )
    const member = (
      await must<any[]>(await ctx.http.get(`/api/v1/campaigns/${second.id}/members`), 200)
    )[0]
    const out = await must<any>(
      await ctx.http.post(`/api/v1/campaigns/${second.id}/members/${member.id}/opt-out`, {}),
      200
    )
    assert.equal(out.status, 'OPTED_OUT')
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/leads/${lead.id}`), 200)).consentStatus,
      'OPT_OUT'
    )
    const listed = await must<any[]>(await ctx.http.get('/api/v1/marketing-exclusions'), 200)
    assert.isTrue(listed.some((e) => e.value === lead.email))
    const third = await campaign(ctx, { name: 'Terceira' })
    await must(await activate(ctx, third.id), 200)
    await must(
      await ctx.http.post(`/api/v1/campaigns/${third.id}/members`, { leadIds: [lead.id] }),
      201
    )
    const none = await must<any>(await ctx.http.post(`/api/v1/campaigns/${third.id}/send`, {}), 200)
    assert.equal(none.sent, 0)
    assert.equal(none.optedOut, 1)
    // Retirar da lista de exclusão desfaz só a exclusão.
    assert.equal(
      (await ctx.http.delete(`/api/v1/marketing-exclusions/${exclusion.id}`)).status(),
      204
    )
    assert.equal(
      (await ctx.http.delete(`/api/v1/marketing-exclusions/${exclusion.id}`)).status(),
      404
    )
  })

  test('responder só depois de contactado; e o envio é uma permissão própria', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const c = await campaign(ctx)
    await must(await activate(ctx, c.id), 200)
    const lead = await newLead(ctx, { consentStatus: 'OPT_IN' })
    await must(
      await ctx.http.post(`/api/v1/campaigns/${c.id}/members`, { leadIds: [lead.id] }),
      201
    )
    const member = (
      await must<any[]>(await ctx.http.get(`/api/v1/campaigns/${c.id}/members`), 200)
    )[0]
    const early = await ctx.http.post(`/api/v1/campaigns/${c.id}/members/${member.id}/respond`, {})
    assert.equal(early.status(), 409)

    const manager = await memberWith(ctx, ['crm.read', 'crm.manage'])
    const sender = await memberWith(ctx, ['crm.read', 'campaign.send'])
    assert.equal((await manager.post(`/api/v1/campaigns/${c.id}/send`, {})).status(), 403)
    assert.equal(
      (
        await sender.post('/api/v1/campaigns', { name: 'x', channel: 'EMAIL', startsAt: START })
      ).status(),
      403
    )
    assert.equal((await sender.post(`/api/v1/campaigns/${c.id}/send`, {})).status(), 200)
    const responded = await must<any>(
      await ctx.http.post(`/api/v1/campaigns/${c.id}/members/${member.id}/respond`, {}),
      200
    )
    assert.equal(responded.status, 'RESPONDED')
    const summary = await must<any>(await ctx.http.get(`/api/v1/campaigns/${c.id}`), 200)
    assert.equal(summary.summary.responded, 1)
    assert.equal(
      (await ctx.http.delete(`/api/v1/campaigns/${c.id}/members/${member.id}`)).status(),
      409
    )
  })
})
