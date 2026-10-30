import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { serviceTenantContext } from '#core/tenancy/index'
import {
  ProviderError,
  notificationServices,
  registerChannelProvider,
  registerResourceLink,
  unregisterChannelProvider,
  type ChannelProvider,
  type OutgoingMessage,
} from '#modules/notifications/index'
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

const owner = <T>(sql: string, tenant: Tenant) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

const MODULES = ['notifications']

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
  const context = serviceTenantContext(tenant.id, 'teste')
  return { client, tenant, admin, http, context }
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
  return { actor, http: api(ctx.client, ctx.tenant, actor) }
}

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

/** Fornecedor de teste: guarda o que recebe e, se `dedupe`, devolve a mesma resposta a uma chave repetida. */
class FakeProvider implements ChannelProvider {
  readonly name = 'fake'
  readonly sent = new Map<string, OutgoingMessage[]>()
  calls = 0
  failWith: (() => Error | null)[] = []

  constructor(
    readonly channel: ChannelProvider['channel'],
    readonly supportsDedupe: boolean
  ) {}

  async send(message: OutgoingMessage) {
    this.calls++
    const next = this.failWith.shift()?.()
    const known = this.sent.get(message.dedupeKey)
    if (this.supportsDedupe && known) return { providerMessageId: `msg-${message.dedupeKey}` }
    // Mesmo quando falha depois de aceitar (tempo esgotado), a mensagem chegou ao fornecedor.
    if (next && next.name === 'AcceptedThenTimeout') {
      this.sent.set(message.dedupeKey, [...(known ?? []), message])
      throw next
    }
    if (next) throw next
    this.sent.set(message.dedupeKey, [...(known ?? []), message])
    return { providerMessageId: `msg-${message.dedupeKey}` }
  }

  total() {
    return [...this.sent.values()].reduce((n, list) => n + list.length, 0)
  }
}

const timeoutAfterAccept = () => {
  const error = new Error('tempo esgotado')
  error.name = 'AcceptedThenTimeout'
  return error
}

const externalDraft = (to: string, extra: Record<string, unknown> = {}) => ({
  typeCode: 'system.external_message',
  recipient: {},
  payload: { subject: 'Confirmação', message: 'A sua encomenda foi confirmada.' },
  dedupeSuffix: 'x',
  channels: ['EMAIL' as const],
  destinations: { EMAIL: to },
  ...extra,
})

const requestExternal = async (ctx: Ctx, key: string, to = 'cliente@exemplo.invalid') =>
  (await notificationServices().requests.request(ctx.context, externalDraft(to), key)).request

const deliveriesOf = (ctx: Ctx) =>
  owner<any>(
    `select id, status, attempts, last_error_code, provider_message_id, next_attempt_at, locked_until
       from notification_deliveries where channel = 'EMAIL' order by created_at`,
    ctx.tenant
  )

const makeDue = (ctx: Ctx) =>
  owner(
    `update notification_deliveries set next_attempt_at = now() - interval '1 minute' where status = 'QUEUED'`,
    ctx.tenant
  )

const hooks = (group: any) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      for (const channel of ['EMAIL', 'SMS', 'WHATSAPP'] as const)
        unregisterChannelProvider(channel)
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })
}

