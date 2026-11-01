import { test } from '@japa/runner'
import { REDACTED, redactSecrets } from '#core/audit/index'

test.group('auditoria | redacção', () => {
  test('redige chaves que parecem segredos, a qualquer profundidade', ({ assert }) => {
    const out = redactSecrets({
      email: 'a@exemplo.invalid',
      password: 'x',
      nested: { sessionToken: 't', list: [{ apiKey: 'k' }], ok: 1 },
      csrfToken: 'c',
      tokenHash: 'h',
    }) as Record<string, any>
    assert.strictEqual(out.email, 'a@exemplo.invalid')
    assert.strictEqual(out.password, REDACTED)
    assert.strictEqual(out.nested.sessionToken, REDACTED)
    assert.strictEqual(out.nested.list[0].apiKey, REDACTED)
    assert.strictEqual(out.nested.ok, 1)
    assert.strictEqual(out.csrfToken, REDACTED)
    assert.strictEqual(out.tokenHash, REDACTED)
  })

  test('chaves extra, limites de tamanho/profundidade e valores não JSON', ({ assert }) => {
    const out = redactSecrets({ identityNumber: '123', long: 'x'.repeat(600), fn: () => 1 }, [
      'identityNumber',
    ]) as Record<string, any>
    assert.strictEqual(out.identityNumber, REDACTED)
    assert.isBelow(out.long.length, 505)
    assert.notProperty(out, 'fn')
    let deep: Record<string, unknown> = { v: 1 }
    for (let i = 0; i < 10; i++) deep = { a: deep }
    assert.include(JSON.stringify(redactSecrets(deep)), 'TRUNCATED')
  })
})
