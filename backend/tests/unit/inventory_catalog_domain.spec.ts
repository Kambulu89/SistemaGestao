import { test } from '@japa/runner'
import {
  attributesKey,
  checkBarcode,
  fitsDecimals,
  gtinCheckDigit,
  isAccountingClass,
  isSku,
  normalizeAttributes,
  productIssues,
  scaled,
  scaledText,
  toBase,
  type ProductFacts,
} from '#modules/inventory/domain/catalog'

const codes = (i: { code: string }[]) => i.map((x) => x.code)
const base: ProductFacts = {
  type: 'STOCKABLE',
  trackLots: false,
  trackSerials: false,
  trackExpiry: false,
  shelfLifeDays: null,
  minStock: null,
  maxStock: null,
  baseUomDecimals: 0,
  baseUomId: 'UN',
  purchaseUomId: null,
  saleUomId: null,
  conversionUomIds: [],
  hasVariants: false,
}

test.group('Inventário | domínio do catálogo (8.1)', () => {
  test('códigos de barras GTIN e internos', ({ assert }) => {
    assert.equal(gtinCheckDigit('400638133393'), 1) // EAN-13 4006381333931
    assert.deepEqual(checkBarcode('4006381333931'), { value: '4006381333931' })
    assert.deepEqual(checkBarcode('96385074'), { value: '96385074' }) // EAN-8
    assert.deepEqual(checkBarcode('036000291452'), { value: '036000291452' }) // UPC-A
    assert.property(checkBarcode('4006381333932'), 'error')
    assert.deepEqual(checkBarcode('INT-0001'), { value: 'INT-0001' })
    assert.property(checkBarcode('com espaço'), 'error')
    assert.property(checkBarcode('x'.repeat(49)), 'error')
  })

  test('SKU, classe contabilística e decimais exactos', ({ assert }) => {
    assert.isTrue(isSku('CAN-AZ/01'))
    assert.isFalse(isSku('-CAN'))
    assert.isTrue(isAccountingClass('MERCADORIAS'))
    assert.isFalse(isAccountingClass('mercadorias'))
    assert.equal(scaled('12.5', 6), 12500000n)
    assert.isNull(scaled('1.1234567', 6))
    assert.isNull(scaled('-1', 6))
    assert.equal(scaledText(12500000n, 6), '12.500000')
    // 2,5 caixas de 12 unidades = 30 unidades.
    assert.equal(toBase(2500000n, 12000000n), 30000000n)
    // 1 de 0,333333 → 0,333333.
    assert.equal(toBase(1000000n, 333333n), 333333n)
    assert.isTrue(fitsDecimals(30000000n, 0))
    assert.isFalse(fitsDecimals(30500000n, 0))
    assert.isTrue(fitsDecimals(30500000n, 1))
  })

  test('atributos de variante', ({ assert }) => {
    assert.deepEqual(normalizeAttributes({ ' Cor ': ' Azul ', 'Tamanho': 'M' }), {
      Cor: 'Azul',
      Tamanho: 'M',
    })
    assert.isNull(normalizeAttributes({}))
    assert.isNull(normalizeAttributes({ Cor: '' }))
    assert.isNull(normalizeAttributes(['a']))
    assert.isNull(normalizeAttributes({ a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' }))
    assert.equal(
      attributesKey({ Tamanho: 'M', Cor: 'Azul' }),
      attributesKey({ cor: 'azul', tamanho: 'm' })
    )
  })

  test('coerência do produto', ({ assert }) => {
    assert.lengthOf(productIssues(base), 0)
    assert.includeMembers(
      codes(productIssues({ ...base, type: 'SERVICE', trackLots: true, minStock: 1n })),
      ['NOT_STOCKABLE']
    )
    assert.include(
      codes(productIssues({ ...base, type: 'KIT', hasVariants: true })),
      'KIT_VARIANTS'
    )
    assert.include(
      codes(productIssues({ ...base, trackSerials: true, baseUomDecimals: 3 })),
      'SERIAL_DECIMALS'
    )
    assert.include(codes(productIssues({ ...base, shelfLifeDays: 30 })), 'EXPIRY_REQUIRED')
    assert.include(codes(productIssues({ ...base, minStock: 5n, maxStock: 2n })), 'MIN_MAX')
    assert.include(codes(productIssues({ ...base, saleUomId: 'CX' })), 'NO_CONVERSION')
    assert.lengthOf(productIssues({ ...base, saleUomId: 'CX', conversionUomIds: ['CX'] }), 0)
  })
})
