import { test } from '@japa/runner'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test.group('saúde e prontidão', () => {
  test('GET /api/v1/health responde 200 no envelope comum com correlation id', async ({
    client,
    assert,
  }) => {
    const response = await client.get('/api/v1/health')

    response.assertStatus(200)
    const body = response.body()
    assert.strictEqual(body.data.status, 'ok')
    assert.match(body.meta.correlationId, UUID)
    assert.strictEqual(response.header('x-correlation-id'), body.meta.correlationId)
  })

  test('GET /api/v1/ready confirma base de dados e Redis', async ({ client, assert }) => {
    const response = await client.get('/api/v1/ready')

    response.assertStatus(200)
    assert.deepEqual(response.body().data, {
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    })
  })

  test('reutiliza um correlation id externo válido e substitui um inválido', async ({
    client,
    assert,
  }) => {
    const ok = await client.get('/api/v1/health').header('X-Correlation-Id', 'edge-request-0001')
    assert.strictEqual(ok.header('x-correlation-id'), 'edge-request-0001')
    assert.strictEqual(ok.body().meta.correlationId, 'edge-request-0001')

    const bad = await client.get('/api/v1/health').header('X-Correlation-Id', '<script>')
    assert.match(String(bad.header('x-correlation-id')), UUID)
  })

  test('não expõe dados de negócio, segredos nem versões de dependências', async ({
    client,
    assert,
  }) => {
    const response = await client.get('/api/v1/health')
    const text = JSON.stringify(response.body())
    for (const word of ['password', 'secret', 'postgres', 'tenant', 'version']) {
      assert.notInclude(text.toLowerCase(), word)
    }
  })
})
