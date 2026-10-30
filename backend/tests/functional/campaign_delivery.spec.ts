import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import {
  notificationServices,
  registerChannelProvider,
  unregisterChannelProvider,
  type ChannelProvider,
  type OutgoingMessage,
} from '#modules/notifications/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import type { Tenant } from '#platform/tenants/index'

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const owner = <T>(sql: string, tenant: Tenant) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

class Recorder implements ChannelProvider {
  readonly name = 'recorder'
  readonly supportsDedupe = true
  readonly messages: OutgoingMessage[] = []
  constructor(readonly channel: ChannelProvider['channel']) {}
  async send(message: OutgoingMessage) {
    this.messages.push(message)
    return { providerMessageId: `r-${this.messages.length}` }
  }
}

const MODULES = ['customers', 'prospecting', 'notifications']

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
  return { tenant, admin, http, org }
}

type Ctx = Awaited<ReturnType<typeof setup>>

let counter = 0
const lead = async (ctx: Ctx, extra: Record<string, unknown> = {}) =>
  must<any>(
    await ctx.http.post('/api/v1/leads', {
      name: `Lead ${counter++}`,
      source: 'web',
      email: `lead${counter}.${Date.now().toString(36)}@exemplo.invalid`,
      consentStatus: 'OPT_IN',
      ...extra,
    }),
    201
  )

/** Campanha de email activa, com mensagem, e os destinatários indicados. */
async function activeCampaign(ctx: Ctx, leadIds: string[], extra: Record<string, unknown> = {}) {
  const campaign = await must<any>(
    await ctx.http.post('/api/v1/campaigns', {
      name: 'Lançamento',
      channel: 'EMAIL',
      startsAt: '2026-01-01T00:00:00Z',
      subject: 'Novidades de Outono',
      message: 'Conheça a nossa nova gama.',
      ...extra,
    }),
    201
  )
  await must(
    await ctx.http.post(`/api/v1/campaigns/${campaign.id}/status`, { status: 'ACTIVE' }),
    200
  )
  if (leadIds.length > 0) {
    await must(await ctx.http.post(`/api/v1/campaigns/${campaign.id}/members`, { leadIds }), 201)
  }
  return campaign as { id: string }
}

test.group('campanhas | entrega pelo serviço de notificações', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      unregisterChannelProvider('EMAIL')
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  const run = (ctx: Ctx) => notificationServices().engine().processTenant(ctx.tenant.id)

  test('o pedido de contacto de uma campanha entrega-se uma só vez, com o texto da campanha', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const recorder = new Recorder('EMAIL')
    registerChannelProvider(recorder)
    const ana = await lead(ctx, { email: 'ana@exemplo.invalid' })
    const campaign = await activeCampaign(ctx, [ana.id])
    const sent = await must<any>(
      await ctx.http.post(`/api/v1/campaigns/${campaign.id}/send`, {}),
      200
    )
    assert.equal(sent.sent, 1)

    await run(ctx)
    assert.lengthOf(recorder.messages, 1)
    assert.equal(recorder.messages[0]!.destination, 'ana@exemplo.invalid')
    assert.equal(recorder.messages[0]!.title, 'Novidades de Outono')
    assert.equal(recorder.messages[0]!.body, 'Conheça a nossa nova gama.')

    // Repetir o trabalho ou o envio da campanha não volta a contactar.
    await run(ctx)
    await ctx.http.post(`/api/v1/campaigns/${campaign.id}/send`, {})
    await run(ctx)
    assert.lengthOf(recorder.messages, 1)
    const deliveries = await must<any[]>(await ctx.http.get('/api/v1/notification-deliveries'), 200)
    assert.deepEqual(
      deliveries.map((d) => [d.typeCode, d.channel, d.status]),
      [['crm.campaign.message', 'EMAIL', 'SENT']]
    )
  })

  test('quem recusa entre o pedido e a entrega nunca recebe a mensagem', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const recorder = new Recorder('EMAIL')
    registerChannelProvider(recorder)
    const rui = await lead(ctx, { email: 'rui@exemplo.invalid' })
    const bia = await lead(ctx, { email: 'bia@exemplo.invalid' })
    const campaign = await activeCampaign(ctx, [rui.id, bia.id])
    await must(await ctx.http.post(`/api/v1/campaigns/${campaign.id}/send`, {}), 200)
    // O pedido já está no outbox; a Rui recusa antes de o trabalhador entregar.
    await must(
      await ctx.http.patch(`/api/v1/leads/${rui.id}`, {
        expectedVersion: rui.version,
        consentStatus: 'OPT_OUT',
      }),
      200
    )
    await run(ctx)
    assert.deepEqual(
      recorder.messages.map((m) => m.destination),
      ['bia@exemplo.invalid']
    )
    const failed = await must<any[]>(
      await ctx.http.get('/api/v1/notification-deliveries?status=FAILED'),
      200
    )
    assert.lengthOf(failed, 1)
    assert.equal(failed[0].lastErrorCode, 'OPTED_OUT')

    // Também a lista de exclusão vale no momento da entrega.
    const cris = await lead(ctx, { email: 'cris@exemplo.invalid' })
    const second = await activeCampaign(ctx, [cris.id], { name: 'Segunda' })
    await must(await ctx.http.post(`/api/v1/campaigns/${second.id}/send`, {}), 200)
    await must(
      await ctx.http.post('/api/v1/marketing-exclusions', {
        kind: 'EMAIL',
        value: 'cris@exemplo.invalid',
      }),
      201
    )
    await run(ctx)
    assert.lengthOf(recorder.messages, 1)
  })

  test('uma campanha sem mensagem não se envia; a conversão de uma lead avisa o responsável', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const ana = await lead(ctx)
    const empty = await activeCampaign(ctx, [ana.id], { message: null, subject: null })
    const blocked = await ctx.http.post(`/api/v1/campaigns/${empty.id}/send`, {})
    assert.equal(blocked.status(), 409)
    assert.equal(blocked.body().error.code, 'CAMPAIGN_NO_MESSAGE')

    const company = await lead(ctx, { companyName: 'Acme, Lda.' })
    await must(
      await ctx.http.post(`/api/v1/leads/${company.id}/convert`, { organizationId: ctx.org.id }),
      201
    )
    await run(ctx)
    const mine = await must<any[]>(await ctx.http.get('/api/v1/notifications'), 200)
    assert.lengthOf(mine, 1)
    assert.equal(mine[0].typeCode, 'crm.lead.converted')
    const opened = await must<any>(
      await ctx.http.post(`/api/v1/notifications/${mine[0].id}/open`, {}),
      200
    )
    assert.equal(opened.resourceType, 'opportunity')
    assert.equal(opened.path, 'crm/pipeline')
    await run(ctx)
    assert.lengthOf(await must<any[]>(await ctx.http.get('/api/v1/notifications'), 200), 1)
    assert.equal(
      (await owner<any>(`select count(*)::int as n from notification_requests`, ctx.tenant))[0].n,
      1
    )
  })
})
