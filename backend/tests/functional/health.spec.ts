import { test } from '@japa/runner'

test.group('saúde', () => {
  test('GET /api/v1/health confirma a API e a base de dados', async ({ client }) => {
    const response = await client.get('/api/v1/health')
    response.assertStatus(200)
    response.assertBody({ status: 'ok', database: 'up' })
  })
})
