import { test } from '@japa/runner'
import {
  SETTING_DEFINITIONS,
  findDefinition,
  resolveEffective,
  validateScope,
  validateValue,
  type ResolutionContext,
  type StoredValue,
} from '#core/settings/domain/setting'
import {
  formatNumber,
  isValidPeriod,
  periodKeys,
  validateTemplate,
} from '#core/settings/domain/sequence'
import { validateTaxRate } from '#core/settings/domain/tax'
import { convert, type ConvertibleUnit } from '#core/settings/domain/units'
import { SettingsRuleError } from '#core/settings/domain/errors'

const ORG = '11111111-1111-4111-8111-111111111111'
const BRANCH = '22222222-2222-4222-8222-222222222222'
const ME = '33333333-3333-4333-8333-333333333333'
const date = findDefinition('ui.dateFormat')!
const stored = (
  scopeType: StoredValue['scopeType'],
  value: string,
  scopeId: string | null = null,
  moduleCode: string | null = null
): StoredValue => ({ key: 'ui.dateFormat', scopeType, scopeId, moduleCode, value, version: 1 })

const everything: ResolutionContext = {
  organizationId: ORG,
  branchId: BRANCH,
  moduleCode: 'sales',
  membershipId: ME,
}
const throwsRule = (fn: () => void, code: string) => {
  try {
    fn()
  } catch (error) {
    return (error as SettingsRuleError).code === code
  }
  return false
}

