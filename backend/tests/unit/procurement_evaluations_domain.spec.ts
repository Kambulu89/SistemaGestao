import { test } from '@japa/runner'
import {
  combine,
  complianceIndicator,
  costIndicator,
  DEFAULT_WEIGHTS,
  deliveryIndicator,
  normalizePeriod,
  normalizeWeights,
  qualityIndicator,
  ratingOf,
  scoreText,
  slaMet,
} from '#modules/procurement/domain/evaluations'

const N = (v: number) => BigInt(Math.round(v * 1_000_000))
const codes = (issues: { code: string }[]) => issues.map((i) => i.code)

test.group('Compras | avaliação de fornecedores — regras (9.11)', () => {
  test('indicadores: qualidade por linha, prazo, conformidade, custo', ({ assert }) => {
    assert.deepEqual(
      qualityIndicator([
        { accepted: N(8), rejected: N(2), returned: N(2) },
        { accepted: N(5), rejected: 0n, returned: 0n },
        { accepted: 0n, rejected: 0n, returned: 0n },
      ]),
      { score: 8000, evidence: 2 }
    )
    assert.deepEqual(qualityIndicator([]), { score: null, evidence: 0 })
    assert.deepEqual(qualityIndicator([{ accepted: N(1), rejected: 0n, returned: N(3) }]), {
      score: 0,
      evidence: 1,
    })
    assert.deepEqual(
      deliveryIndicator([
        { received: '2026-11-20', expected: '2026-11-18' },
        { received: '2026-11-20', expected: '2026-11-20' },
        { received: '2026-11-20', expected: null },
      ]),
      { score: 5000, evidence: 2 }
    )
    assert.deepEqual(deliveryIndicator([{ received: '2026-11-20', expected: null }]), {
      score: null,
      evidence: 0,
    })
    assert.deepEqual(complianceIndicator([{ clean: true }, { clean: false }, { clean: true }]), {
      score: 6667,
      evidence: 3,
    })
    assert.deepEqual(
      costIndicator([
        { own: N(120), best: N(100) },
        { own: N(100), best: N(100) },
      ]),
      { score: 9167, evidence: 2 }
    )
  })

  test('nota ponderada: critérios sem provas não contam; classes', ({ assert }) => {
    const ind = {
      quality: { score: 8000, evidence: 2 },
      delivery: { score: 5000, evidence: 2 },
      compliance: { score: 5000, evidence: 2 },
      cost: { score: 8333, evidence: 1 },
    }
    assert.deepEqual(combine(DEFAULT_WEIGHTS, ind), { score: 6567, rating: 'C' })
    // Sem custo: reescala 30/30/20 → (8000×30 + 5000×30 + 5000×20) ÷ 80 = 6125.
    assert.deepEqual(combine(DEFAULT_WEIGHTS, { ...ind, cost: { score: null, evidence: 0 } }), {
      score: 6125,
      rating: 'C',
    })
    const none = { score: null, evidence: 0 }
    assert.deepEqual(
      combine(DEFAULT_WEIGHTS, { quality: none, delivery: none, compliance: none, cost: none }),
      {
        score: null,
        rating: null,
      }
    )
    // Peso 0 num critério com provas: não conta.
    assert.deepEqual(combine({ quality: 100, delivery: 0, compliance: 0, cost: 0 }, ind), {
      score: 8000,
      rating: 'B',
    })
    assert.deepEqual([8500, 8499, 7000, 5000, 4999].map(ratingOf), ['A', 'B', 'B', 'C', 'D'])
    assert.equal(scoreText(6567), '65.67')
    assert.isNull(scoreText(null))
  })

  test('pesos inteiros que somam 100; período válido; SLA medidos', ({ assert }) => {
    assert.deepEqual(normalizeWeights({ quality: 50, delivery: '50', compliance: 0, cost: 0 }), {
      weights: { quality: 50, delivery: 50, compliance: 0, cost: 0 },
      issues: [],
    })
    assert.deepEqual(
      codes(normalizeWeights({ quality: 50, delivery: 40, compliance: 0, cost: 0 }).issues),
      ['SUM']
    )
    assert.sameMembers(
      codes(normalizeWeights({ quality: 101, delivery: 1.5, compliance: -1 }).issues),
      ['INVALID', 'INVALID', 'INVALID', 'INVALID']
    )
    assert.deepEqual(normalizePeriod({ from: '2026-01-01' }, '2026-11-23').period, {
      from: '2026-01-01',
      to: '2026-11-23',
    })
    assert.deepEqual(
      codes(normalizePeriod({ from: '2026-02-01', to: '2026-01-01' }, '2026-11-23').issues),
      ['BEFORE_FROM']
    )
    assert.deepEqual(
      codes(normalizePeriod({ from: '2026-01-01', to: '2026-12-01' }, '2026-11-23').issues),
      ['FUTURE']
    )
    assert.deepEqual(
      codes(normalizePeriod({ from: '2020-01-01', to: '2026-11-23' }, '2026-11-23').issues),
      ['TOO_LONG']
    )
    assert.isTrue(slaMet('DELIVERY_DAYS', 7, 5))
    assert.isFalse(slaMet('DELIVERY_DAYS', 7, 8))
    assert.isTrue(slaMet('QUALITY_RATE', 95, 98.5))
    assert.isFalse(slaMet('FILL_RATE', 100, 80))
    assert.isNull(slaMet('RESPONSE_HOURS', 4, 3))
    assert.isNull(slaMet('DELIVERY_DAYS', 7, null))
  })
})