test.group('notificações | centro e preferências', (group) => {
  hooks(group)

  const send = (ctx: Ctx, recipients: string[], extra: Record<string, unknown> = {}) =>
    ctx.http.post('/api/v1/notification-requests', {
      typeCode: 'system.message',
      recipientMembershipIds: recipients,
      title: 'Manutenção',
      body: 'O sistema pára às 22h.',
      ...extra,
    })

  test('cada pessoa só vê, lê e marca as suas notificações', async ({ client, assert }) => {
    const ctx = await setup(client)
    const ana = await memberWith(ctx, ['notification.read'])
    const rui = await memberWith(ctx, ['notification.read'])
    await must(await send(ctx, [ana.actor.membershipId, rui.actor.membershipId]), 201)

    const anaList = await ana.http.get('/api/v1/notifications')
    assert.equal(anaList.status(), 200)
    assert.lengthOf(anaList.body().data, 1)
    assert.equal(anaList.body().meta.unread, 1)
    assert.equal(anaList.body().data[0].title, 'Manutenção')
    const mine = anaList.body().data[0].id
    const ruiNotification = (await rui.http.get('/api/v1/notifications')).body().data[0].id

    // Marcar a notificação de outra pessoa é impossível e não lhe toca.
    assert.equal(
      (await ana.http.post(`/api/v1/notifications/${ruiNotification}/read`, {})).status(),
      404
    )
    assert.equal((await rui.http.get('/api/v1/notifications?unread=true')).body().data.length, 1)

    const read = await must<any>(await ana.http.post(`/api/v1/notifications/${mine}/read`, {}), 200)
    assert.isNotNull(read.readAt)
    const again = await must<any>(
      await ana.http.post(`/api/v1/notifications/${mine}/read`, {}),
      200
    )
    assert.equal(again.version, read.version)
    assert.equal((await ana.http.get('/api/v1/notifications')).body().meta.unread, 0)
    assert.equal((await rui.http.get('/api/v1/notifications')).body().meta.unread, 1)

    // «Marcar todas» também só afecta quem pede.
    await send(ctx, [ana.actor.membershipId, rui.actor.membershipId], {
      title: 'Outra',
      dedupeKey: 'b2',
    })
    const all = await must<any>(await ana.http.post('/api/v1/notifications/read-all', {}), 200)
    assert.equal(all.marked, 1)
    assert.equal((await rui.http.get('/api/v1/notifications')).body().meta.unread, 2)
  })

  test('pedir duas vezes com a mesma chave não duplica; sem a permissão não se pede nem se lê', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const ana = await memberWith(ctx, ['notification.read'])
    const first = await must<any>(
      await send(ctx, [ana.actor.membershipId], { dedupeKey: 'k1' }),
      201
    )
    const second = await must<any>(
      await send(ctx, [ana.actor.membershipId], { dedupeKey: 'k1' }),
      201
    )
    assert.deepEqual([first.requested, first.duplicates], [1, 0])
    assert.deepEqual([second.requested, second.duplicates], [0, 1])
    assert.lengthOf((await ana.http.get('/api/v1/notifications')).body().data, 1)

    assert.equal((await ana.http.post('/api/v1/notification-requests', {})).status(), 403)
    const nobody = await memberWith(ctx, ['customer.read'])
    assert.equal((await nobody.http.get('/api/v1/notifications')).status(), 403)
    assert.equal((await ana.http.get('/api/v1/notification-deliveries')).status(), 403)
    assert.equal((await send(ctx, ['00000000-0000-4000-8000-000000000000'])).status(), 422)
    assert.equal(
      (await send(ctx, [ana.actor.membershipId], { typeCode: 'crm.lead.converted' })).status(),
      422
    )
  })

  test('as preferências valem, excepto nos avisos obrigatórios', async ({ client, assert }) => {
    const ctx = await setup(client)
    const ana = await memberWith(ctx, ['notification.read'])
    const view = await must<any[]>(await ana.http.get('/api/v1/notification-preferences'), 200)
    const system = view.find((p) => p.typeCode === 'system.message')
    assert.isTrue(system.enabled)
    assert.isTrue(view.find((p) => p.typeCode === 'system.mandatory').locked)

    await must(
      await ana.http.put('/api/v1/notification-preferences', {
        preferences: [{ typeCode: 'system.message', channel: 'IN_APP', enabled: false }],
      }),
      200
    )
    await must(await send(ctx, [ana.actor.membershipId]), 201)
    assert.lengthOf((await ana.http.get('/api/v1/notifications')).body().data, 0)

    // Um aviso obrigatório não se desactiva e chega mesmo a quem recusou o resto.
    const refused = await ana.http.put('/api/v1/notification-preferences', {
      preferences: [{ typeCode: 'system.mandatory', channel: 'IN_APP', enabled: false }],
    })
    assert.equal(refused.status(), 422)
    assert.equal(code(refused), 'MANDATORY_NOTIFICATION')
    await must(
      await send(ctx, [ana.actor.membershipId], {
        typeCode: 'system.mandatory',
        title: 'Obrigatório',
      }),
      201
    )
    assert.equal((await ana.http.get('/api/v1/notifications')).body().data[0].title, 'Obrigatório')

    assert.equal(
      code(
        await ana.http.put('/api/v1/notification-preferences', {
          preferences: [
            {
              typeCode: 'system.message',
              channel: 'IN_APP',
              enabled: true,
              quietHours: { start: '25:00', end: '07:00' },
            },
          ],
        })
      ),
      'INVALID_QUIET_HOURS'
    )
    assert.equal(
      code(
        await ana.http.put('/api/v1/notification-preferences', {
          preferences: [{ typeCode: 'system.message', channel: 'EMAIL', enabled: true }],
        })
      ),
      'INVALID_CHANNEL'
    )
  })

  test('abrir a ligação revalida o acesso ao recurso no momento de abrir', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    let exists = true
    registerResourceLink('test_document', {
      permission: 'crm.read',
      path: 'documentos',
      exists: async () => exists,
    })
    const reader = await memberWith(ctx, ['notification.read', 'crm.read'])
    const blind = await memberWith(ctx, ['notification.read'])
    const resource = { type: 'test_document', id: '11111111-1111-4111-8111-111111111111' }
    for (const m of [reader, blind]) {
      await notificationServices().requests.request(
        ctx.context,
        {
          typeCode: 'system.message',
          recipient: { membershipId: m.actor.membershipId },
          payload: { title: 'Documento', body: 'Há um documento novo.' },
          dedupeSuffix: 'd',
          resource,
        },
        `doc:${m.actor.membershipId}`
      )
    }
    const idOf = async (m: typeof reader) =>
      (await m.http.get('/api/v1/notifications')).body().data[0].id

    const opened = await must<any>(
      await reader.http.post(`/api/v1/notifications/${await idOf(reader)}/open`, {}),
      200
    )
    assert.deepEqual(opened, {
      resourceType: 'test_document',
      resourceId: resource.id,
      path: 'documentos',
    })
    assert.equal((await reader.http.get('/api/v1/notifications')).body().meta.unread, 0)

    // Sem a permissão actual: 403 e nada se devolve (e a notificação continua por ler).
    const denied = await blind.http.post(`/api/v1/notifications/${await idOf(blind)}/open`, {})
    assert.equal(denied.status(), 403)
    assert.equal(denied.body().error.code, 'RESOURCE_ACCESS_REVOKED')
    assert.notProperty(denied.body(), 'data')
    assert.equal((await blind.http.get('/api/v1/notifications')).body().meta.unread, 1)

    // O recurso deixou de existir: quem tinha acesso também deixa de o abrir.
    exists = false
    assert.equal(
      (await reader.http.post(`/api/v1/notifications/${await idOf(reader)}/open`, {})).status(),
      403
    )
    // Sem recurso associado.
    await send(ctx, [reader.actor.membershipId], { title: 'Simples' })
    const plain = (await reader.http.get('/api/v1/notifications'))
      .body()
      .data.find((n: any) => n.title === 'Simples')
    assert.equal(
      (await reader.http.post(`/api/v1/notifications/${plain.id}/open`, {})).status(),
      409
    )
  })
})

