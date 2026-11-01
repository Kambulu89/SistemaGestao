import { test } from '@japa/runner'
import { CheckReadiness, type ReadinessProbe } from '#core/health/application/readiness'

const probe = (name: string, behaviour: () => Promise<void>): ReadinessProbe => ({
  name,
  check: behaviour,
})

test.group('CheckReadiness', () => {
  test('está pronto quando todas as dependências respondem', async ({ assert }) => {
    const result = await new CheckReadiness([
      probe('database', async () => {}),
      probe('redis', async () => {}),
    ]).execute()
    assert.isTrue(result.ready)
    assert.deepEqual(result.checks, [
      { name: 'database', ok: true },
      { name: 'redis', ok: true },
    ])
  })

  test('uma falha torna-o não pronto sem esconder as outras sondas', async ({ assert }) => {
    const result = await new CheckReadiness([
      probe('database', async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret')
      }),
      probe('redis', async () => {}),
    ]).execute()
    assert.isFalse(result.ready)
    assert.deepEqual(result.checks, [
      { name: 'database', ok: false },
      { name: 'redis', ok: true },
    ])
    // O resultado nunca transporta a mensagem interna do erro.
    assert.notInclude(JSON.stringify(result), 'secret')
    assert.notInclude(JSON.stringify(result), '10.0.0.5')
  })

  test('uma sonda que não responde a tempo conta como falha', async ({ assert }) => {
    const slow = probe('redis', () => new Promise<void>((resolve) => setTimeout(resolve, 500)))
    const result = await new CheckReadiness([slow], 30).execute()
    assert.isFalse(result.ready)
  })

  test('as sondas correm em paralelo', async ({ assert }) => {
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 80))
    const started = Date.now()
    await new CheckReadiness([probe('a', wait), probe('b', wait), probe('c', wait)]).execute()
    assert.isBelow(Date.now() - started, 200)
  })
})
