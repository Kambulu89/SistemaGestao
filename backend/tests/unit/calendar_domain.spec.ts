import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  expand,
  formatRule,
  overlaps,
  parseRule,
  validateHolidays,
  validateRange,
  validateTimes,
  validateWorkingHours,
  workingMinutes,
  type Series,
} from '#modules/calendar/domain/calendar'
import {
  isGenuineOccurrence,
  occurrencesBefore,
  resolveOccurrences,
} from '#modules/calendar/application/occurrences'
import type { EventRecord, ExceptionRecord } from '#modules/calendar/application/ports'

const iso = (d: Date, zone = 'UTC') =>
  DateTime.fromJSDate(d, { zone }).toFormat("yyyy-MM-dd'T'HH:mm")
const at = (text: string, zone: string) => DateTime.fromISO(text, { zone }).toJSDate()

const series = (over: Omit<Partial<Series>, 'rule'> & { rule: string | null }): Series => {
  const parsed = over.rule ? parseRule(over.rule) : null
  if (parsed && 'error' in parsed) throw new Error(parsed.error)
  return {
    startsAt: over.startsAt ?? at('2026-03-23T10:00', 'Europe/Lisbon'),
    endsAt: over.endsAt ?? at('2026-03-23T11:00', 'Europe/Lisbon'),
    timezone: over.timezone ?? 'Europe/Lisbon',
    allDay: over.allDay ?? false,
    rule: parsed && 'rule' in parsed ? parsed.rule : null,
  }
}

const event = (s: Series, id = 'e1'): EventRecord => ({
  id,
  calendarId: 'c1',
  title: 'Reunião',
  description: null,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  timezone: s.timezone,
  allDay: s.allDay,
  recurrenceRule: s.rule ? formatRule(s.rule) : null,
  status: 'CONFIRMED',
  sourceType: null,
  sourceId: null,
  createdByMembershipId: null,
  version: 1,
  createdAt: new Date(),
})

