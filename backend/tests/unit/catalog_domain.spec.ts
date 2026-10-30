import { test } from '@japa/runner'
import {
  compareDecimals,
  normalizePriceItem,
  normalizePriceList,
  normalizeProduct,
  normalizeVariant,
  pickPrice,
  stockIdentityChanged,
  type Issue,
  type PriceCandidate,
  type ProductValues,
} from '#modules/catalog/domain/catalog'

const UNIT = '11111111-1111-4111-8111-111111111111'

const product = (input: Record<string, unknown>, base: ProductValues | null = null) => {
  const issues: Issue[] = []
  const values = normalizeProduct(
    { code: 'P1', name: 'Produto', baseUnitId: UNIT, ...input },
    base,
    issues
  )
  return { values, codes: issues.map((i) => `${i.path}:${i.code}`) }
}

test.group('catálogo | produtos', () => {
  test('um bem controla stock por omissão; um serviço nunca', ({ assert }) => {
    const goods = product({ type: 'GOODS' })
    assert.deepInclude(goods.values, { trackStock: true, trackingMode: 'NONE', type: 'GOODS' })
    const service = product({ type: 'SERVICE' })
    assert.deepInclude(service.values, { trackStock: false, trackingMode: 'NONE', type: 'SERVICE' })
  })

  test('um serviço não pode pedir stock, lotes nem séries', ({ assert }) => {
    assert.include(product({ type: 'SERVICE', trackStock: true }).codes, 'type:SERVICE_NO_STOCK')
    assert.include(product({ type: 'SERVICE', trackingMode: 'LOT' }).codes, 'type:SERVICE_NO_STOCK')
  })

  test('lotes e séries exigem controlar stock', ({ assert }) => {
    assert.include(
      product({ type: 'GOODS', trackStock: false, trackingMode: 'SERIAL' }).codes,
      'trackingMode:TRACKING_NEEDS_STOCK'
    )
    assert.deepInclude(product({ type: 'GOODS', trackingMode: 'LOT' }).values, {
      trackStock: true,
      trackingMode: 'LOT',
    })
  })

  test('valida código, nome, tipo, rastreio e unidade', ({ assert }) => {
    assert.include(product({ code: '-x' }).codes, 'code:INVALID_CODE')
    assert.include(product({ name: '  ' }).codes, 'name:INVALID_NAME')
    assert.include(product({ type: 'SERVICO' }).codes, 'type:INVALID_TYPE')
    assert.include(product({ trackingMode: 'BATCH' }).codes, 'trackingMode:INVALID_TRACKING')
    assert.include(product({ baseUnitId: undefined, code: 'P2' }).codes, 'baseUnitId:INVALID_UNIT')
  })

  test('reconhece a mudança da unidade base e do rastreio (que exigem migração com movimentos)', ({
    assert,
  }) => {
    const before = product({}).values as ProductValues
    const rename = product({ name: 'Outro nome' }, before).values as ProductValues
    assert.isFalse(stockIdentityChanged(before, rename))
    const unit = product({ baseUnitId: '22222222-2222-4222-8222-222222222222' }, before)
      .values as ProductValues
    assert.isTrue(stockIdentityChanged(before, unit))
    const tracking = product({ trackingMode: 'LOT' }, before).values as ProductValues
    assert.isTrue(stockIdentityChanged(before, tracking))
  })
})

test.group('catálogo | variantes', () => {
  const variant = (
    input: Record<string, unknown>,
    base = null as Parameters<typeof normalizeVariant>[1]
  ) => {
    const issues: Issue[] = []
    const values = normalizeVariant(input, base, issues)
    return { values, codes: issues.map((i) => `${i.path}:${i.code}`) }
  }

  test('o SKU identifica a variante e não muda', ({ assert }) => {
    assert.include(variant({ sku: '' }).codes, 'sku:INVALID_SKU')
    assert.include(variant({ sku: 'a b' }).codes, 'sku:INVALID_SKU')
    const created = variant({
      sku: 'CAM-001/M',
      attributes: { tamanho: 'M', peso: 1.5, novo: true },
    })
    assert.deepEqual(created.codes, [])
    assert.include(variant({ sku: 'OUTRO' }, created.values).codes, 'sku:SKU_IMMUTABLE')
    assert.deepEqual(variant({ barcode: '5601234567890' }, created.values).values?.sku, 'CAM-001/M')
  })

  test('valida código de barras e atributos', ({ assert }) => {
    assert.include(variant({ sku: 'A1', barcode: 'x' }).codes, 'barcode:INVALID_BARCODE')
    assert.include(
      variant({ sku: 'A1', attributes: { 'a b': 1 } }).codes,
      'attributes.a b:INVALID_ATTRIBUTE_NAME'
    )
    assert.include(
      variant({ sku: 'A1', attributes: { cor: ['x'] } }).codes,
      'attributes.cor:INVALID_ATTRIBUTE'
    )
    assert.include(variant({ sku: 'A1', attributes: 'x' }).codes, 'attributes:INVALID_ATTRIBUTES')
  })
})

