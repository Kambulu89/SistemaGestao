import { test } from '@japa/runner'
import { checkPercents, distribute, HUNDRED } from '#modules/accounting/domain/analytics'

test.group('contabilidade | analítica (pura)', () => {
  test('percentagens: entre 0 e 100, até 4 casas, a somar exactamente 100', ({ assert }) => {
    assert.deepEqual(checkPercents(['33.3333', '33.3333', '33.3334']).issues, [])
    assert.equal(checkPercents(['50', '49.9999']).issues[0].code, 'NOT_100')
    assert.equal(checkPercents(['0', '100']).issues[0].code, 'INVALID_PERCENT')
    assert.equal(checkPercents(['100.00001']).issues[0].code, 'INVALID_PERCENT')
    assert.equal(checkPercents([100]).percents[0], HUNDRED)
  })

  test('repartição exacta: a soma das partes é o valor da linha (com sinal)', ({ assert }) => {
    const thirds = [333333n, 333333n, 333334n]
    const parts = distribute(100001n, thirds) // 1000,01 com 2 casas
    // 33333,633… / 33333,633… / 33334,033…: a unidade que sobra vai para a maior fracção (a primeira).
    assert.deepEqual(parts, [33334n, 33333n, 33334n])
    assert.equal(
      parts.reduce((a, b) => a + b, 0n),
      100001n
    )
    const negative = distribute(-100n, [500000n, 500000n])
    assert.deepEqual(negative, [-50n, -50n])
    // Restos iguais: a unidade que sobra vai para a primeira.
    assert.deepEqual(distribute(1n, [500000n, 500000n]), [1n, 0n])
    for (const amount of [1n, 7n, 99999n, 123456789n])
      assert.equal(
        distribute(amount, [123456n, 456789n, 419755n]).reduce((a, b) => a + b, 0n),
        amount
      )
  })
})