test.group('notificações | entregas por canal', (group) => {
  hooks(group)

  const tick = (ctx: Ctx) => notificationServices().engine().deliverDue(ctx.context)

  test('entrega uma só vez, o destino fica cifrado e a administração vê só o mínimo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const provider = new FakeProvider('EMAIL', true)
    registerChannelProvider(provider)
    await requestExternal(ctx, 'e1', 'Cliente.Secreto@exemplo.invalid')
    const raw = await owner<any>(
      `select destination_encrypted, destination_hint from notification_deliveries`,
      ctx.tenant
    )
    assert.notInclude(raw[0].destination_encrypted, 'secreto')
    assert.match(raw[0].destination_encrypted, /^v1:/)
    assert.equal(raw[0].destination_hint, 'C***@exemplo.invalid')

    assert.equal(await tick(ctx), 1)
    assert.equal(provider.total(), 1)
    assert.equal(await tick(ctx), 0)
    const [delivery] = await deliveriesOf(ctx)
    assert.equal(delivery.status, 'SENT')
    assert.equal(delivery.attempts, 1)
    assert.equal(
      provider.sent.get(delivery.id)?.[0]?.destination,
      'Cliente.Secreto@exemplo.invalid'
    )

    const list = await ctx.http.get('/api/v1/notification-deliveries?channel=EMAIL')
    assert.equal(list.status(), 200)
    const json = JSON.stringify(list.body().data)
    assert.notInclude(json, 'secreto')
    assert.notInclude(json, 'payload')
    assert.notInclude(json, 'A sua encomenda')
    assert.equal(list.body().data[0].destinationHint, 'C***@exemplo.invalid')
    assert.equal(list.body().data[0].status, 'SENT')
    const status = await owner<any>(`select status from notification_requests`, ctx.tenant)
    assert.equal(status[0].status, 'COMPLETED')
  })

  test('SENT é só «aceite»: DELIVERED depende da confirmação do fornecedor, que se repete sem efeito', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    registerChannelProvider(new FakeProvider('EMAIL', true))
    await requestExternal(ctx, 'e2')
    await tick(ctx)
    const [sent] = await deliveriesOf(ctx)
    assert.equal(sent.status, 'SENT')
    const services = notificationServices().deliveries
    assert.isFalse(await services.confirmDelivered(ctx.context, 'fake', 'desconhecido'))
    assert.isTrue(await services.confirmDelivered(ctx.context, 'fake', sent.provider_message_id))
    assert.isTrue(await services.confirmDelivered(ctx.context, 'fake', sent.provider_message_id))
    assert.equal((await deliveriesOf(ctx))[0].status, 'DELIVERED')
  })

  test('um canal sem fornecedor falha com clareza e repete-se depois de configurado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await requestExternal(ctx, 'e3')
    await tick(ctx)
    const [failed] = await deliveriesOf(ctx)
    assert.equal(failed.status, 'FAILED')
    assert.equal(failed.last_error_code, 'PROVIDER_NOT_CONFIGURED')
    assert.equal(
      (await owner<any>(`select status from notification_requests`, ctx.tenant))[0].status,
      'FAILED'
    )

    const provider = new FakeProvider('EMAIL', false)
    registerChannelProvider(provider)
    const retried = await must<any>(
      await ctx.http.post(`/api/v1/notification-deliveries/${failed.id}/retry`, {}),
      200
    )
    assert.equal(retried.status, 'QUEUED')
    assert.equal(
      (await ctx.http.post(`/api/v1/notification-deliveries/${failed.id}/retry`, {})).status(),
      409
    )
    await tick(ctx)
    assert.equal((await deliveriesOf(ctx))[0].status, 'SENT')
    assert.equal(provider.total(), 1)
  })

  test('uma recusa do fornecedor repete-se com recuo; no fim fica falhada', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const provider = new FakeProvider('EMAIL', false)
    provider.failWith = [() => new ProviderError('RATE', 'limite', true)]
    registerChannelProvider(provider)
    await requestExternal(ctx, 'e4')
    await tick(ctx)
    let [d] = await deliveriesOf(ctx)
    assert.equal(d.status, 'QUEUED')
    assert.equal(d.attempts, 1)
    assert.isAbove(new Date(d.next_attempt_at).getTime(), Date.now())
    assert.equal(await tick(ctx), 0)
    await makeDue(ctx)
    await tick(ctx)
    ;[d] = await deliveriesOf(ctx)
    assert.equal(d.status, 'SENT')
    assert.equal(d.attempts, 2)

    // Recusa definitiva: não se repete.
    provider.failWith = [() => new ProviderError('BAD_ADDRESS', 'endereço inválido', false)]
    await requestExternal(ctx, 'e5', 'outro@exemplo.invalid')
    await tick(ctx)
    const second = (await deliveriesOf(ctx))[1]
    assert.equal(second.status, 'FAILED')
    assert.equal(second.last_error_code, 'BAD_ADDRESS')
  })

  test('um retry nunca envia duas vezes quando o fornecedor deduplica', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const provider = new FakeProvider('EMAIL', true)
    // O fornecedor aceita a mensagem mas a resposta perde-se (tempo esgotado).
    provider.failWith = [timeoutAfterAccept]
    registerChannelProvider(provider)
    await requestExternal(ctx, 'e6')
    await tick(ctx)
    let [d] = await deliveriesOf(ctx)
    assert.equal(d.status, 'QUEUED')
    assert.equal(d.last_error_code, 'PROVIDER_UNKNOWN')
    assert.equal(provider.total(), 1)
    await makeDue(ctx)
    await tick(ctx)
    ;[d] = await deliveriesOf(ctx)
    assert.equal(d.status, 'SENT')
    assert.equal(d.attempts, 2)
    // Duas chamadas ao fornecedor, uma só mensagem (a mesma chave de dedupe).
    assert.equal(provider.calls, 2)
    assert.equal(provider.total(), 1)
  })

  test('sem dedupe, um resultado desconhecido nunca se repete sozinho (ficaria duplicado)', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const provider = new FakeProvider('EMAIL', false)
    provider.failWith = [timeoutAfterAccept]
    registerChannelProvider(provider)
    await requestExternal(ctx, 'e7')
    await tick(ctx)
    const [d] = await deliveriesOf(ctx)
    assert.equal(d.status, 'FAILED')
    assert.equal(d.last_error_code, 'AMBIGUOUS_NO_DEDUPE')
    await makeDue(ctx)
    await tick(ctx)
    assert.equal(provider.calls, 1)
  })

  test('uma tentativa cuja concessão expirou (processo caído) só se repete com dedupe', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const plain = new FakeProvider('EMAIL', false)
    registerChannelProvider(plain)
    await requestExternal(ctx, 'e8')
    await owner(
      `update notification_deliveries set locked_until = now() - interval '5 minutes'`,
      ctx.tenant
    )
    await tick(ctx)
    const [stuck] = await deliveriesOf(ctx)
    assert.equal(stuck.last_error_code, 'AMBIGUOUS_NO_DEDUPE')
    assert.equal(plain.calls, 0)

    const smart = new FakeProvider('EMAIL', true)
    registerChannelProvider(smart)
    await requestExternal(ctx, 'e9', 'dois@exemplo.invalid')
    await owner(
      `update notification_deliveries set locked_until = now() - interval '5 minutes' where status = 'QUEUED'`,
      ctx.tenant
    )
    await tick(ctx)
    assert.equal((await deliveriesOf(ctx))[1].status, 'SENT')
    assert.equal(smart.total(), 1)
  })

  test('dois trabalhadores em simultâneo enviam cada entrega uma só vez', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const provider = new FakeProvider('EMAIL', false)
    registerChannelProvider(provider)
    for (let i = 0; i < 6; i++) await requestExternal(ctx, `c${i}`, `c${i}@exemplo.invalid`)
    await Promise.all([tick(ctx), tick(ctx), tick(ctx)])
    assert.equal(provider.total(), 6)
    assert.equal(provider.calls, 6)
    assert.isTrue(
      (await deliveriesOf(ctx)).every((d: any) => d.status === 'SENT' && d.attempts === 1)
    )
  })

  test('as horas de silêncio adiam a entrega externa; o aviso obrigatório ignora-as', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const ana = await memberWith(ctx, ['notification.read'])
    const provider = new FakeProvider('EMAIL', true)
    registerChannelProvider(provider)
    const now = new Date()
    const hhmm = (offsetMinutes: number) => {
      const d = new Date(now.getTime() + offsetMinutes * 60_000)
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    }
    await must(
      await ana.http.put('/api/v1/notification-preferences', {
        preferences: [
          {
            typeCode: 'system.external_message',
            channel: 'EMAIL',
            enabled: true,
            quietHours: { start: hhmm(-60), end: hhmm(60), utcOffsetMinutes: 0 },
          },
        ],
      }),
      200
    )
    // `system.external_message` aparece nas preferências: o pedido de um membro com destino respeita a janela.
    await notificationServices().requests.request(
      ctx.context,
      externalDraft('ana@exemplo.invalid', { recipient: { membershipId: ana.actor.membershipId } }),
      'q1'
    )
    const [d] = await deliveriesOf(ctx)
    const until = new Date(d.next_attempt_at).getTime()
    assert.isAbove(until, now.getTime() + 30 * 60_000)
    assert.equal(await tick(ctx), 0)
    assert.equal(provider.total(), 0)
  })
})

