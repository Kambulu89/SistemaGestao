import { test } from '@japa/runner'
import {
  RegistryError,
  decideFeature,
  isValidConstraint,
  satisfies,
  validateManifests,
  type ModuleManifest,
} from '#platform/modules/domain/module'

const m = (
  code: string,
  deps: [string, string?, boolean?][] = [],
  extra: Partial<ModuleManifest> = {}
): ModuleManifest => ({
  code,
  name: code,
  kind: 'MODULE',
  releaseVersion: '1.2.3',
  minCoreVersion: '0.1.0',
  dependencies: deps.map(([c, constraint = '*', optional = false]) => ({
    code: c,
    constraint,
    optional,
  })),
  features: [],
  ...extra,
})
const core = m('core', [], { kind: 'FOUNDATION' })
const codeOf = (fn: () => void) => {
  try {
    fn()
  } catch (error) {
    return (error as RegistryError).code
  }
  return null
}

test.group('módulos | versões e restrições', () => {
  test('restrições de versão', ({ assert }) => {
    const cases: [string, string, boolean][] = [
      ['1.2.3', '*', true],
      ['1.2.3', '1.2.3', true],
      ['1.2.3', '1.2.4', false],
      ['1.2.3', '>=1.2', true],
      ['1.2.3', '>1.2.3', false],
      ['1.2.3', '<=1.2.3', true],
      ['1.2.3', '<1.2.3', false],
      ['1.9.0', '^1.2', true],
      ['2.0.0', '^1.2', false],
      ['1.2.9', '~1.2.3', true],
      ['1.3.0', '~1.2.3', false],
      ['1.2.3', 'latest', false],
    ]
    for (const [version, constraint, expected] of cases) {
      assert.strictEqual(satisfies(version, constraint), expected, `${version} vs ${constraint}`)
    }
    assert.isFalse(isValidConstraint('>= 1'))
  })
})

test.group('módulos | validação do registo', () => {
  test('aceita um grafo válido', ({ assert }) => {
    assert.doesNotThrow(() =>
      validateManifests([core, m('crm', [['core']]), m('sales', [['core'], ['crm', '^1']])])
    )
  })

  test('rejeita ciclos (mesmo por dependência opcional) com o caminho', ({ assert }) => {
    const manifests = [core, m('aa', [['bb']]), m('bb', [['cc']]), m('cc', [['aa', '*', true]])]
    assert.strictEqual(
      codeOf(() => validateManifests(manifests)),
      'DEPENDENCY_CYCLE'
    )
    try {
      validateManifests(manifests)
    } catch (error) {
      assert.include((error as Error).message, 'aa → bb → cc → aa')
    }
  })

  test('rejeita dependência em falta, própria, insatisfeita ou núcleo a depender de módulo', ({
    assert,
  }) => {
    assert.strictEqual(
      codeOf(() => validateManifests([core, m('aa', [['xx']])])),
      'UNKNOWN_DEPENDENCY'
    )
    assert.strictEqual(
      codeOf(() => validateManifests([core, m('aa', [['aa']])])),
      'SELF_DEPENDENCY'
    )
    assert.strictEqual(
      codeOf(() => validateManifests([core, m('aa'), m('bb', [['aa', '^2']])])),
      'UNSATISFIED_DEPENDENCY'
    )
    assert.strictEqual(
      codeOf(() => validateManifests([m('core', [['aa']], { kind: 'FOUNDATION' }), m('aa')])),
      'CORE_DEPENDS_ON_MODULE'
    )
  })

  test('rejeita códigos, duplicados, funcionalidades sem prefixo e núcleo demasiado antigo', ({
    assert,
  }) => {
    assert.strictEqual(
      codeOf(() => validateManifests([m('Sales')])),
      'INVALID_MODULE_CODE'
    )
    assert.strictEqual(
      codeOf(() => validateManifests([m('aa'), m('aa')])),
      'DUPLICATE_MODULE'
    )
    assert.strictEqual(
      codeOf(() =>
        validateManifests([
          m('aa', [], { features: [{ code: 'bb.x', name: 'xx', defaultEnabled: true }] }),
        ])
      ),
      'INVALID_FEATURE_CODE'
    )
    assert.strictEqual(
      codeOf(() => validateManifests([m('aa', [], { minCoreVersion: '9.0.0' })])),
      'CORE_TOO_OLD'
    )
  })
})

test.group('módulos | decisão de funcionalidade', () => {
  const base = {
    moduleActive: true,
    moduleLicensed: true,
    featureLicensed: true,
    defaultEnabled: true,
    override: null,
    overrideExpired: false,
  }
  test('licença AND módulo activo AND funcionalidade ligada', ({ assert }) => {
    assert.deepEqual(decideFeature(base), { enabled: true })
    assert.deepEqual(decideFeature({ ...base, moduleLicensed: false }), {
      enabled: false,
      reason: 'NOT_LICENSED',
    })
    assert.deepEqual(decideFeature({ ...base, featureLicensed: false }), {
      enabled: false,
      reason: 'FEATURE_NOT_LICENSED',
    })
    assert.deepEqual(decideFeature({ ...base, moduleActive: false }), {
      enabled: false,
      reason: 'MODULE_DISABLED',
    })
    assert.deepEqual(decideFeature({ ...base, defaultEnabled: false }), {
      enabled: false,
      reason: 'FEATURE_OFF',
    })
  })

  test('override liga/desliga, mas nunca ultrapassa a licença; expirado é ignorado', ({
    assert,
  }) => {
    assert.isTrue(decideFeature({ ...base, defaultEnabled: false, override: true }).enabled)
    assert.isFalse(decideFeature({ ...base, override: false }).enabled)
    assert.isFalse(decideFeature({ ...base, override: true, featureLicensed: false }).enabled)
    assert.isFalse(decideFeature({ ...base, override: true, moduleLicensed: false }).enabled)
    assert.isTrue(decideFeature({ ...base, override: false, overrideExpired: true }).enabled)
  })
})
