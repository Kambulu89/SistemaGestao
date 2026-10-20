import { test } from '@japa/runner'
import { resolveCorrelationId } from '#core/http/correlation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test.group('correlation id', () => {
  test('gera um UUID quando o pedido não traz nenhum', ({ assert }) => {
    assert.match(resolveCorrelationId(undefined), UUID)
    assert.match(resolveCorrelationId(''), UUID)
  })

  test('reutiliza um valor externo bem formado', ({ assert }) => {
    assert.strictEqual(resolveCorrelationId('req-12345678'), 'req-12345678')
    const id = '6f1c2f36-7e0b-4f3a-9a53-0a6a7b2f9d10'
    assert.strictEqual(resolveCorrelationId(id), id)
  })

  test('substitui valores curtos, longos ou com caracteres perigosos', ({ assert }) => {
    for (const bad of [
      'abc',
      'x'.repeat(65),
      'id com espaços',
      'id\r\nSet-Cookie: a=b',
      '<script>alert(1)</script>',
      '../../etc/passwd',
    ]) {
      assert.match(resolveCorrelationId(bad), UUID, bad)
    }
  })

  test('cada geração é diferente', ({ assert }) => {
    assert.notStrictEqual(resolveCorrelationId(undefined), resolveCorrelationId(undefined))
  })
})