test.group('configurações | precedência', () => {
  test('omissão < tenant < organização < filial < módulo < filial+módulo < membership', ({
    assert,
  }) => {
    const layers: StoredValue[] = []
    const level = () => resolveEffective(date, layers, everything).source
    assert.deepEqual(level(), { level: 'DEFAULT' })
    assert.strictEqual(resolveEffective(date, layers, everything).value, 'dd/MM/yyyy')

    const chain: [StoredValue, string][] = [
      [stored('TENANT', 'a'), 'TENANT'],
      [stored('ORGANIZATION', 'b', ORG), 'ORGANIZATION'],
      [stored('BRANCH', 'c', BRANCH), 'BRANCH'],
      [stored('MODULE', 'd', null, 'sales'), 'MODULE'],
      [stored('BRANCH', 'e', BRANCH, 'sales'), 'BRANCH'],
      [stored('MEMBERSHIP', 'f', ME), 'MEMBERSHIP'],
    ]
    for (const [row, expectedLevel] of chain) {
      layers.push(row)
      const got = resolveEffective(date, layers, everything)
      assert.strictEqual(got.value, row.value)
      assert.strictEqual((got.source as { level: string }).level, expectedLevel)
    }
  })

  test('só conta o contexto pedido: outra filial, outro módulo ou outro membro não aplicam', ({
    assert,
  }) => {
    const layers = [
      stored('TENANT', 'tenant'),
      stored('BRANCH', 'outra-filial', '99999999-9999-4999-8999-999999999999'),
      stored('MODULE', 'outro-modulo', null, 'crm'),
      stored('MEMBERSHIP', 'outro-membro', '88888888-8888-4888-8888-888888888888'),
    ]
    assert.strictEqual(resolveEffective(date, layers, everything).value, 'tenant')
    // A combinação é mais específica que a filial sozinha e que o módulo sozinho.
    const combo = [
      ...layers,
      stored('BRANCH', 'filial', BRANCH),
      stored('MODULE', 'mod', null, 'sales'),
    ]
    assert.strictEqual(resolveEffective(date, combo, everything).value, 'mod')
    const withCombo = [...combo, stored('BRANCH', 'combo', BRANCH, 'sales')]
    assert.strictEqual(resolveEffective(date, withCombo, everything).value, 'combo')
    // Sem módulo no contexto, a combinação e o módulo não entram.
    assert.strictEqual(
      resolveEffective(date, withCombo, { ...everything, moduleCode: null }).value,
      'filial'
    )
  })

  test('regras fiscais: só tenant e organização; valores noutros âmbitos são ignorados', ({
    assert,
  }) => {
    const fiscal = findDefinition('tax.roundingMode')!
    const row = (scopeType: StoredValue['scopeType'], value: string, scopeId: string | null) => ({
      key: fiscal.key,
      scopeType,
      scopeId,
      moduleCode: null,
      value,
      version: 1,
    })
    const got = resolveEffective(
      fiscal,
      [
        row('TENANT', 'HALF_EVEN', null),
        row('MEMBERSHIP', 'HALF_UP', ME),
        row('BRANCH', 'HALF_UP', BRANCH),
      ],
      everything
    )
    assert.strictEqual(got.value, 'HALF_EVEN')
    assert.deepEqual(fiscal.allowedScopes, ['TENANT', 'ORGANIZATION'])
    assert.isTrue(
      throwsRule(
        () => validateScope(fiscal, { scopeType: 'MEMBERSHIP', scopeId: ME, moduleCode: null }),
        'SCOPE_NOT_ALLOWED'
      )
    )
    assert.isTrue(
      throwsRule(
        () => validateScope(fiscal, { scopeType: 'BRANCH', scopeId: BRANCH, moduleCode: null }),
        'SCOPE_NOT_ALLOWED'
      )
    )
  })

  test('forma do âmbito e validação do valor', ({ assert }) => {
    assert.isTrue(
      throwsRule(
        () => validateScope(date, { scopeType: 'TENANT', scopeId: ORG, moduleCode: null }),
        'SCOPE_ID_NOT_ALLOWED'
      )
    )
    assert.isTrue(
      throwsRule(
        () => validateScope(date, { scopeType: 'ORGANIZATION', scopeId: null, moduleCode: null }),
        'SCOPE_ID_REQUIRED'
      )
    )
    assert.isTrue(
      throwsRule(
        () => validateScope(date, { scopeType: 'MODULE', scopeId: null, moduleCode: null }),
        'MODULE_REQUIRED'
      )
    )
    assert.isTrue(
      throwsRule(
        () => validateScope(date, { scopeType: 'ORGANIZATION', scopeId: ORG, moduleCode: 'sales' }),
        'MODULE_NOT_ALLOWED'
      )
    )
    assert.doesNotThrow(() =>
      validateScope(date, { scopeType: 'BRANCH', scopeId: BRANCH, moduleCode: 'sales' })
    )

    assert.doesNotThrow(() => validateValue(date, 'yyyy-MM-dd'))
    assert.isTrue(throwsRule(() => validateValue(date, 'dd-mm'), 'INVALID_VALUE'))
    assert.isTrue(
      throwsRule(
        () => validateValue(findDefinition('tax.pricesIncludeTax')!, 'sim'),
        'INVALID_VALUE'
      )
    )
    assert.isAbove(SETTING_DEFINITIONS.length, 3)
  })
})

test.group('sequências | modelo e período', () => {
  const context = {
    date: new Date('2026-03-15T10:00:00Z'),
    series: 'A',
    organizationCode: 'ORG-1',
    branchCode: 'LUA',
  }

  test('formata com prefixo, preenchimento e sem truncar', ({ assert }) => {
    assert.strictEqual(formatNumber('FT {SERIES}/{YYYY}/', 6, 42n, context), 'FT A/2026/000042')
    assert.strictEqual(
      formatNumber('{ORG}-{BRANCH}-{YY}{MM}-', 3, 7n, context),
      'ORG-1-LUA-2603-007'
    )
    assert.strictEqual(formatNumber('N', 3, 123456n, context), 'N123456')
    assert.strictEqual(formatNumber('{BRANCH}', 2, 1n, { ...context, branchCode: null }), '01')
  })

  test('modelo só admite os tokens conhecidos', ({ assert }) => {
    assert.doesNotThrow(() => validateTemplate('FT {SERIES}/{YYYY}/'))
    for (const bad of ['{ORG', '{EVAL}', '${x}', 'a}b', 'x'.repeat(101)]) {
      assert.isTrue(
        throwsRule(
          () => validateTemplate(bad),
          bad.length > 100 ? 'TEMPLATE_TOO_LONG' : 'INVALID_TEMPLATE'
        ),
        bad.slice(0, 12)
      )
    }
  })

  test('períodos', ({ assert }) => {
    assert.deepEqual(periodKeys(new Date('2026-03-15T00:00:00Z')), ['2026-03', '2026', 'ALL'])
    for (const ok of ['ALL', '2026', '2026-12']) assert.isTrue(isValidPeriod(ok))
    for (const bad of ['all', '26', '2026-13', '2026-1', '']) assert.isFalse(isValidPeriod(bad))
  })
})