test.group('calendário: regras de repetição', () => {
  test('aceita o subconjunto e recusa o resto em vez de o ignorar', ({ assert }) => {
    assert.property(parseRule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10'), 'rule')
    assert.property(parseRule('FREQ=DAILY;INTERVAL=2;UNTIL=20261231'), 'rule')
    for (const bad of [
      '',
      'FREQ=HOURLY',
      'FREQ=DAILY;BYMONTH=3',
      'FREQ=DAILY;COUNT=2;UNTIL=20261231',
      'FREQ=DAILY;COUNT=0',
      'FREQ=DAILY;COUNT=1001',
      'FREQ=DAILY;INTERVAL=0',
      'FREQ=DAILY;BYDAY=MO',
      'FREQ=WEEKLY;BYDAY=XX',
      'FREQ=DAILY;FREQ=DAILY',
      `FREQ=DAILY;${'X'.repeat(500)}`,
    ]) {
      assert.property(parseRule(bad), 'error', bad)
    }
  })

  test('formatar e voltar a ler dá a mesma regra', ({ assert }) => {
    const parsed = parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO;COUNT=6')
    assert.property(parsed, 'rule')
    if ('rule' in parsed) {
      const text = formatRule(parsed.rule)
      assert.equal(text, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=6')
      assert.deepEqual(parseRule(text), parsed.rule ? { rule: parsed.rule } : parsed)
    }
  })
})

test.group('calendário: ocorrências e fusos', () => {
  test('uma reunião às 10:00 continua às 10:00 quando o relógio muda, com a mesma duração', ({
    assert,
  }) => {
    // Lisboa muda para a hora de verão em 29/03/2026 (de UTC+0 para UTC+1).
    const s = series({ rule: 'FREQ=WEEKLY;COUNT=3' })
    const found = expand(s, at('2026-03-01T00:00', 'UTC'), at('2026-06-01T00:00', 'UTC'))
    assert.deepEqual(
      found.map((o) => iso(o.startsAt, 'Europe/Lisbon')),
      ['2026-03-23T10:00', '2026-03-30T10:00', '2026-04-06T10:00']
    )
    // 10:00 de Lisboa são 10:00Z antes da mudança e 09:00Z depois.
    assert.deepEqual(
      found.map((o) => iso(o.startsAt, 'UTC')),
      ['2026-03-23T10:00', '2026-03-30T09:00', '2026-04-06T09:00']
    )
    for (const o of found) assert.equal(o.endsAt.getTime() - o.startsAt.getTime(), 3_600_000)
  })

  test('um evento de uma hora conserva a duração ao mudar de fuso', ({ assert }) => {
    const s = series({ rule: null })
    const ny = DateTime.fromJSDate(s.startsAt, { zone: 'America/New_York' })
    const end = DateTime.fromJSDate(s.endsAt, { zone: 'America/New_York' })
    assert.equal(end.diff(ny, 'minutes').minutes, 60)
    // E ao editar no outro fuso (mesmos instantes) nada muda na série.
    const moved = series({
      rule: null,
      startsAt: ny.toJSDate(),
      endsAt: end.toJSDate(),
      timezone: 'America/New_York',
    })
    const [only] = expand(moved, at('2026-03-01T00:00', 'UTC'), at('2026-06-01T00:00', 'UTC'))
    assert.equal(only?.endsAt.getTime() - (only?.startsAt.getTime() ?? 0), 3_600_000)
    assert.equal(only?.startsAt.getTime(), s.startsAt.getTime())
  })

  test('hora que não existe avança; a duração decorrida mantém-se', ({ assert }) => {
    // 29/03/2026 01:30 não existe em Lisboa (01:00 salta para 02:00).
    const s = series({
      rule: 'FREQ=DAILY;COUNT=3',
      startsAt: at('2026-03-27T01:30', 'Europe/Lisbon'),
      endsAt: at('2026-03-27T02:30', 'Europe/Lisbon'),
    })
    const found = expand(s, at('2026-03-01T00:00', 'UTC'), at('2026-06-01T00:00', 'UTC'))
    assert.equal(found.length, 3)
    assert.equal(iso(found[2]?.startsAt as Date, 'Europe/Lisbon'), '2026-03-29T02:30')
    for (const o of found) assert.equal(o.endsAt.getTime() - o.startsAt.getTime(), 3_600_000)
  })

  test('semanal com BYDAY, intervalo, COUNT e UNTIL', ({ assert }) => {
    const weekly = series({
      rule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5',
      timezone: 'UTC',
      startsAt: at('2026-03-23T09:00', 'UTC'),
      endsAt: at('2026-03-23T09:30', 'UTC'),
    })
    const all = expand(weekly, at('2026-01-01T00:00', 'UTC'), at('2027-01-01T00:00', 'UTC'))
    assert.deepEqual(
      all.map((o) => iso(o.startsAt)),
      [
        '2026-03-23T09:00',
        '2026-03-25T09:00',
        '2026-03-30T09:00',
        '2026-04-01T09:00',
        '2026-04-06T09:00',
      ]
    )
    const until = series({
      rule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260327',
      timezone: 'UTC',
      startsAt: at('2026-03-23T09:00', 'UTC'),
      endsAt: at('2026-03-23T10:00', 'UTC'),
    })
    assert.deepEqual(
      expand(until, at('2026-01-01T00:00', 'UTC'), at('2027-01-01T00:00', 'UTC')).map((o) =>
        iso(o.startsAt)
      ),
      ['2026-03-23T09:00', '2026-03-25T09:00', '2026-03-27T09:00']
    )
  })

  test('o COUNT conta desde o início da série, mesmo que a janela comece mais tarde', ({
    assert,
  }) => {
    const s = series({
      rule: 'FREQ=DAILY;COUNT=4',
      timezone: 'UTC',
      startsAt: at('2026-03-23T09:00', 'UTC'),
      endsAt: at('2026-03-23T10:00', 'UTC'),
    })
    const found = expand(s, at('2026-03-25T00:00', 'UTC'), at('2027-01-01T00:00', 'UTC'))
    assert.deepEqual(
      found.map((o) => iso(o.startsAt)),
      ['2026-03-25T09:00', '2026-03-26T09:00']
    )
  })

  test('mensal no dia 31 salta os meses sem esse dia', ({ assert }) => {
    const s = series({
      rule: 'FREQ=MONTHLY;COUNT=4',
      timezone: 'UTC',
      startsAt: at('2026-01-31T09:00', 'UTC'),
      endsAt: at('2026-01-31T10:00', 'UTC'),
    })
    const found = expand(s, at('2026-01-01T00:00', 'UTC'), at('2027-01-01T00:00', 'UTC'))
    assert.deepEqual(
      found.map((o) => iso(o.startsAt)),
      ['2026-01-31T09:00', '2026-03-31T09:00', '2026-05-31T09:00', '2026-07-31T09:00']
    )
  })

  test('dia inteiro conta em dias e começa à meia-noite local', ({ assert }) => {
    const s = series({
      rule: 'FREQ=WEEKLY;COUNT=2',
      allDay: true,
      startsAt: at('2026-03-23T00:00', 'Europe/Lisbon'),
      endsAt: at('2026-03-25T00:00', 'Europe/Lisbon'),
    })
    const found = expand(s, at('2026-01-01T00:00', 'UTC'), at('2027-01-01T00:00', 'UTC'))
    assert.deepEqual(
      found.map((o) => [iso(o.startsAt, 'Europe/Lisbon'), iso(o.endsAt, 'Europe/Lisbon')]),
      [
        ['2026-03-23T00:00', '2026-03-25T00:00'],
        ['2026-03-30T00:00', '2026-04-01T00:00'],
      ]
    )
  })

  test('intervalos [início, fim): adjacentes não se sobrepõem', ({ assert }) => {
    const a = at('2026-03-23T10:00', 'UTC')
    const b = at('2026-03-23T11:00', 'UTC')
    const c = at('2026-03-23T12:00', 'UTC')
    assert.isFalse(overlaps(a, b, b, c))
    assert.isTrue(overlaps(a, c, b, c))
  })
})

test.group('calendário: excepções', () => {
  const s = series({
    rule: 'FREQ=DAILY;COUNT=5',
    timezone: 'UTC',
    startsAt: at('2026-03-23T09:00', 'UTC'),
    endsAt: at('2026-03-23T10:00', 'UTC'),
  })
  const ev = event(s)
  const exception = (
    kind: 'CANCELLED' | 'MODIFIED',
    start: string,
    over: Partial<ExceptionRecord> = {}
  ): ExceptionRecord => ({
    id: start,
    eventId: 'e1',
    occurrenceStart: at(start, 'UTC'),
    kind,
    title: null,
    startsAt: null,
    endsAt: null,
    ...over,
  })
  const window = [at('2026-03-01T00:00', 'UTC'), at('2026-05-01T00:00', 'UTC')] as const

  test('uma ocorrência cancelada nunca reaparece, mesmo com a janela deslocada', ({ assert }) => {
    const cancelled = [exception('CANCELLED', '2026-03-25T09:00')]
    for (const [from, to] of [
      window,
      [at('2026-03-25T08:00', 'UTC'), at('2026-03-25T12:00', 'UTC')],
      [at('2026-03-24T00:00', 'UTC'), at('2026-03-27T00:00', 'UTC')],
    ] as const) {
      const got = resolveOccurrences(ev, cancelled, from, to).map((o) => iso(o.startsAt))
      assert.notInclude(got, '2026-03-25T09:00')
    }
    assert.equal(resolveOccurrences(ev, cancelled, ...window).length, 4)
  })

  test('uma ocorrência alterada aparece onde foi posta (e só aí)', ({ assert }) => {
    const modified = [
      exception('MODIFIED', '2026-03-25T09:00', {
        title: 'Adiada',
        startsAt: at('2026-04-20T15:00', 'UTC'),
        endsAt: at('2026-04-20T16:00', 'UTC'),
      }),
    ]
    const got = resolveOccurrences(ev, modified, ...window)
    assert.equal(got.length, 5)
    assert.isUndefined(got.find((o) => iso(o.startsAt) === '2026-03-25T09:00'))
    const moved = got.find((o) => o.modified)
    assert.equal(moved?.title, 'Adiada')
    assert.equal(iso(moved?.startsAt as Date), '2026-04-20T15:00')
    // Uma janela que só apanha o novo lugar também a vê.
    assert.equal(
      resolveOccurrences(ev, modified, at('2026-04-20T00:00', 'UTC'), at('2026-04-21T00:00', 'UTC'))
        .length,
      1
    )
  })

  test('só é ocorrência o que a regra gera; contam-se as anteriores', ({ assert }) => {
    assert.isTrue(isGenuineOccurrence(ev, at('2026-03-26T09:00', 'UTC')))
    assert.isFalse(isGenuineOccurrence(ev, at('2026-03-26T09:30', 'UTC')))
    assert.isFalse(isGenuineOccurrence(ev, at('2026-04-26T09:00', 'UTC')))
    assert.equal(occurrencesBefore(ev, at('2026-03-26T09:00', 'UTC')), 3)
  })
})

test.group('calendário: validação', () => {
  test('intervalos e fusos inválidos são recusados com o caminho do campo', ({ assert }) => {
    const bad = validateTimes({
      startsAt: '2026-03-23T11:00:00Z',
      endsAt: '2026-03-23T10:00:00Z',
      timezone: 'Mars/Olympus',
      allDay: false,
      recurrenceRule: 'FREQ=NOPE',
    })
    assert.property(bad, 'issues')
    if ('issues' in bad)
      assert.sameMembers(
        bad.issues.map((i) => i.path),
        ['endsAt', 'timezone', 'recurrenceRule']
      )
    const empty = validateTimes({
      startsAt: '2026-03-23T10:00:00Z',
      endsAt: '2026-03-23T10:00:00Z',
      timezone: 'UTC',
      allDay: false,
      recurrenceRule: null,
    })
    assert.property(empty, 'issues')
    assert.property(
      validateTimes({
        startsAt: '2026-03-23T10:00:00Z',
        endsAt: '2026-03-23T11:00:00Z',
        timezone: 'Europe/Lisbon',
        allDay: false,
        recurrenceRule: 'FREQ=DAILY;COUNT=3',
      }),
      'value'
    )
  })

  test('as consultas têm intervalo obrigatório e limitado', ({ assert }) => {
    assert.property(validateRange('x', 'y'), 'issue')
    assert.property(validateRange('2026-03-23T10:00:00Z', '2026-03-23T09:00:00Z'), 'issue')
    assert.property(validateRange('2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z'), 'issue')
    assert.property(validateRange('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'), 'from')
  })
})

test.group('calendário: horário útil', () => {
  const hours = validateWorkingHours({
    mon: [
      ['09:00', '12:00'],
      ['13:00', '17:00'],
    ],
    tue: [['09:00', '17:00']],
    wed: [['09:00', '17:00']],
    thu: [['09:00', '17:00']],
    fri: [['09:00', '17:00']],
  })
  const holidays = validateHolidays([{ date: '2026-03-25', name: 'Dia livre' }])

  test('valida horários e feriados', ({ assert }) => {
    assert.property(hours, 'value')
    assert.property(holidays, 'value')
    assert.property(validateWorkingHours({ mon: [['17:00', '09:00']] }), 'issues')
    assert.property(
      validateWorkingHours({
        mon: [
          ['09:00', '12:00'],
          ['11:00', '13:00'],
        ],
      }),
      'issues'
    )
    assert.property(validateWorkingHours({ xxx: [] }), 'issues')
    assert.property(validateHolidays([{ date: '2026-02-30', name: 'x' }]), 'issues')
    assert.property(
      validateHolidays([
        { date: '2026-03-25', name: 'a' },
        { date: '2026-03-25', name: 'b' },
      ]),
      'issues'
    )
  })

  test('conta só os períodos úteis, sem feriados', ({ assert }) => {
    if (!('value' in hours) || !('value' in holidays)) throw new Error('horário inválido')
    const calendar = { timezone: 'Europe/Lisbon', hours: hours.value, holidays: holidays.value }
    // Segunda 23/03 (7 h), terça 24/03 (8 h), quarta 25/03 feriado, quinta 26/03 (8 h).
    assert.equal(
      workingMinutes(
        calendar,
        at('2026-03-23T00:00', 'Europe/Lisbon'),
        at('2026-03-27T00:00', 'Europe/Lisbon')
      ),
      (7 + 8 + 8) * 60
    )
    // Fim de semana: nada.
    assert.equal(
      workingMinutes(
        calendar,
        at('2026-03-28T00:00', 'Europe/Lisbon'),
        at('2026-03-30T00:00', 'Europe/Lisbon')
      ),
      0
    )
    // Janela parcial dentro de um período.
    assert.equal(
      workingMinutes(
        calendar,
        at('2026-03-23T11:00', 'Europe/Lisbon'),
        at('2026-03-23T14:00', 'Europe/Lisbon')
      ),
      60 + 60
    )
    assert.equal(
      workingMinutes(
        calendar,
        at('2026-03-27T00:00', 'Europe/Lisbon'),
        at('2026-03-23T00:00', 'Europe/Lisbon')
      ),
      0
    )
  })
})
