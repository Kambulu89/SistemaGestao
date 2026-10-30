import { test } from '@japa/runner'
import {
  MAX_ATTEMPTS,
  afterFailure,
  backoffMs,
  conditionVariables,
  eventDedupeKey,
  normalizeAutomation,
  referencesOf,
  resolveParams,
  scheduleDedupeKey,
  textParamIssues,
  type AutomationIssue,
} from '#dynamic/automations/domain/automation'
import { nextFire, parseCron, tooFrequent } from '#dynamic/automations/domain/cron'

const spec = (expression: string) => {
  const parsed = parseCron(expression)
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}
const iso = (date: Date | null) => date?.toISOString() ?? null

const codes = (input: Record<string, unknown>) => {
  const issues: AutomationIssue[] = []
  normalizeAutomation(input, { timezone: 'Africa/Luanda' }, issues)
  return issues.map((i) => `${i.path}:${i.code}`)
}
const action = {
  type: 'dynamic.record.transition',
  params: { recordId: { from: 'payload.recordId' } },
}

test.group('automações | calendário', () => {
  test('lê listas, intervalos e passos; recusa o que não é um calendário', ({ assert }) => {
    assert.deepEqual([...spec('0,30 9-11 * * 1-5').minutes], [0, 30])
    assert.deepEqual([...spec('0,30 9-11 * * 1-5').hours], [9, 10, 11])
    assert.deepEqual([...spec('*/20 * * * *').minutes], [0, 20, 40])
    assert.deepEqual([...spec('0 0 * * 7').daysOfWeek], [0], '7 é domingo')
    for (const bad of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '*/0 * * * *',
      'a * * * *',
      '5-1 * * * *',
    ]) {
      assert.isString(parseCron(bad), bad)
    }
  })

  test('calcula a próxima execução no fuso horário (e não em UTC)', ({ assert }) => {
    // Luanda é UTC+1 todo o ano: 09:00 locais são 08:00 UTC.
    assert.equal(
      iso(nextFire(spec('0 9 * * *'), 'Africa/Luanda', new Date('2026-10-23T07:00:00Z'))),
      '2026-10-23T08:00:00.000Z'
    )
    assert.equal(
      iso(nextFire(spec('0 9 * * *'), 'Africa/Luanda', new Date('2026-10-23T08:00:00Z'))),
      '2026-10-24T08:00:00.000Z',
      'estritamente posterior'
    )
    assert.equal(
      iso(nextFire(spec('0 9 * * *'), 'UTC', new Date('2026-10-23T08:00:00Z'))),
      '2026-10-23T09:00:00.000Z'
    )
  })

  test('dias úteis, dia do mês e dia da semana em conjunto', ({ assert }) => {
    // 24/10/2026 é sábado: o próximo dia útil às 09:00 é segunda 26.
    assert.equal(
      iso(nextFire(spec('0 9 * * 1-5'), 'UTC', new Date('2026-10-24T10:00:00Z'))),
      '2026-10-26T09:00:00.000Z'
    )
    assert.equal(
      iso(nextFire(spec('0 0 1 * *'), 'UTC', new Date('2026-10-23T00:00:00Z'))),
      '2026-11-01T00:00:00.000Z'
    )
    // Com dia do mês e dia da semana restritos basta um deles.
    assert.equal(
      iso(nextFire(spec('0 0 13 * 5'), 'UTC', new Date('2026-10-23T00:00:00Z'))),
      '2026-10-30T00:00:00.000Z'
    )
    assert.isNull(
      nextFire(spec('0 0 30 2 *'), 'UTC', new Date('2026-01-01T00:00:00Z')),
      '30 de Fevereiro nunca existe'
    )
  })

  test('a mudança de hora não duplica nem inventa execuções', ({ assert }) => {
    // Em Lisboa a hora 01:30 de 2026-03-29 não existe (01:00 → 02:00).
    const next = nextFire(spec('30 1 * * *'), 'Europe/Lisbon', new Date('2026-03-28T12:00:00Z'))
    assert.equal(iso(next), '2026-03-30T00:30:00.000Z')
  })

  test('recusa calendários mais frequentes que cinco minutos', ({ assert }) => {
    assert.isTrue(tooFrequent(spec('* * * * *'), 'UTC'))
    assert.isTrue(tooFrequent(spec('*/2 * * * *'), 'UTC'))
    assert.isFalse(tooFrequent(spec('*/5 * * * *'), 'UTC'))
    assert.isFalse(tooFrequent(spec('0 9 * * 1-5'), 'UTC'))
  })
})

