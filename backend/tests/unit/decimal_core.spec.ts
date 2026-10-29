import { test } from '@japa/runner'
import { compareMoney, fromScaled, roundDiv, sumMoney, toScaled } from '#core/decimal/index'

test.group('núcleo decimal | aritmética exacta', () => {
  test('converte texto ↔ inteiro escalado sem perder casas e recusa excesso de casas', ({
    assert,
  }) => {
    assert.equal(toScaled('12.5', 4), 125_000n)
    assert.equal(fromScaled(125_000n, 4), '12.5000')
    assert.isNull(toScaled('1.23456', 4))
    assert.isNull(toScaled('abc', 4))
    assert.equal(fromScaled(-5n, 2), '-0.05')
  })

  test('arredonda a divisão: meio-para-cima ou meio-para-o-par', ({ assert }) => {
    assert.equal(roundDiv(5n, 2n, 'HALF_UP'), 3n)
    assert.equal(roundDiv(5n, 2n, 'HALF_EVEN'), 2n)
    assert.equal(roundDiv(7n, 2n, 'HALF_EVEN'), 4n)
    assert.equal(roundDiv(10n, 4n, 'HALF_UP'), 3n)
  })

  test('soma e compara dinheiro como texto, sem float', ({ assert }) => {
    assert.equal(sumMoney(['0.1', '0.2']), '0.3000')
    assert.equal(sumMoney(['100000', '40000.5']), '140000.5000')
    assert.isNull(sumMoney(['1', 'x']))
    assert.equal(compareMoney('1.0000', '1'), 0)
    assert.equal(compareMoney('1.0001', '1'), 1)
    assert.equal(compareMoney('0.9999', '1'), -1)
    assert.isNull(compareMoney('a', '1'))
  })
})
