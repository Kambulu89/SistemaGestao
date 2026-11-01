import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { iamServices } from '#core/permissions/index'
import { tenantServices } from '#platform/tenants/index'
import { calendarServices } from '#modules/calendar/index'
import { notificationServices } from '#modules/notifications/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { buildWorld, type World } from '#tests/support/matrix_fixture'

type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

const owner = <T>(sql: string, world: World) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [world.tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

let cached: { a: World; b: World } | undefined
async function worlds(client: any) {
  if (!cached) {
    await iamServices().syncCatalog.execute()
    await resetAuthState()
    cached = { a: await buildWorld(client, 'A'), b: await buildWorld(client, 'B') }
  }
  return cached
}

async function memberWith(client: any, world: World, permissions: string[]) {
  await resetAuthState()
  const actor = await newActor(client, world.tenant)
  const role = await must<{ id: string }>(
    await world.http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await world.http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return { actor, http: api(client, world.tenant, actor) }
}

let seq = 0
const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${seq++}`

const newResource = async (http: Http, world: World, extra: Record<string, unknown> = {}) =>
  must<{ id: string; version: number }>(
    await http.post('/api/v1/resources', {
      organizationId: world.ids.organization,
      code: unique('R'),
      name: 'Sala de teste',
      type: 'ROOM',
      capacity: 10,
      ...extra,
    }),
    201
  )

const newEvent = async (
  http: Http,
  world: World,
  start: string,
  end: string,
  extra: Record<string, unknown> = {}
) =>
  must<{ id: string; version: number }>(
    await http.post('/api/v1/calendar-events', {
      calendarId: world.ids.calendar,
      title: 'Evento de teste',
      startsAt: start,
      endsAt: end,
      ...extra,
    }),
    201
  )

const book = (http: Http, body: Record<string, unknown>) =>
  http.post('/api/v1/resource-bookings', body)

const listEvents = async (http: Http, from: string, to: string, calendarId?: string) =>
  must<{ items: any[] }>(
    await http.get(
      `/api/v1/calendar-events?from=${from}&to=${to}${calendarId ? `&calendarId=${calendarId}` : ''}`
    ),
    200
  )

const inLisbon = (iso: string) =>
  DateTime.fromISO(iso, { zone: 'utc' }).setZone('Europe/Lisbon').toFormat("yyyy-MM-dd'T'HH:mm")

test.group('agenda | reservas: colisão, concorrência e provisórias', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.timeout(240_000)

  test('duas reservas concorrentes do mesmo horário permitem só uma; as adjacentes passam', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const room = await newResource(a.http, a)
    const events = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        newEvent(a.http, a, '2031-02-03T10:00:00Z', '2031-02-03T11:00:00Z', {
          title: `Corrida ${i}`,
        })
      )
    )
    const results = await Promise.all(
      events.map((e) => book(a.http, { eventId: e.id, resourceId: room.id }))
    )
    const created = results.filter((r) => r.status() === 201)
    const refused = results.filter((r) => r.status() === 409)
    assert.lengthOf(created, 1)
    assert.lengthOf(refused, 7)
    for (const r of refused) assert.equal(r.body().error.code, 'RESOURCE_UNAVAILABLE')
    const active = await owner<any>(
      `select count(*)::int as n from resource_bookings where resource_id = '${room.id}' and status in ('HELD','CONFIRMED')`,
      a
    )
    assert.equal(active[0].n, 1)

    // [início, fim): quem começa quando o outro acaba não colide.
    const next = await newEvent(a.http, a, '2031-02-03T11:00:00Z', '2031-02-03T12:00:00Z')
    await must(await book(a.http, { eventId: next.id, resourceId: room.id }), 201)
    // Sobreposição parcial: recusada.
    const overlap = await newEvent(a.http, a, '2031-02-03T10:30:00Z', '2031-02-03T11:30:00Z')
    const clash = await book(a.http, { eventId: overlap.id, resourceId: room.id })
    assert.equal(clash.status(), 409)
    assert.equal(clash.body().error.code, 'RESOURCE_UNAVAILABLE')
  })

  test('a base de dados recusa a sobreposição sozinha, mesmo sem a aplicação', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const room = await newResource(a.http, a)
    const first = await newEvent(a.http, a, '2031-02-04T10:00:00Z', '2031-02-04T11:00:00Z')
    const second = await newEvent(a.http, a, '2031-02-04T10:15:00Z', '2031-02-04T10:45:00Z')
    await must(await book(a.http, { eventId: first.id, resourceId: room.id }), 201)
    await assert.rejects(
      () =>
        owner(
          `insert into resource_bookings (tenant_id, event_id, resource_id, starts_at, ends_at, status)
           values ('${a.tenant.id}', '${second.id}', '${room.id}', '2031-02-04T10:15:00Z', '2031-02-04T10:45:00Z', 'CONFIRMED')`,
          a
        ),
      /resource_bookings_no_overlap/
    )
    // Uma reserva cancelada não ocupa o horário.
    const booking = (
      await owner<any>(`select id from resource_bookings where resource_id = '${room.id}'`, a)
    )[0].id
    await must(await a.http.post(`/api/v1/resource-bookings/${booking}/cancel`, {}), 200)
    await must(await book(a.http, { eventId: second.id, resourceId: room.id }), 201)
  })

  test('reserva provisória: ocupa até vencer, depois liberta; confirmar a vencida falha', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const room = await newResource(a.http, a)
    const first = await newEvent(a.http, a, '2031-02-05T10:00:00Z', '2031-02-05T11:00:00Z')
    const rival = await newEvent(a.http, a, '2031-02-05T10:00:00Z', '2031-02-05T11:00:00Z')
    const held = await must<{ bookings: any[] }>(
      await book(a.http, { eventId: first.id, resourceId: room.id, hold: true, holdMinutes: 30 }),
      201
    )
    assert.equal(held.bookings[0].status, 'HELD')
    assert.isOk(held.bookings[0].expiresAt)
    assert.equal((await book(a.http, { eventId: rival.id, resourceId: room.id })).status(), 409)

    // Confirmar a provisória válida torna-a definitiva.
    const confirmed = await must<any>(
      await a.http.post(`/api/v1/resource-bookings/${held.bookings[0].id}/confirm`, {}),
      200
    )
    assert.equal(confirmed.status, 'CONFIRMED')
    assert.isNull(confirmed.expiresAt)

    // Outra provisória que vence.
    const room2 = await newResource(a.http, a)
    const short = await must<{ bookings: any[] }>(
      await book(a.http, { eventId: first.id, resourceId: room2.id, hold: true, holdMinutes: 5 }),
      201
    )
    await owner(
      `update resource_bookings set expires_at = now() - interval '1 minute' where id = '${short.bookings[0].id}'`,
      a
    )
    const expired = await a.http.post(
      `/api/v1/resource-bookings/${short.bookings[0].id}/confirm`,
      {}
    )
    assert.equal(expired.status(), 409)
    assert.equal(expired.body().error.code, 'HOLD_EXPIRED')
    // O horário vencido volta a estar livre.
    await must(await book(a.http, { eventId: rival.id, resourceId: room2.id }), 201)
    const state = await owner<any>(
      `select status, cancel_reason from resource_bookings where id = '${short.bookings[0].id}'`,
      a
    )
    assert.deepEqual([state[0].status, state[0].cancel_reason], ['CANCELLED', 'EXPIRED'])
  })

  test('cancelar a reserva liberta o horário, preserva o evento e avisa os participantes', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const guest = await memberWith(client, a, ['notification.read', 'calendar.read'])
    const room = await newResource(a.http, a)
    const event = await newEvent(a.http, a, '2031-02-06T10:00:00Z', '2031-02-06T11:00:00Z', {
      title: 'Workshop de Fevereiro',
    })
    await must(
      await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
        membershipId: guest.actor.membershipId,
      }),
      201
    )
    const booked = await must<{ bookings: any[] }>(
      await book(a.http, { eventId: event.id, resourceId: room.id }),
      201
    )
    const cancelled = await must<any>(
      await a.http.post(`/api/v1/resource-bookings/${booked.bookings[0].id}/cancel`, {}),
      200
    )
    assert.equal(cancelled.status, 'CANCELLED')
    // Repetir é inofensivo.
    await must(
      await a.http.post(`/api/v1/resource-bookings/${booked.bookings[0].id}/cancel`, {}),
      200
    )

    const kept = await must<any>(await a.http.get(`/api/v1/calendar-events/${event.id}`), 200)
    assert.equal(kept.status, 'CONFIRMED')
    assert.lengthOf(kept.bookings, 0)

    await notificationServices().engine().processTenant(a.tenant.id)
    const notices = (await guest.http.get('/api/v1/notifications')).body().data as any[]
    const notice = notices.find((n) => n.title === 'Reserva cancelada')
    assert.isOk(notice, JSON.stringify(notices))
    assert.include(notice.body, 'Workshop de Fevereiro')
    // Quem cancelou não é avisado.
    const adminNotices = (await a.http.get('/api/v1/notifications')).body().data as any[]
    assert.isUndefined(adminNotices.find((n) => n.body?.includes('Workshop de Fevereiro')))
    // O horário libertado volta a poder ser reservado.
    const other = await newEvent(a.http, a, '2031-02-06T10:00:00Z', '2031-02-06T11:00:00Z')
    await must(await book(a.http, { eventId: other.id, resourceId: room.id }), 201)
  })

  test('a capacidade do recurso vale para participantes e reservas', async ({ client, assert }) => {
    const { a } = await worlds(client)
    const small = await newResource(a.http, a, { capacity: 2 })
    const event = await newEvent(a.http, a, '2031-02-07T10:00:00Z', '2031-02-07T11:00:00Z')
    const people = [
      await memberWith(client, a, ['calendar.read']),
      await memberWith(client, a, ['calendar.read']),
      await memberWith(client, a, ['calendar.read']),
    ]
    for (const p of people) {
      await must(
        await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
          membershipId: p.actor.membershipId,
        }),
        201
      )
    }
    // Três participantes numa sala de duas pessoas.
    const tooBig = await book(a.http, { eventId: event.id, resourceId: small.id })
    assert.equal(tooBig.status(), 422)
    assert.equal(code(tooBig), 'CAPACITY_EXCEEDED')
    // Numa sala maior cabe; e depois já não se acrescentam além dela.
    const medium = await newResource(a.http, a, { capacity: 3 })
    await must(await book(a.http, { eventId: event.id, resourceId: medium.id }), 201)
    const extra = await memberWith(client, a, ['calendar.read'])
    const refused = await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
      membershipId: extra.actor.membershipId,
    })
    assert.equal(refused.status(), 422)
    assert.equal(code(refused), 'CAPACITY_EXCEEDED')
  })

  test('uma série reserva todas as ocorrências ou nenhuma; cancelar uma só liberta essa', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const room = await newResource(a.http, a)
    const series = await newEvent(a.http, a, '2031-03-03T09:00:00Z', '2031-03-03T10:00:00Z', {
      timezone: 'UTC',
      recurrenceRule: 'FREQ=WEEKLY;COUNT=4',
    })
    // Alguém ocupa a terceira semana: o pedido todo falha e não fica nada reservado.
    const blocker = await newEvent(a.http, a, '2031-03-17T09:30:00Z', '2031-03-17T09:45:00Z')
    await must(await book(a.http, { eventId: blocker.id, resourceId: room.id }), 201)
    const clash = await book(a.http, { eventId: series.id, resourceId: room.id })
    assert.equal(clash.status(), 409)
    assert.equal(clash.body().error.code, 'RESOURCE_UNAVAILABLE')
    assert.equal(
      (
        await owner<any>(
          `select count(*)::int as n from resource_bookings where event_id = '${series.id}'`,
          a
        )
      )[0].n,
      0
    )

    const free = await newResource(a.http, a)
    const all = await must<{ bookings: any[]; skipped: number }>(
      await book(a.http, { eventId: series.id, resourceId: free.id }),
      201
    )
    assert.lengthOf(all.bookings, 4)
    // Repetir não duplica.
    const again = await must<{ bookings: any[]; skipped: number }>(
      await book(a.http, { eventId: series.id, resourceId: free.id }),
      201
    )
    assert.deepEqual([again.bookings.length, again.skipped], [0, 4])

    // Cancelar só a 2.ª ocorrência liberta apenas essa reserva.
    await must(
      await a.http.post(`/api/v1/calendar-events/${series.id}/cancel`, {
        scope: 'THIS',
        occurrenceStart: '2031-03-10T09:00:00Z',
      }),
      200
    )
    const active = await owner<any>(
      `select occurrence_start from resource_bookings where event_id = '${series.id}' and status = 'CONFIRMED' order by 1`,
      free.id ? a : a
    )
    assert.lengthOf(active, 3)
    const cancelledOccurrence = await book(a.http, {
      eventId: series.id,
      resourceId: free.id,
      occurrenceStart: '2031-03-10T09:00:00Z',
    })
    assert.equal(cancelledOccurrence.status(), 409)
    assert.equal(cancelledOccurrence.body().error.code, 'OCCURRENCE_CANCELLED')
  })

  test('limites: ocorrências a mais, recurso inactivo, intervalo e identificadores', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const room = await newResource(a.http, a)
    const daily = await newEvent(a.http, a, '2031-06-01T09:00:00Z', '2031-06-01T10:00:00Z', {
      recurrenceRule: 'FREQ=DAILY',
    })
    const many = await book(a.http, { eventId: daily.id, resourceId: room.id, horizonDays: 366 })
    assert.equal(many.status(), 422)
    assert.equal(code(many), 'TOO_MANY_OCCURRENCES')

    const off = await newResource(a.http, a)
    await must(
      await a.http.patch(`/api/v1/resources/${off.id}`, {
        version: off.version,
        name: 'Fora de serviço',
        type: 'ROOM',
        capacity: 4,
        active: false,
      }),
      200
    )
    const single = await newEvent(a.http, a, '2031-06-02T09:00:00Z', '2031-06-02T10:00:00Z')
    const inactive = await book(a.http, { eventId: single.id, resourceId: off.id })
    assert.equal(inactive.status(), 409)
    assert.equal(inactive.body().error.code, 'RESOURCE_INACTIVE')

    assert.equal(
      (
        await a.http.get(
          '/api/v1/resource-bookings?from=2031-01-01T00:00:00Z&to=2033-01-01T00:00:00Z'
        )
      ).status(),
      422
    )
    assert.equal((await a.http.get('/api/v1/resource-bookings?from=ontem&to=hoje')).status(), 422)
    assert.equal((await a.http.get('/api/v1/resources/nao-e-uuid')).status(), 404)
    assert.equal((await book(a.http, { eventId: single.id })).status(), 422)
    assert.equal(
      (
        await book(a.http, { eventId: single.id, resourceId: room.id, hold: true, holdMinutes: 0 })
      ).status(),
      422
    )
  })

  test('a disponibilidade mostra intervalos ocupados sem revelar o evento', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const room = await newResource(a.http, a)
    const event = await newEvent(a.http, a, '2031-07-01T10:00:00Z', '2031-07-01T11:00:00Z', {
      title: 'Reunião secreta de direcção',
    })
    await must(await book(a.http, { eventId: event.id, resourceId: room.id }), 201)
    const viewer = await memberWith(client, a, ['resource.read'])
    const availability = await must<any>(
      await viewer.http.get(
        `/api/v1/resources/${room.id}/availability?from=2031-07-01T00:00:00Z&to=2031-07-02T00:00:00Z`
      ),
      200
    )
    assert.lengthOf(availability.busy, 1)
    assert.notInclude(JSON.stringify(availability), 'secreta')
    assert.isFalse(availability.busy[0].mine)
    // Quem só vê recursos não vê o título do evento nas reservas se não vê o seu calendário (aqui vê: TENANT).
    const bookings = await must<any>(
      await viewer.http.get(
        `/api/v1/resource-bookings?resourceId=${room.id}&from=2031-07-01T00:00:00Z&to=2031-07-02T00:00:00Z`
      ),
      200
    )
    assert.lengthOf(bookings.items, 1)
  })

  test('permissões: ler, reservar e gerir são distintos; sem permissão nega', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const room = await newResource(a.http, a)
    const event = await newEvent(a.http, a, '2031-08-01T10:00:00Z', '2031-08-01T11:00:00Z')
    const reader = await memberWith(client, a, ['calendar.read', 'resource.read'])
    const booker = await memberWith(client, a, ['calendar.read', 'resource.read', 'resource.book'])
    const none = await memberWith(client, a, ['party.read'])

    assert.equal((await reader.http.get('/api/v1/resources')).status(), 200)
    assert.equal((await none.http.get('/api/v1/resources')).status(), 403)
    assert.equal((await none.http.get('/api/v1/calendars')).status(), 403)
    assert.equal(
      (
        await reader.http.post('/api/v1/resource-bookings', {
          eventId: event.id,
          resourceId: room.id,
        })
      ).status(),
      403
    )
    assert.equal(
      (
        await reader.http.post('/api/v1/resources', {
          organizationId: a.ids.organization,
          code: unique('X'),
          name: 'x',
          type: 'ROOM',
        })
      ).status(),
      403
    )
    assert.equal(
      (
        await reader.http.post('/api/v1/calendar-events', {
          calendarId: a.ids.calendar,
          title: 'x',
        })
      ).status(),
      403
    )
    await must(
      await booker.http.post('/api/v1/resource-bookings', {
        eventId: event.id,
        resourceId: room.id,
      }),
      201
    )
  })
})

test.group('agenda | eventos, séries, excepções e fusos', (group) => {
  group.each.timeout(240_000)

  test('um evento de uma hora conserva a duração depois de converter o fuso', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const event = await newEvent(a.http, a, '2031-09-01T09:00:00Z', '2031-09-01T10:00:00Z', {
      timezone: 'Europe/Lisbon',
    })
    const detail = await must<any>(await a.http.get(`/api/v1/calendar-events/${event.id}`), 200)
    assert.equal(
      Date.parse(detail.endsAt) - Date.parse(detail.startsAt),
      3_600_000,
      'duração no fuso original'
    )
    // Passar o evento para Nova Iorque mantém os mesmos instantes: a hora local muda, a duração não.
    const moved = await must<any>(
      await a.http.patch(`/api/v1/calendar-events/${event.id}`, {
        version: event.version,
        timezone: 'America/New_York',
      }),
      200
    )
    assert.equal(moved.timezone, 'America/New_York')
    assert.equal(Date.parse(moved.endsAt) - Date.parse(moved.startsAt), 3_600_000)
    assert.equal(moved.startsAt, detail.startsAt)
    const ny = DateTime.fromISO(moved.startsAt, { zone: 'America/New_York' })
    const nyEnd = DateTime.fromISO(moved.endsAt, { zone: 'America/New_York' })
    assert.equal(nyEnd.diff(ny, 'minutes').minutes, 60)
    // Na listagem também.
    const listed = await listEvents(a.http, '2031-09-01T00:00:00Z', '2031-09-02T00:00:00Z')
    const item = listed.items.find((i) => i.eventId === event.id)
    assert.equal(Date.parse(item.endsAt) - Date.parse(item.startsAt), 3_600_000)
  })

  test('validação: fuso, intervalo, regra, origem e estado', async ({ client, assert }) => {
    const { a } = await worlds(client)
    const base = { calendarId: a.ids.calendar, title: 'x' }
    const cases: [string, Record<string, unknown>, string][] = [
      [
        'fuso inexistente',
        {
          startsAt: '2031-09-01T09:00:00Z',
          endsAt: '2031-09-01T10:00:00Z',
          timezone: 'Marte/Olimpo',
        },
        'INVALID_TIMEZONE',
      ],
      [
        'fim antes do início',
        { startsAt: '2031-09-01T10:00:00Z', endsAt: '2031-09-01T09:00:00Z' },
        'INVALID_RANGE',
      ],
      [
        'intervalo vazio',
        { startsAt: '2031-09-01T10:00:00Z', endsAt: '2031-09-01T10:00:00Z' },
        'INVALID_RANGE',
      ],
      [
        'regra com BYMONTH',
        {
          startsAt: '2031-09-01T09:00:00Z',
          endsAt: '2031-09-01T10:00:00Z',
          recurrenceRule: 'FREQ=DAILY;BYMONTH=3',
        },
        'INVALID_RULE',
      ],
      [
        'COUNT e UNTIL',
        {
          startsAt: '2031-09-01T09:00:00Z',
          endsAt: '2031-09-01T10:00:00Z',
          recurrenceRule: 'FREQ=DAILY;COUNT=2;UNTIL=20311231',
        },
        'INVALID_RULE',
      ],
      [
        'estado cancelado ao criar',
        { startsAt: '2031-09-01T09:00:00Z', endsAt: '2031-09-01T10:00:00Z', status: 'CANCELLED' },
        'INVALID',
      ],
      [
        'origem incompleta',
        {
          startsAt: '2031-09-01T09:00:00Z',
          endsAt: '2031-09-01T10:00:00Z',
          sourceType: 'formacao',
        },
        'INVALID',
      ],
    ]
    for (const [name, body, expected] of cases) {
      const response = await a.http.post('/api/v1/calendar-events', { ...base, ...body })
      assert.equal(response.status(), 422, name)
      assert.equal(code(response), expected, name)
    }
    assert.equal(
      (
        await a.http.post('/api/v1/calendar-events', {
          ...base,
          startsAt: '2031-09-01T09:00:00Z',
          endsAt: '2031-09-01T10:00:00Z',
          title: '',
        })
      ).status(),
      422
    )
  })

  test('a série mantém a hora local quando o relógio muda', async ({ client, assert }) => {
    const { a } = await worlds(client)
    // Lisboa muda para a hora de verão em 30/03/2031.
    const event = await newEvent(a.http, a, '2031-03-24T10:00:00Z', '2031-03-24T11:00:00Z', {
      timezone: 'Europe/Lisbon',
      recurrenceRule: 'FREQ=WEEKLY;COUNT=3',
    })
    const listed = await listEvents(a.http, '2031-03-20T00:00:00Z', '2031-04-30T00:00:00Z')
    const items = listed.items.filter((i) => i.eventId === event.id)
    assert.deepEqual(
      items.map((i) => inLisbon(i.startsAt)),
      ['2031-03-24T10:00', '2031-03-31T10:00', '2031-04-07T10:00']
    )
    for (const i of items) assert.equal(Date.parse(i.endsAt) - Date.parse(i.startsAt), 3_600_000)
    assert.isTrue(items.every((i) => i.recurring))
  })

  test('ocorrência cancelada não reaparece; alterada aparece onde foi posta', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const series = await newEvent(a.http, a, '2031-10-06T09:00:00Z', '2031-10-06T10:00:00Z', {
      timezone: 'UTC',
      title: 'Série diária',
      recurrenceRule: 'FREQ=DAILY;COUNT=5',
    })
    const window = ['2031-10-01T00:00:00Z', '2031-11-30T00:00:00Z'] as const
    const mine = async () =>
      (await listEvents(a.http, ...window)).items.filter((i) => i.eventId === series.id)

    await must(
      await a.http.post(`/api/v1/calendar-events/${series.id}/cancel`, {
        scope: 'THIS',
        occurrenceStart: '2031-10-08T09:00:00Z',
      }),
      200
    )
    assert.lengthOf(await mine(), 4)
    // Editar a série (sem mexer em horários) não a ressuscita.
    const renamed = await must<any>(
      await a.http.patch(`/api/v1/calendar-events/${series.id}`, {
        version: series.version,
        title: 'Série renomeada',
      }),
      200
    )
    const afterRename = await mine()
    assert.lengthOf(afterRename, 4)
    assert.isUndefined(afterRename.find((i) => i.occurrenceStart === '2031-10-08T09:00:00.000Z'))
    assert.isTrue(afterRename.every((i) => i.title === 'Série renomeada'))

    // Mover uma ocorrência: aparece no sítio novo, não no antigo.
    await must(
      await a.http.patch(`/api/v1/calendar-events/${series.id}`, {
        version: renamed.version,
        scope: 'THIS',
        occurrenceStart: '2031-10-09T09:00:00Z',
        startsAt: '2031-11-20T15:00:00Z',
        title: 'Adiada',
      }),
      200
    )
    const moved = await mine()
    assert.lengthOf(moved, 4)
    const adiada = moved.find((i) => i.modified)
    assert.equal(adiada.startsAt, '2031-11-20T15:00:00.000Z')
    assert.equal(Date.parse(adiada.endsAt) - Date.parse(adiada.startsAt), 3_600_000)
    assert.equal(adiada.title, 'Adiada')
    assert.isUndefined(moved.find((i) => i.startsAt === '2031-10-09T09:00:00.000Z'))
    // Uma janela que só apanha o novo lugar também a mostra.
    const narrow = await listEvents(a.http, '2031-11-20T00:00:00Z', '2031-11-21T00:00:00Z')
    assert.isOk(narrow.items.find((i) => i.eventId === series.id && i.modified))

    // Mudar horário ou regra com excepções pendentes é recusado em vez de as desfazer em silêncio.
    const current = await must<any>(await a.http.get(`/api/v1/calendar-events/${series.id}`), 200)
    const blocked = await a.http.patch(`/api/v1/calendar-events/${series.id}`, {
      version: current.version,
      startsAt: '2031-10-06T10:00:00Z',
      endsAt: '2031-10-06T11:00:00Z',
    })
    assert.equal(blocked.status(), 409)
    assert.equal(blocked.body().error.code, 'SERIES_HAS_EXCEPTIONS')
    // Excepção a uma ocorrência cancelada não se altera.
    const edit = await a.http.patch(`/api/v1/calendar-events/${series.id}`, {
      version: current.version,
      scope: 'THIS',
      occurrenceStart: '2031-10-08T09:00:00Z',
      title: 'Ressuscitada?',
    })
    assert.equal(edit.status(), 409)
    assert.equal(edit.body().error.code, 'OCCURRENCE_CANCELLED')
  })

  test('esta e as seguintes: a série divide-se e herda os participantes', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const guest = await memberWith(client, a, ['calendar.read'])
    const series = await newEvent(a.http, a, '2031-12-01T09:00:00Z', '2031-12-01T10:00:00Z', {
      timezone: 'UTC',
      title: 'Aula',
      recurrenceRule: 'FREQ=DAILY;COUNT=5',
    })
    await must(
      await a.http.post(`/api/v1/calendar-events/${series.id}/participants`, {
        membershipId: guest.actor.membershipId,
      }),
      201
    )
    const next = await must<any>(
      await a.http.patch(`/api/v1/calendar-events/${series.id}`, {
        version: series.version,
        scope: 'FUTURE',
        occurrenceStart: '2031-12-03T09:00:00Z',
        title: 'Aula nova',
      }),
      200
    )
    assert.notEqual(next.id, series.id)
    assert.equal(next.recurrenceRule, 'FREQ=DAILY;COUNT=3')
    const listed = await listEvents(a.http, '2031-11-25T00:00:00Z', '2032-01-15T00:00:00Z')
    const titles = listed.items
      .filter((i) => [series.id, next.id].includes(i.eventId))
      .map((i) => `${i.startsAt.slice(0, 10)} ${i.title}`)
    assert.deepEqual(titles, [
      '2031-12-01 Aula',
      '2031-12-02 Aula',
      '2031-12-03 Aula nova',
      '2031-12-04 Aula nova',
      '2031-12-05 Aula nova',
    ])
    const detail = await must<any>(await a.http.get(`/api/v1/calendar-events/${next.id}`), 200)
    assert.deepEqual(
      detail.participants.map((p: any) => p.membershipId),
      [guest.actor.membershipId]
    )
    // Cancelar a partir de uma ocorrência acaba a série aí.
    await must(
      await a.http.post(`/api/v1/calendar-events/${next.id}/cancel`, {
        scope: 'FUTURE',
        occurrenceStart: '2031-12-04T09:00:00Z',
      }),
      200
    )
    const after = await listEvents(a.http, '2031-11-25T00:00:00Z', '2032-01-15T00:00:00Z')
    assert.lengthOf(
      after.items.filter((i) => i.eventId === next.id),
      1
    )
  })

  test('cancelar o evento: sai da agenda, liberta as reservas e avisa quem participa', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const guest = await memberWith(client, a, ['notification.read', 'calendar.read'])
    const room = await newResource(a.http, a)
    const event = await newEvent(a.http, a, '2032-01-10T10:00:00Z', '2032-01-10T11:00:00Z', {
      title: 'Assembleia de Janeiro',
    })
    await must(
      await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
        membershipId: guest.actor.membershipId,
      }),
      201
    )
    await must(await book(a.http, { eventId: event.id, resourceId: room.id }), 201)
    const cancelled = await must<any>(
      await a.http.post(`/api/v1/calendar-events/${event.id}/cancel`, {}),
      200
    )
    assert.equal(cancelled.status, 'CANCELLED')
    const listed = await listEvents(a.http, '2032-01-10T00:00:00Z', '2032-01-11T00:00:00Z')
    assert.isUndefined(listed.items.find((i) => i.eventId === event.id))
    assert.equal(
      (
        await owner<any>(
          `select count(*)::int as n from resource_bookings where event_id = '${event.id}' and status <> 'CANCELLED'`,
          a
        )
      )[0].n,
      0
    )
    // Repetir não duplica o aviso.
    await must(await a.http.post(`/api/v1/calendar-events/${event.id}/cancel`, {}), 200)
    await notificationServices().engine().processTenant(a.tenant.id)
    const notices = ((await guest.http.get('/api/v1/notifications')).body().data as any[]).filter(
      (n) => n.body?.includes('Assembleia de Janeiro')
    )
    assert.lengthOf(notices, 1)
    assert.equal(notices[0].title, 'Evento cancelado')
    // Um evento cancelado não se edita nem se reserva.
    const edit = await a.http.patch(`/api/v1/calendar-events/${event.id}`, {
      version: cancelled.version,
      title: 'x',
    })
    assert.equal(edit.status(), 409)
    assert.equal(edit.body().error.code, 'EVENT_CANCELLED')
    assert.equal((await book(a.http, { eventId: event.id, resourceId: room.id })).status(), 409)
  })

  test('concorrência de versão, âmbito e ocorrência inválidos', async ({ client, assert }) => {
    const { a } = await worlds(client)
    const single = await newEvent(a.http, a, '2032-02-01T10:00:00Z', '2032-02-01T11:00:00Z')
    const stale = await a.http.patch(`/api/v1/calendar-events/${single.id}`, {
      version: single.version + 7,
      title: 'x',
    })
    assert.equal(stale.status(), 409)
    assert.equal(
      (await a.http.patch(`/api/v1/calendar-events/${single.id}`, { title: 'x' })).status(),
      422
    )
    const notRecurring = await a.http.patch(`/api/v1/calendar-events/${single.id}`, {
      version: single.version,
      scope: 'THIS',
      occurrenceStart: '2032-02-01T10:00:00Z',
    })
    assert.equal(notRecurring.status(), 422)
    assert.equal(code(notRecurring), 'NOT_RECURRING')
    const series = await newEvent(a.http, a, '2032-02-02T10:00:00Z', '2032-02-02T11:00:00Z', {
      recurrenceRule: 'FREQ=DAILY;COUNT=3',
    })
    const notAnOccurrence = await a.http.post(`/api/v1/calendar-events/${series.id}/cancel`, {
      scope: 'THIS',
      occurrenceStart: '2032-02-02T10:30:00Z',
    })
    assert.equal(notAnOccurrence.status(), 422)
    assert.equal(code(notAnOccurrence), 'INVALID_OCCURRENCE')
    assert.equal(
      (
        await a.http.post(`/api/v1/calendar-events/${series.id}/cancel`, { scope: 'SEMPRE' })
      ).status(),
      422
    )
  })

  test('participantes: únicos, só respondem por si e saem com o evento', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const ana = await memberWith(client, a, ['calendar.read'])
    const rui = await memberWith(client, a, ['calendar.read'])
    const event = await newEvent(a.http, a, '2032-03-01T10:00:00Z', '2032-03-01T11:00:00Z')
    const added = await must<any>(
      await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
        membershipId: ana.actor.membershipId,
      }),
      201
    )
    assert.equal(added.response, 'PENDING')
    const duplicate = await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
      membershipId: ana.actor.membershipId,
    })
    assert.equal(duplicate.status(), 409)
    assert.equal(duplicate.body().error.code, 'PARTICIPANT_EXISTS')
    // Um participante externo (Party).
    await must(
      await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
        partyId: a.ids.personParty,
      }),
      201
    )
    assert.equal(
      (await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {})).status(),
      422
    )
    assert.equal(
      (
        await a.http.post(`/api/v1/calendar-events/${event.id}/participants`, {
          membershipId: ana.actor.membershipId,
          partyId: a.ids.personParty,
        })
      ).status(),
      422
    )

    // Cada pessoa responde só por si.
    const accepted = await must<any>(
      await ana.http.post(`/api/v1/calendar-events/${event.id}/respond`, { response: 'ACCEPTED' }),
      200
    )
    assert.equal(accepted.response, 'ACCEPTED')
    assert.equal(
      (
        await rui.http.post(`/api/v1/calendar-events/${event.id}/respond`, { response: 'ACCEPTED' })
      ).status(),
      404
    )
    assert.equal(
      (
        await ana.http.post(`/api/v1/calendar-events/${event.id}/respond`, { response: 'PENDING' })
      ).status(),
      422
    )
    const detail = await must<any>(await a.http.get(`/api/v1/calendar-events/${event.id}`), 200)
    assert.equal(
      detail.participants.find((p: any) => p.membershipId === ana.actor.membershipId).response,
      'ACCEPTED'
    )
    await must(
      await a.http.delete(`/api/v1/calendar-events/${event.id}/participants/${added.id}`),
      204
    )
    assert.equal(
      (
        await a.http.delete(`/api/v1/calendar-events/${event.id}/participants/${added.id}`)
      ).status(),
      404
    )
  })

  test('visibilidade: o calendário privado e os seus eventos são só do dono', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const peer = await memberWith(client, a, ['calendar.read', 'calendar.manage'])
    const mine = await must<any>(
      await a.http.post('/api/v1/calendars', {
        name: 'Só meu',
        timezone: 'Europe/Lisbon',
        visibility: 'PRIVATE',
      }),
      201
    )
    const event = await must<any>(
      await a.http.post('/api/v1/calendar-events', {
        calendarId: mine.id,
        title: 'Consulta privada',
        startsAt: '2032-04-01T10:00:00Z',
        endsAt: '2032-04-01T11:00:00Z',
      }),
      201
    )
    const window = ['2032-04-01T00:00:00Z', '2032-04-02T00:00:00Z'] as const
    assert.equal((await peer.http.get(`/api/v1/calendars/${mine.id}`)).status(), 404)
    assert.equal((await peer.http.get(`/api/v1/calendar-events/${event.id}`)).status(), 404)
    assert.isUndefined(
      (await listEvents(peer.http, ...window)).items.find((i) => i.eventId === event.id)
    )
    assert.isOk((await listEvents(a.http, ...window)).items.find((i) => i.eventId === event.id))
    assert.isUndefined(
      ((await peer.http.get('/api/v1/calendars')).body().data as any[]).find(
        (c) => c.id === mine.id
      )
    )
    const intrusion = await peer.http.post('/api/v1/calendar-events', {
      calendarId: mine.id,
      title: 'x',
      startsAt: '2032-04-01T10:00:00Z',
      endsAt: '2032-04-01T11:00:00Z',
    })
    assert.equal(intrusion.status(), 404)
    // Um calendário de unidade exige a unidade.
    const noUnit = await a.http.post('/api/v1/calendars', {
      name: 'Unidade',
      timezone: 'UTC',
      visibility: 'UNIT',
    })
    assert.equal(noUnit.status(), 422)
    // Apagar com eventos não é possível.
    const del = await a.http.delete(`/api/v1/calendars/${mine.id}`)
    assert.equal(del.status(), 409)
    assert.equal(del.body().error.code, 'CALENDAR_NOT_EMPTY')
  })

  test('um módulo cria e mantém o evento da sua origem sem o duplicar', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const resolved = await tenantServices().resolveTenantContext.execute({
      user: { id: a.admin.userId, locale: null },
      selector: { tenantId: a.tenant.id },
      correlationId: 'origem',
    })
    const context = resolved.context
    const sourceId = unique('turma-')
    const first = await calendarServices().events.upsertSourced(context, {
      calendarId: a.ids.calendar,
      title: 'Turma A',
      startsAt: '2032-05-03T09:00:00Z',
      endsAt: '2032-05-03T10:00:00Z',
      sourceType: 'formacao',
      sourceId,
    })
    const second = await calendarServices().events.upsertSourced(context, {
      calendarId: a.ids.calendar,
      title: 'Turma A (sala nova)',
      startsAt: '2032-05-03T14:00:00Z',
      endsAt: '2032-05-03T15:00:00Z',
      sourceType: 'formacao',
      sourceId,
    })
    assert.equal(second.id, first.id)
    assert.equal(second.title, 'Turma A (sala nova)')
    assert.equal(second.startsAt, '2032-05-03T14:00:00.000Z')
    assert.equal(
      (
        await owner<any>(
          `select count(*)::int as n from calendar_events where source_type = 'formacao' and source_id = '${sourceId}'`,
          a
        )
      )[0].n,
      1
    )
    await calendarServices().events.cancelSourced(context, 'formacao', sourceId)
    const detail = await must<any>(await a.http.get(`/api/v1/calendar-events/${first.id}`), 200)
    assert.equal(detail.status, 'CANCELLED')
  })
})

test.group('agenda | recursos e horário útil', (group) => {
  group.each.timeout(240_000)
  group.teardown(async () => {
    await deleteTestTenants()
    await deleteTestUsers()
  })

  test('recursos: código único, capacidade e organização válidas, apagar só sem reservas', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const room = await newResource(a.http, a, { code: unique('UNICO') })
    const codeTaken = await a.http.post('/api/v1/resources', {
      organizationId: a.ids.organization,
      code: (await must<any>(await a.http.get(`/api/v1/resources/${room.id}`), 200)).code,
      name: 'Repetida',
      type: 'ROOM',
    })
    assert.equal(codeTaken.status(), 409)
    assert.equal(codeTaken.body().error.code, 'RESOURCE_CODE_TAKEN')
    for (const [name, body] of [
      ['capacidade 0', { capacity: 0 }],
      ['capacidade decimal', { capacity: 1.5 }],
      ['tipo desconhecido', { type: 'JATO' }],
      ['organização de outro tenant', { organizationId: b.ids.organization }],
      ['unidade inexistente', { unitId: '00000000-0000-4000-8000-000000000000' }],
    ] as const) {
      const response = await a.http.post('/api/v1/resources', {
        organizationId: a.ids.organization,
        code: unique('V'),
        name: 'x',
        type: 'ROOM',
        ...body,
      })
      assert.equal(response.status(), 422, name)
    }
    const stale = await a.http.patch(`/api/v1/resources/${room.id}`, {
      version: 99,
      name: 'x',
      type: 'ROOM',
      capacity: 2,
    })
    assert.equal(stale.status(), 409)

    // Com reservas não se apaga: desactiva-se.
    const used = await newResource(a.http, a)
    const event = await newEvent(a.http, a, '2032-06-01T10:00:00Z', '2032-06-01T11:00:00Z')
    await must(await book(a.http, { eventId: event.id, resourceId: used.id }), 201)
    const refused = await a.http.delete(`/api/v1/resources/${used.id}`)
    assert.equal(refused.status(), 409)
    assert.equal(refused.body().error.code, 'RESOURCE_IN_USE')
    const free = await newResource(a.http, a)
    await must(await a.http.delete(`/api/v1/resources/${free.id}`), 204)
  })

  test('horário útil: soma só os períodos de trabalho, sem feriados', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const calendar = await must<any>(
      await a.http.post('/api/v1/business-calendars', {
        organizationId: a.ids.organization,
        name: unique('Horário '),
        timezone: 'Europe/Lisbon',
        weeklyWorkingHours: {
          mon: [
            ['09:00', '12:00'],
            ['13:00', '17:00'],
          ],
          tue: [['09:00', '17:00']],
        },
        holidays: [{ date: '2032-03-01', name: 'Feriado de teste' }],
      }),
      201
    )
    // Segunda 01/03 é feriado; terça 02/03 vale 8 h; segunda 08/03 vale 7 h.
    const minutes = async (from: string, to: string) =>
      (
        await must<any>(
          await a.http.get(
            `/api/v1/business-calendars/${calendar.id}/working-time?from=${from}&to=${to}`
          ),
          200
        )
      ).minutes
    assert.equal(await minutes('2032-02-28T00:00:00Z', '2032-03-03T00:00:00Z'), 8 * 60)
    assert.equal(await minutes('2032-03-08T00:00:00Z', '2032-03-09T00:00:00Z'), 7 * 60)
    assert.equal(await minutes('2032-03-06T00:00:00Z', '2032-03-08T00:00:00Z'), 0)

    const invalid = await a.http.post('/api/v1/business-calendars', {
      organizationId: a.ids.organization,
      name: unique('Mau '),
      timezone: 'Europe/Lisbon',
      weeklyWorkingHours: { mon: [['17:00', '09:00']] },
    })
    assert.equal(invalid.status(), 422)
    const duplicate = await a.http.post('/api/v1/business-calendars', {
      organizationId: a.ids.organization,
      name: calendar.name,
      timezone: 'UTC',
    })
    assert.equal(duplicate.status(), 409)
    const updated = await must<any>(
      await a.http.patch(`/api/v1/business-calendars/${calendar.id}`, {
        version: calendar.version,
        name: calendar.name,
        timezone: 'Europe/Lisbon',
        weeklyWorkingHours: { mon: [['09:00', '10:00']] },
        holidays: [],
      }),
      200
    )
    assert.equal(updated.version, calendar.version + 1)
    assert.equal(await minutes('2032-03-01T00:00:00Z', '2032-03-02T00:00:00Z'), 60)
    await must(await a.http.delete(`/api/v1/business-calendars/${calendar.id}`), 204)
  })

  test('isolamento: nada de B aparece em A nem se mexe por identificadores', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const bEvents = await listEvents(b.http, '2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z')
    const aEvents = await listEvents(a.http, '2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z')
    const bIds = new Set(bEvents.items.map((i) => i.eventId))
    assert.isTrue(aEvents.items.every((i) => !bIds.has(i.eventId)))
    assert.equal((await a.http.get(`/api/v1/resources/${b.ids.resource}`)).status(), 404)
    assert.equal(
      (await book(a.http, { eventId: a.ids.calendarEvent, resourceId: b.ids.resource })).status(),
      404
    )
  })
})