test.group('automações | definição', () => {
  test('exige exactamente um gatilho', ({ assert }) => {
    assert.include(codes({ actions: [action] }), 'trigger:TRIGGER_EXACTLY_ONE')
    assert.include(
      codes({ eventType: 'a.b', schedule: '0 9 * * *', actions: [action] }),
      'trigger:TRIGGER_EXACTLY_ONE'
    )
    assert.deepEqual(codes({ eventType: 'dynamic.record.state_changed', actions: [action] }), [])
    assert.deepEqual(codes({ schedule: '0 9 * * *', actions: [action] }), [])
  })

  test('valida fuso, calendário, limite, condição e parâmetros', ({ assert }) => {
    assert.include(
      codes({ schedule: '0 9 * * *', timezone: 'Marte/Olimpo', actions: [action] }),
      'timezone:INVALID_TIMEZONE'
    )
    assert.include(
      codes({ schedule: '* * * * *', actions: [action] }),
      'schedule:SCHEDULE_TOO_FREQUENT'
    )
    assert.include(codes({ schedule: 'x', actions: [action] }), 'schedule:INVALID_SCHEDULE')
    assert.include(
      codes({ eventType: 'a.b', maxRunsPerPeriod: 0, actions: [action] }),
      'maxRunsPerPeriod:INVALID_LIMIT'
    )
    assert.include(
      codes({ eventType: 'a.b', condition: 'true', actions: [action] }),
      'condition:INVALID_CONDITION'
    )
    assert.include(codes({ eventType: 'a.b', actions: [] }), 'actions:INVALID_ACTIONS')
    assert.include(
      codes({ eventType: 'a.b', actions: [{ type: 'a.b', params: { x: { from: 'sql.drop' } } }] }),
      'actions[0].params.x:INVALID_PARAM'
    )
    assert.include(
      codes({ eventType: 'a.b', actions: [{ type: 'a.b', params: { x: ['lista'] } }] }),
      'actions[0].params.x:INVALID_PARAM'
    )
    assert.include(
      codes({ eventType: 'a.b', actions: [{ type: 'a.b', codigo: 'eval' }] }),
      'actions[0].codigo:UNKNOWN_KEY'
    )
  })

  test('resolve referências ao evento e falha se faltarem', ({ assert }) => {
    const params = { recordId: { from: 'payload.recordId' }, transition: 'concluir', n: 3 }
    assert.deepEqual(resolveParams(params, { payload: { recordId: 'r1' }, scheduledFor: null }), {
      recordId: 'r1',
      transition: 'concluir',
      n: 3,
    })
    assert.throws(() => resolveParams(params, { payload: {}, scheduledFor: null }), /recordId/)
    assert.throws(
      () => resolveParams(params, { payload: { recordId: { x: 1 } }, scheduledFor: null }),
      /recordId/
    )
    assert.deepEqual(
      resolveParams(
        { at: { from: 'schedule.at' } },
        { payload: {}, scheduledFor: new Date('2026-10-23T08:00:00Z') }
      ),
      { at: '2026-10-23T08:00:00.000Z' }
    )
    assert.throws(() =>
      resolveParams({ at: { from: 'schedule.at' } }, { payload: {}, scheduledFor: null })
    )
    assert.deepEqual(referencesOf(params), ['payload.recordId'])
  })

  test('lê as variáveis de uma condição e valida parâmetros de texto', ({ assert }) => {
    assert.deepEqual(
      conditionVariables({ op: 'eq', left: { var: 'resource.toState' }, right: { value: 'x' } }),
      ['resource.toState']
    )
    const issues = textParamIssues({ a: 'x', c: 4 }, ['a', 'b'], [])
    assert.sameMembers(
      issues.map((i) => i.code),
      ['PARAM_REQUIRED', 'UNKNOWN_PARAM']
    )
  })
})

test.group('automações | deduplicação e falhas', () => {
  test('as chaves identificam evento+automação+versão e o instante agendado', ({ assert }) => {
    assert.equal(eventDedupeKey('e1', 'a1', 3), 'event:e1:a1:v3')
    assert.notEqual(eventDedupeKey('e1', 'a1', 3), eventDedupeKey('e1', 'a1', 4))
    assert.equal(
      scheduleDedupeKey('a1', new Date('2026-10-23T08:00:00Z')),
      'sched:a1:2026-10-23T08:00:00.000Z'
    )
  })

  test('o recuo é exponencial, limitado e com variação', ({ assert }) => {
    const fixed = (v: number) => () => v
    assert.equal(backoffMs(1, fixed(0.5)), 30_000)
    assert.equal(backoffMs(2, fixed(0.5)), 60_000)
    assert.equal(backoffMs(3, fixed(0.5)), 120_000)
    assert.equal(backoffMs(20, fixed(0.5)), 3_600_000)
    assert.equal(backoffMs(1, fixed(0)), 24_000)
    assert.equal(backoffMs(1, fixed(1)), 36_000)
  })

  test('depois do limite de tentativas a execução vai para a fila de falhas', ({ assert }) => {
    assert.equal(afterFailure(1), 'RETRY')
    assert.equal(afterFailure(MAX_ATTEMPTS - 1), 'RETRY')
    assert.equal(afterFailure(MAX_ATTEMPTS), 'DEAD')
  })
})
