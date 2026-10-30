import { Writable } from 'node:stream'
import pino from 'pino'
import { test } from '@japa/runner'
import { REDACTED_PATHS } from '#config/logger'

function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })
  const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } }, stream)
  return { logger, output: () => lines.join('') }
}

test.group('logs sem dados sensíveis', () => {
  test('palavras-passe, tokens, segredos e cookies são redigidos', ({ assert }) => {
    const { logger, output } = capture()
    logger.info(
      {
        password: 'hunter2',
        user: { password: 'hunter3', token: 'tok-123' },
        headers: { authorization: 'Bearer abc.def', cookie: 'session=xyz' },
        req: { headers: { authorization: 'Bearer req-secret', cookie: 'c=req-cookie' } },
        integration: { apiKey: 'key-777', secret: 'shh' },
        body: {
          currentPassword: 'old-pass-xyz',
          newPassword: 'new-pass-xyz',
          csrfToken: 'csrf-xyz',
        },
        sessionToken: 'sess-xyz',
      },
      'pedido'
    )
    const text = output()
    for (const secret of [
      'hunter2',
      'hunter3',
      'tok-123',
      'abc.def',
      'session=xyz',
      'req-secret',
      'req-cookie',
      'key-777',
      'old-pass-xyz',
      'new-pass-xyz',
      'csrf-xyz',
      'sess-xyz',
      'shh',
    ]) {
      assert.notInclude(text, secret)
    }
    assert.include(text, '[REDACTED]')
  })

  test('mantém o que serve para diagnosticar', ({ assert }) => {
    const { logger, output } = capture()
    logger.info({ correlationId: 'abc-12345', route: '/api/v1/health', status: 200 }, 'ok')
    for (const kept of ['abc-12345', '/api/v1/health', '200']) assert.include(output(), kept)
  })
})
