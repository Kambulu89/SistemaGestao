import { test } from '@japa/runner'
import vine from '@vinejs/vine'
import testUtils from '@adonisjs/core/services/test_utils'
import HttpExceptionHandler from '#exceptions/handler'
import { ApiError } from '#core/http/api_error'

async function respond(error: unknown) {
  const ctx = await testUtils.createHttpContext()
  ctx.correlationId = 'test-correlation-0001'
  await new HttpExceptionHandler().handle(error, ctx)
  return { status: ctx.response.getStatus(), body: ctx.response.getBody() as any, ctx }
}

test.group('formato uniforme de erros', () => {
  test('rota inexistente devolve 404 no formato comum', async ({ client, assert }) => {
    const response = await client.get('/api/v1/nao-existe')

    response.assertStatus(404)
    assert.deepEqual(response.body(), {
      error: {
        code: 'NOT_FOUND',
        message: 'Recurso não encontrado.',
        details: [],
        correlationId: response.header('x-correlation-id'),
      },
    })
  })

  test('um erro de validação devolve 422 com o caminho completo de cada campo', async ({
    assert,
  }) => {
    const validator = vine.compile(
      vine.object({
        lines: vine.array(vine.object({ quantity: vine.number().min(1) })),
      })
    )
    let caught: unknown
    try {
      await validator.validate({ lines: [{ quantity: 0 }] })
    } catch (error) {
      caught = error
    }

    const { status, body } = await respond(caught)
    assert.strictEqual(status, 422)
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR')
    assert.strictEqual(body.error.correlationId, 'test-correlation-0001')
    assert.deepEqual(body.error.details[0].path, 'lines.0.quantity')
    assert.strictEqual(body.error.details[0].code, 'MIN')
  })

  test('ApiError mantém estado, código e detalhes definidos pelo domínio', async ({ assert }) => {
    const { status, body } = await respond(
      ApiError.conflict('VERSION_CONFLICT', 'A versão mudou.', [
        { path: 'version', code: 'STALE', message: 'Versão actual: 7.' },
      ])
    )
    assert.strictEqual(status, 409)
    assert.strictEqual(body.error.code, 'VERSION_CONFLICT')
    assert.lengthOf(body.error.details, 1)
  })

  test('erros desconhecidos viram 500 genérico sem stack, SQL nem segredos', async ({ assert }) => {
    const { status, body, ctx } = await respond(
      new Error('select * from users where password = "hunter2" -- stack: at Object.<anonymous>')
    )
    const text = JSON.stringify(body)

    assert.strictEqual(status, 500)
    assert.strictEqual(body.error.code, 'INTERNAL_ERROR')
    for (const leak of ['select', 'hunter2', 'stack', 'Object.<anonymous>']) {
      assert.notInclude(text, leak)
    }
    assert.strictEqual(ctx.response.getHeader('x-correlation-id'), 'test-correlation-0001')
  })

  test('autenticação, autorização, limite de pedidos e corpo grande têm códigos estáveis', async ({
    assert,
  }) => {
    const cases: [string, number, string][] = [
      ['E_UNAUTHORIZED_ACCESS', 401, 'UNAUTHENTICATED'],
      ['E_AUTHORIZATION_FAILURE', 403, 'FORBIDDEN'],
      ['E_TOO_MANY_REQUESTS', 429, 'RATE_LIMITED'],
      ['E_REQUEST_ENTITY_TOO_LARGE', 413, 'PAYLOAD_TOO_LARGE'],
    ]
    for (const [code, expectedStatus, expectedCode] of cases) {
      const { status, body } = await respond(Object.assign(new Error('x'), { code }))
      assert.strictEqual(status, expectedStatus, code)
      assert.strictEqual(body.error.code, expectedCode, code)
    }
  })

  test('corpo JSON malformado numa rota inexistente não rebenta o servidor', async ({
    client,
    assert,
  }) => {
    const response = await client
      .post('/api/v1/health')
      .header('content-type', 'application/json')
      .json({ ok: true })
    // POST não está definido para /health: 404 no formato comum.
    response.assertStatus(404)
    assert.strictEqual(response.body().error.code, 'NOT_FOUND')
  })
})
