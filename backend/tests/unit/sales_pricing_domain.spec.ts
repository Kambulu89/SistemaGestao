import { test } from '@japa/runner'
import {
  divRound,
  normalizePriceLine,
  normalizePriceList,
  normalizeRule,
  parseScaled,
  pickPrice,
  pickRule,
  type PriceCandidate,
  resolveLine,
  type RuleCandidate,
} from '#modules/sales/domain/pricing'

const codes = (issues: { path: string }[]) => issues.map((i) => i.path)
const q = (s: string) => parseScaled(s, 6)!
const p = (s: string) => parseScaled(s, 4)!
const pct = (s: string) => parseScaled(s, 2)!
const cand = (x: Partial<PriceCandidate>): PriceCandidate => ({
  listId: 'L1',
  listCode: 'L1',
  targetType: 'GENERAL',
  priority: 100,
  validFrom: '2026-01-01',
  lineId: 'x',
  variantId: null,
  minQuantity: q('1'),
  unitPrice: p('100'),
  maxDiscountPct: null,
  ...x,
})
const rule = (x: Partial<RuleCandidate>): RuleCandidate => ({
  ruleId: 'R1',
  code: 'R1',
  targetType: 'ALL',
  scope: 'ALL',
  priority: 100,
  minQuantity: 0n,
  pct: pct('5'),
  ...x,
})
const noLimits = { customer: null, segment: null, general: null }
const input = (x: Record<string, unknown> = {}) => ({
  quantity: q('1'),
  variantId: null,
  manualDiscountPct: null,
  manualUnitPrice: null,
  catalogPrice: null,
  ...x,
})