test.group('catálogo | preços', () => {
  const ORG = '33333333-3333-4333-8333-333333333333'
  const list = (input: Record<string, unknown>) => {
    const issues: Issue[] = []
    const values = normalizePriceList(
      { organizationId: ORG, name: 'Retalho', currency: 'AOA', validFrom: '2026-01-01', ...input },
      null,
      issues
    )
    return { values, codes: issues.map((i) => `${i.path}:${i.code}`) }
  }

  test('valida moeda, datas, período e prioridade', ({ assert }) => {
    assert.deepEqual(list({}).codes, [])
    assert.include(list({ currency: 'aoa' }).codes, 'currency:INVALID_CURRENCY')
    assert.include(list({ validFrom: '2026-02-30' }).codes, 'validFrom:INVALID_DATE')
    assert.include(list({ validTo: '2025-12-31' }).codes, 'validTo:INVALID_PERIOD')
    assert.include(list({ priority: 1.5 }).codes, 'priority:INVALID_PRIORITY')
  })

  const item = (input: Record<string, unknown>) => {
    const issues: Issue[] = []
    const values = normalizePriceItem({ variantId: UNIT, unitPrice: '10.00', ...input }, issues)
    return { values, codes: issues.map((i) => `${i.path}:${i.code}`) }
  }

  test('os decimais são texto: quantidade positiva, preço não negativo, desconto entre 0 e 1', ({
    assert,
  }) => {
    assert.deepEqual(item({}).values, {
      variantId: UNIT,
      minQuantity: '1',
      unitPrice: '10.00',
      maxDiscount: '0',
    })
    assert.include(item({ minQuantity: '0' }).codes, 'minQuantity:INVALID_QUANTITY')
    assert.include(item({ minQuantity: 5 }).codes, 'minQuantity:INVALID_QUANTITY')
    assert.include(item({ unitPrice: 10 }).codes, 'unitPrice:INVALID_PRICE')
    assert.include(item({ unitPrice: '-1' }).codes, 'unitPrice:INVALID_PRICE')
    assert.include(item({ unitPrice: '1e3' }).codes, 'unitPrice:INVALID_PRICE')
    assert.include(item({ maxDiscount: '1.5' }).codes, 'maxDiscount:INVALID_DISCOUNT')
    assert.deepEqual(item({ maxDiscount: '1' }).codes, [])
  })

  test('compara decimais sem float', ({ assert }) => {
    assert.equal(compareDecimals('10', '10.000000'), 0)
    assert.equal(compareDecimals('9.999999', '10'), -1)
    assert.equal(compareDecimals('100', '99.9'), 1)
    assert.isNull(compareDecimals('x', '1'))
    assert.isNull(compareDecimals('-1', '1'))
  })

  const candidate = (over: Partial<PriceCandidate>): PriceCandidate => ({
    priceListId: 'l1',
    priceListName: 'Lista 1',
    priority: 0,
    taxInclusive: false,
    currency: 'AOA',
    validFrom: '2026-01-01',
    validTo: null,
    minQuantity: '1.000000',
    unitPrice: '10.0000',
    maxDiscount: '0.0000',
    ...over,
  })

  test('em cada tabela vale o escalão mais alto alcançado', ({ assert }) => {
    const picked = pickPrice([
      candidate({ minQuantity: '1.000000', unitPrice: '10.0000' }),
      candidate({ minQuantity: '10.000000', unitPrice: '9.0000' }),
      candidate({ minQuantity: '100.000000', unitPrice: '8.0000' }),
    ])
    assert.equal(picked.kind === 'FOUND' && picked.price.unitPrice, '8.0000')
  })

  test('entre tabelas vence a de maior prioridade; empate é ambíguo; sem candidatos não há preço', ({
    assert,
  }) => {
    const high = candidate({
      priceListId: 'a',
      priceListName: 'A',
      priority: 10,
      unitPrice: '12.0000',
    })
    const low = candidate({
      priceListId: 'b',
      priceListName: 'B',
      priority: 1,
      unitPrice: '9.0000',
    })
    const winner = pickPrice([low, high])
    assert.equal(winner.kind === 'FOUND' && winner.price.priceListId, 'a')
    const tie = pickPrice([high, candidate({ priceListId: 'c', priceListName: 'C', priority: 10 })])
    assert.equal(tie.kind, 'AMBIGUOUS')
    assert.sameMembers(tie.kind === 'AMBIGUOUS' ? tie.lists.map((l) => l.name) : [], ['A', 'C'])
    // Um empate fora do topo não importa.
    const lowTie = pickPrice([
      high,
      low,
      candidate({ priceListId: 'd', priceListName: 'D', priority: 1 }),
    ])
    assert.equal(lowTie.kind, 'FOUND')
    assert.deepEqual(pickPrice([]), { kind: 'NONE' })
  })
})
