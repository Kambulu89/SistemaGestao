import { test } from '@japa/runner'
import {
  awardLineIssues,
  decideBlockedBy,
  normalizeQuality,
  normalizeWeights,
  type Offer,
  scoreOffers,
  toBase6,
  toBaseCents,
} from '#modules/procurement/domain/awards'

const offer = (
  id: string,
  line: string,
  sup: string,
  price: bigint | null,
  extra: Partial<Offer> = {}
): Offer => ({
  id,
  rfqLineId: line,
  supplierId: sup,
  alternativeNo: 0,
  unitPriceBase: price,
  deliveryDays: null,
  paymentDays: null,
  ...extra,
})
const P = (v: number) => BigInt(Math.round(v * 1_000_000))

test.group('Compras | comparação e adjudicação: regras', () => {
  test('pesos: inteiros de 0 a 100 que somam 100; por omissão 60/20/20/0', ({ assert }) => {
    assert.deepEqual(normalizeWeights(undefined), {
      weights: { price: 60, delivery: 20, quality: 20, payment: 0 },
      issues: [],
    })
    assert.deepEqual(
      normalizeWeights({ price: 40, delivery: 30, quality: 20, payment: 10 }).issues,
      []
    )
    assert.equal(normalizeWeights({ price: 99 }).issues[0].code, 'WEIGHTS_SUM')
    assert.equal(normalizeWeights({ price: 100.5 }).issues[0].code, 'INVALID')
    assert.equal(normalizeWeights({ price: -10, delivery: 110 }).issues[0].code, 'INVALID')
  })

  test('notas de qualidade só de fornecedores com proposta, inteiras de 0 a 100', ({ assert }) => {
    const r = normalizeQuality({ a: 80, b: 101, c: 50, d: '' }, new Set(['a', 'b']))
    assert.deepEqual([...r.quality], [['a', 80]])
    assert.deepEqual(
      r.issues.map((i) => i.code),
      ['INVALID', 'NOT_FOUND']
    )
  })

  test('moeda normalizada: preço e cêntimos ao câmbio com 10 casas', ({ assert }) => {
    assert.equal(toBase6(P(0.9), 900n * 10n ** 10n), P(810))
    assert.equal(toBaseCents(140n, 900n * 10n ** 10n), 126_000n)
    // 1 EUR = 1 012,3456789012 AOA → 12,35 EUR = 12 502,27 AOA (meio para cima).
    assert.equal(toBaseCents(1235n, 10_123_456_789_012n), 1_250_247n)
  })

  test('pontuação por linha: preço relativo, entrega e pagamento relativos, qualidade, total ponderado e a melhor', ({
    assert,
  }) => {
    const offers = [
      offer('a', 'L1', 'S1', P(1000), { deliveryDays: 10, paymentDays: 30 }),
      offer('b', 'L1', 'S2', P(900), { deliveryDays: 20, paymentDays: 30 }),
      offer('c', 'L1', 'S3', P(950), { deliveryDays: 5, paymentDays: 60 }),
      offer('d', 'L1', 'S4', null),
      offer('e', 'L2', 'S1', P(0)),
    ]
    const s = scoreOffers(
      offers,
      { price: 60, delivery: 20, quality: 20, payment: 0 },
      new Map([
        ['S1', 80],
        ['S2', 70],
        ['S3', 90],
      ])
    )
    assert.deepEqual(s.get('a'), {
      price: 90,
      delivery: 54.55,
      quality: 80,
      payment: 50.82,
      total: 80.91,
      best: false,
    })
    assert.deepInclude(s.get('c')!, { price: 94.74, delivery: 100, total: 94.84, best: true })
    assert.isNull(s.get('d'))
    // Preço zero numa linha só com essa oferta: 100; sem prazos indicados: 0.
    assert.deepInclude(s.get('e')!, { price: 100, delivery: 0, best: true })
  })

  test('empate no total: ganha o preço mais baixo, depois a principal', ({ assert }) => {
    const w = { price: 0, delivery: 0, quality: 100, payment: 0 }
    const s = scoreOffers(
      [
        offer('x', 'L', 'S1', P(10)),
        offer('y', 'L', 'S2', P(9), { alternativeNo: 1 }),
        offer('z', 'L', 'S2', P(9)),
      ],
      w,
      new Map()
    )
    assert.isTrue(s.get('z')!.best)
    assert.isFalse(s.get('y')!.best)
  })

  test('linhas da adjudicação: oferta, validade, câmbio, quantidades e motivo quando não é a melhor', ({
    assert,
  }) => {
    const offers = new Map(
      [
        offer('a', 'L1', 'S1', P(10)),
        offer('b', 'L1', 'S2', P(12)),
        offer('c', 'L1', 'S3', null),
      ].map((o, i) => [o.id, { ...o, quantity: P(5), expired: i === 1 }])
    )
    const scores = scoreOffers(
      [...offers.values()],
      { price: 100, delivery: 0, quality: 0, payment: 0 },
      new Map()
    )
    const req = new Map([['L1', P(8)]])
    const codes = (lines: any[]) =>
      awardLineIssues(lines, offers, req, scores).map((i) => `${i.path}:${i.code}`)
    assert.deepEqual(codes([]), ['lines:REQUIRED'])
    assert.deepEqual(codes([{ quoteLineId: 'a', quantity: P(5), reason: null }]), [])
    assert.includeMembers(
      codes([
        { quoteLineId: 'a', quantity: P(6), reason: null },
        { quoteLineId: 'b', quantity: P(3), reason: null },
        { quoteLineId: 'c', quantity: P(1), reason: 'x' },
        { quoteLineId: 'zz', quantity: P(1), reason: null },
        { quoteLineId: 'a', quantity: 0n, reason: null },
      ]),
      [
        'lines.0.quantity:OVER_OFFER',
        'lines.1.quoteLineId:QUOTE_EXPIRED',
        'lines.1.reason:NOT_BEST',
        'lines.2.quoteLineId:NO_RATE',
        'lines.3.quoteLineId:NOT_FOUND',
        'lines.4.quoteLineId:DUPLICATE',
        'lines.4.quantity:INVALID',
        'lines:OVER_REQUESTED',
      ]
    )
  })

  test('segregação: quem submeteu não decide', ({ assert }) => {
    assert.equal(decideBlockedBy('u1', 'u1'), 'SELF_APPROVAL')
    assert.isNull(decideBlockedBy('u1', 'u2'))
  })
})