test.group('Vendas | preços — regras (10.2)', () => {
  test('decimais exactos e arredondamento a metade para cima', ({ assert }) => {
    assert.equal(parseScaled('1,5', 2), 150n)
    assert.isNull(parseScaled('1.12345', 4))
    assert.isNull(parseScaled('-1', 2))
    assert.isNull(parseScaled(1e21, 2))
    assert.equal(divRound(5n, 2n), 3n)
    assert.equal(divRound(-5n, 2n), -3n)
    assert.equal(divRound(4n, 3n), 1n)
  })

  test('validação de tabela, linha e regra', ({ assert }) => {
    assert.includeMembers(
      codes(normalizePriceList({ code: '', currency: 'kz', targetType: 'SEGMENT' }, true).issues),
      ['code', 'name', 'currency', 'segmentId', 'validFrom']
    )
    const ok = normalizePriceList(
      {
        code: 'geral-2026',
        name: 'Geral',
        currency: 'aoa',
        targetType: 'GENERAL',
        validFrom: '2026-01-01',
      },
      true
    )
    assert.deepEqual(ok.issues, [])
    assert.equal(ok.v.code, 'GERAL-2026')
    assert.equal(ok.v.currency, 'AOA')
    assert.includeMembers(
      codes(
        normalizePriceLine(
          { productId: 'x', unitPrice: '1.12345', minQuantity: '0', maxDiscountPct: '101' },
          true
        ).issues
      ),
      ['productId', 'unitPrice', 'minQuantity', 'maxDiscountPct']
    )
    assert.equal(normalizePriceLine({ unitPrice: '12,5' }, false).v.unitPrice, '12.5000')
    assert.includeMembers(
      codes(
        normalizeRule(
          {
            code: 'R',
            name: 'Regra',
            targetType: 'ALL',
            discountPct: '0',
            validFrom: '2026-01-01',
            productId: '00000000-0000-0000-0000-000000000001',
            categoryId: '00000000-0000-0000-0000-000000000002',
          },
          true
        ).issues
      ),
      ['discountPct', 'categoryId']
    )
  })

  test('tabela: mais específica, depois prioridade, início mais recente; variante e maior escalão', ({
    assert,
  }) => {
    const all = [
      cand({ listId: 'G', listCode: 'G', unitPrice: p('100') }),
      cand({ listId: 'S', listCode: 'S', targetType: 'SEGMENT', unitPrice: p('90') }),
      cand({
        listId: 'C',
        listCode: 'C',
        targetType: 'CUSTOMER',
        unitPrice: p('80'),
        minQuantity: q('10'),
      }),
    ]
    // O cliente tem tabela, mas o escalão (10) não é atingido: vale o segmento.
    assert.equal(pickPrice(all, q('5'), null)!.listId, 'S')
    assert.equal(pickPrice(all, q('10'), null)!.listId, 'C')
    // Prioridade dentro do mesmo destino, depois início mais recente.
    assert.equal(
      pickPrice(
        [
          cand({ listId: 'A', listCode: 'A', priority: 100 }),
          cand({ listId: 'B', listCode: 'B', priority: 200 }),
        ],
        q('1'),
        null
      )!.listId,
      'B'
    )
    assert.equal(
      pickPrice(
        [
          cand({ listId: 'A', listCode: 'A', validFrom: '2026-01-01' }),
          cand({ listId: 'B', listCode: 'B', validFrom: '2026-03-01' }),
        ],
        q('1'),
        null
      )!.listId,
      'B'
    )
    // Dentro da tabela: a variante antes do produto, e o maior escalão atingido.
    const tiers = [
      cand({ lineId: 'base', minQuantity: q('1'), unitPrice: p('100') }),
      cand({ lineId: 't10', minQuantity: q('10'), unitPrice: p('95') }),
      cand({ lineId: 't50', minQuantity: q('50'), unitPrice: p('90') }),
      cand({ lineId: 'var', variantId: 'V', minQuantity: q('1'), unitPrice: p('120') }),
    ]
    assert.equal(pickPrice(tiers, q('12'), null)!.lineId, 't10')
    assert.equal(pickPrice(tiers, q('50'), null)!.lineId, 't50')
    assert.equal(pickPrice(tiers, q('50'), 'V')!.lineId, 'var')
    assert.equal(pickPrice(tiers, q('5'), 'OUTRA')!.lineId, 'base')
    assert.isNull(pickPrice(tiers, q('0.5'), null))
  })

  test('regra: uma só, por prioridade, depois destino e âmbito mais específicos', ({ assert }) => {
    const rs = [
      rule({ ruleId: 'ALL', code: 'A', pct: pct('2') }),
      rule({ ruleId: 'CUS', code: 'B', targetType: 'CUSTOMER', pct: pct('3') }),
      rule({ ruleId: 'CAT', code: 'C', targetType: 'CUSTOMER', scope: 'CATEGORY', pct: pct('4') }),
      rule({ ruleId: 'QTY', code: 'D', priority: 500, minQuantity: q('100'), pct: pct('10') }),
    ]
    assert.equal(pickRule(rs, q('1'))!.ruleId, 'CAT')
    assert.equal(pickRule(rs, q('100'))!.ruleId, 'QTY')
    assert.isNull(pickRule([], q('1')))
  })

  test('preço líquido, limite do desconto manual e aprovação', ({ assert }) => {
    const list = [cand({ unitPrice: p('1000'), maxDiscountPct: pct('8') })]
    const rs = [rule({ pct: pct('10') })]
    // 1000 −10 % (regra) −5 % (manual) = 855; limite: cliente 10 %, mas a linha limita a 8 %.
    const a = resolveLine(input({ quantity: q('3'), manualDiscountPct: pct('5') }), list, rs, {
      customer: pct('10'),
      segment: pct('2'),
      general: pct('1'),
    })
    assert.equal(a.source, 'LIST')
    assert.equal(a.netUnitPrice, '855.0000')
    assert.equal(a.netAmount, '2565.00')
    assert.equal(a.limitPct, '8.00')
    assert.equal(a.limitSource, 'LINE')
    assert.isFalse(a.requiresApproval)
    // Acima do limite (o desconto da regra não conta).
    const b = resolveLine(input({ manualDiscountPct: pct('8.01') }), list, rs, noLimits)
    assert.equal(b.limitSource, 'NONE')
    assert.isTrue(b.requiresApproval)
    assert.deepEqual(b.reasons, ['DISCOUNT_OVER_LIMIT'])
    // Preço manual abaixo: percentagem implícita arredondada para cima (900 → 899 = 0,111… % → 0,12 %).
    const c = resolveLine(input({ manualUnitPrice: p('899') }), list, rs, {
      ...noLimits,
      general: pct('0.11'),
    })
    assert.equal(c.manualDiscountPct, '0.12')
    assert.equal(c.netUnitPrice, '899.0000')
    assert.isTrue(c.requiresApproval)
    // Preço manual acima do preço da tabela não é desconto.
    const d = resolveLine(input({ manualUnitPrice: p('950') }), list, rs, noLimits)
    assert.equal(d.manualDiscountPct, '0.00')
    assert.isFalse(d.requiresApproval)
    // Arredondamento a 4 casas: 0,3333 × (1 − 0,1) = 0,29997 → 0,3000.
    const e = resolveLine(input(), [cand({ unitPrice: p('0.3333') })], rs, noLimits)
    assert.equal(e.netUnitPrice, '0.3000')
  })

  test('sem tabela: catálogo, preço manual com aprovação, ou sem preço', ({ assert }) => {
    const cat = resolveLine(input({ catalogPrice: p('50') }), [], [], noLimits)
    assert.equal(cat.source, 'CATALOG')
    assert.equal(cat.netUnitPrice, '50.0000')
    const man = resolveLine(input({ manualUnitPrice: p('40') }), [], [rule({})], noLimits)
    assert.equal(man.source, 'MANUAL')
    assert.equal(man.netUnitPrice, '40.0000')
    assert.isNull(man.ruleId)
    assert.deepEqual(man.reasons, ['MANUAL_PRICE'])
    assert.isTrue(man.requiresApproval)
    const none = resolveLine(input(), [], [], noLimits)
    assert.equal(none.source, 'NONE')
    assert.isNull(none.netUnitPrice)
    assert.deepEqual(none.reasons, ['NO_PRICE'])
  })
})