test.group('impostos | validação', () => {
  const ok = {
    code: 'IVA',
    rate: '14',
    validFrom: '2026-01-01',
    validTo: null,
    category: 'VAT',
    exemptionReason: null,
  }
  test('aceita e rejeita', ({ assert }) => {
    assert.doesNotThrow(() => validateTaxRate(ok))
    assert.isTrue(throwsRule(() => validateTaxRate({ ...ok, code: 'iva' }), 'INVALID_CODE'))
    assert.isTrue(throwsRule(() => validateTaxRate({ ...ok, rate: '-1' }), 'INVALID_RATE'))
    assert.isTrue(throwsRule(() => validateTaxRate({ ...ok, rate: '14.12345' }), 'INVALID_RATE'))
    assert.isTrue(
      throwsRule(() => validateTaxRate({ ...ok, validFrom: '2026-02-30' }), 'INVALID_DATE')
    )
    assert.isTrue(
      throwsRule(() => validateTaxRate({ ...ok, validTo: '2025-12-31' }), 'INVALID_PERIOD')
    )
    assert.isTrue(
      throwsRule(() => validateTaxRate({ ...ok, rate: '0' }), 'EXEMPTION_REASON_REQUIRED')
    )
    assert.doesNotThrow(() =>
      validateTaxRate({ ...ok, rate: '0.0000', exemptionReason: 'Art. 12' })
    )
  })
})

test.group('unidades | conversão exacta', () => {
  const unit = (code: string, precision: number, factor: string | null): ConvertibleUnit => ({
    code,
    dimension: 'MASS',
    precision,
    baseUnitId: factor === null ? null : 'base',
    factor,
  })
  const kg = unit('KG', 3, null)
  const g = unit('G', 0, '0.001')
  const t = unit('T', 3, '1000')

  test('converte sem floats e arredonda à precisão do destino', ({ assert }) => {
    assert.strictEqual(convert('1', kg, g), '1000')
    assert.strictEqual(convert('1500', g, kg), '1.500')
    assert.strictEqual(convert('2.5', t, kg), '2500.000')
    assert.strictEqual(convert('1', g, kg), '0.001')
    assert.strictEqual(convert('1.4', kg, kg), '1.400')
    // 0.5 g = 0.0005 kg → 0.001 (meio para cima, 3 casas)
    assert.strictEqual(convert('0.5', g, kg), '0.001')
    assert.strictEqual(convert('0.4', g, kg), '0.000')
    // Soma clássica de floats: 0.1 + 0.2 em gramas→kg não sofre erros binários.
    assert.strictEqual(convert('300', g, kg), '0.300')
  })

  test('dimensões incompatíveis nunca convertem; quantidade inválida é recusada', ({ assert }) => {
    const litre: ConvertibleUnit = { ...kg, code: 'L', dimension: 'VOLUME' }
    assert.isTrue(throwsRule(() => convert('1', kg, litre), 'INCOMPATIBLE_DIMENSIONS'))
    for (const bad of ['-1', '1,5', 'abc', '1.1234567', '']) {
      assert.isTrue(
        throwsRule(() => convert(bad, kg, g), 'INVALID_QUANTITY'),
        bad
      )
    }
  })
})