test.group('notificações | do outbox', (group) => {
  hooks(group)

  test('um evento do outbox gera os seus pedidos uma só vez, mesmo com replay', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const ana = await memberWith(ctx, ['notification.read'])
    const { registerNotificationRule } = await import('#modules/notifications/index')
    registerNotificationRule({
      code: 'test.rule',
      eventTypes: ['test.thing.happened'],
      async build(_context, event) {
        return [
          {
            typeCode: 'system.message',
            recipient: { membershipId: String(event.payload['to']) },
            payload: { title: 'Aconteceu', body: 'Algo aconteceu.' },
            dedupeSuffix: 'a',
          },
        ]
      },
    })
    await owner(
      `insert into outbox_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload)
       values ('${ctx.tenant.id}', 'thing', gen_random_uuid(), 1, 'test.thing.happened',
               '{"to":"${ana.actor.membershipId}"}'::jsonb)`,
      ctx.tenant
    )
    const engine = notificationServices().engine()
    assert.equal((await engine.processTenant(ctx.tenant.id)).consumed >= 1, true)
    assert.lengthOf((await ana.http.get('/api/v1/notifications')).body().data, 1)
    // Replay: o evento volta a ser entregue ao consumidor, mas o pedido já existe.
    await owner(`delete from outbox_deliveries where consumer = 'notifications'`, ctx.tenant)
    await engine.processTenant(ctx.tenant.id)
    assert.lengthOf((await ana.http.get('/api/v1/notifications')).body().data, 1)
    assert.equal(
      (await owner<any>(`select count(*)::int as n from notification_requests`, ctx.tenant))[0].n,
      1
    )
  })
})
