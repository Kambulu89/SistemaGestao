/**
 * Registo de módulos e funcionalidades (C03). Domínio puro. Os manifestos são entregues **por código**
 * (nunca carregados pelo tenant): o tenant só activa ou desactiva o que o registo já contém.
 */

/** Versão do núcleo; um módulo com `minCoreVersion` superior não é registado. */
export const CORE_VERSION = '0.3.0'

export type ModuleKind = 'FOUNDATION' | 'MODULE'

export interface ManifestDependency {
  code: string
  /** `*`, `1.2.3`, `^1.2`, `~1.2`, `>=1.0.0`, `>1`, `<=2`, `<2`. */
  constraint: string
  optional: boolean
}

export interface ManifestFeature {
  /** Prefixado pelo código do módulo: `sales.quotes`. */
  code: string
  name: string
  defaultEnabled: boolean
}

export interface ModuleManifest {
  code: string
  name: string
  kind: ModuleKind
  releaseVersion: string
  minCoreVersion: string
  dependencies: ManifestDependency[]
  features: ManifestFeature[]
}

export class RegistryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

// --- versões ----------------------------------------------------------------------------------

type Version = [number, number, number]
const VERSION = /^(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?$/

export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

const compare = (a: Version, b: Version) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

const CONSTRAINT = /^(\*|(?:>=|>|<=|<|\^|~)?\d{1,6}(?:\.\d{1,6}){0,2})$/

export const isValidConstraint = (constraint: string) => CONSTRAINT.test(constraint)

/** A versão cumpre a restrição? Restrições inválidas nunca são satisfeitas. */
export function satisfies(version: string, constraint: string): boolean {
  const v = parseVersion(version)
  if (!v || !isValidConstraint(constraint)) return false
  if (constraint === '*') return true
  const m = /^(>=|>|<=|<|\^|~)?(.+)$/.exec(constraint)!
  const base = parseVersion(m[2])!
  switch (m[1]) {
    case '>=':
      return compare(v, base) >= 0
    case '>':
      return compare(v, base) > 0
    case '<=':
      return compare(v, base) <= 0
    case '<':
      return compare(v, base) < 0
    case '^':
      return v[0] === base[0] && compare(v, base) >= 0
    case '~':
      return v[0] === base[0] && v[1] === base[1] && compare(v, base) >= 0
    default:
      return compare(v, base) === 0
  }
}

// --- validação do registo ---------------------------------------------------------------------

const MODULE_CODE = /^[a-z][a-z0-9_]{1,39}$/
const FEATURE_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]{0,58}$/

/**
 * Valida o conjunto completo de manifestos antes de gravar seja o que for: códigos, versões,
 * funcionalidades prefixadas, dependências existentes e satisfeitas, **sem ciclos**, e o núcleo
 * (FOUNDATION) sem depender de módulos.
 */
export function validateManifests(manifests: readonly ModuleManifest[]): void {
  const byCode = new Map<string, ModuleManifest>()
  const featureCodes = new Set<string>()
  for (const m of manifests) {
    if (!MODULE_CODE.test(m.code)) {
      throw new RegistryError('INVALID_MODULE_CODE', `Código de módulo inválido: ${m.code}.`)
    }
    if (byCode.has(m.code)) {
      throw new RegistryError('DUPLICATE_MODULE', `Módulo repetido: ${m.code}.`)
    }
    if (!m.name.trim() || m.name.length > 160) {
      throw new RegistryError('INVALID_MODULE_NAME', `${m.code}: nome inválido.`)
    }
    if (!parseVersion(m.releaseVersion) || !parseVersion(m.minCoreVersion)) {
      throw new RegistryError('INVALID_VERSION', `${m.code}: versão inválida.`)
    }
    if (compare(parseVersion(m.minCoreVersion)!, parseVersion(CORE_VERSION)!) > 0) {
      throw new RegistryError(
        'CORE_TOO_OLD',
        `${m.code} exige o núcleo ${m.minCoreVersion} (actual ${CORE_VERSION}).`
      )
    }
    for (const f of m.features) {
      if (!FEATURE_CODE.test(f.code) || !f.code.startsWith(`${m.code}.`)) {
        throw new RegistryError(
          'INVALID_FEATURE_CODE',
          `${m.code}: a funcionalidade ${f.code} tem de começar por "${m.code}.".`
        )
      }
      if (featureCodes.has(f.code)) {
        throw new RegistryError('DUPLICATE_FEATURE', `Funcionalidade repetida: ${f.code}.`)
      }
      featureCodes.add(f.code)
    }
    byCode.set(m.code, m)
  }

  for (const m of manifests) {
    for (const d of m.dependencies) {
      const target = byCode.get(d.code)
      if (!target) {
        throw new RegistryError(
          'UNKNOWN_DEPENDENCY',
          `${m.code} depende de ${d.code}, que não existe.`
        )
      }
      if (d.code === m.code) {
        throw new RegistryError('SELF_DEPENDENCY', `${m.code} não pode depender de si próprio.`)
      }
      if (!isValidConstraint(d.constraint)) {
        throw new RegistryError(
          'INVALID_CONSTRAINT',
          `${m.code}: restrição inválida (${d.constraint}).`
        )
      }
      if (!satisfies(target.releaseVersion, d.constraint)) {
        throw new RegistryError(
          'UNSATISFIED_DEPENDENCY',
          `${m.code} exige ${d.code} ${d.constraint}, mas o registo tem ${target.releaseVersion}.`
        )
      }
      if (m.kind === 'FOUNDATION' && target.kind !== 'FOUNDATION') {
        throw new RegistryError(
          'CORE_DEPENDS_ON_MODULE',
          `O núcleo (${m.code}) não pode depender de um módulo (${d.code}).`
        )
      }
    }
  }

  // Ciclos (inclui dependências opcionais: um ciclo opcional continua a ser um desenho errado).
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (code: string, path: string[]) => {
    if (state.get(code) === 'done') return
    if (state.get(code) === 'visiting') {
      throw new RegistryError(
        'DEPENDENCY_CYCLE',
        `Ciclo de dependências: ${[...path, code].join(' → ')}.`
      )
    }
    state.set(code, 'visiting')
    for (const d of byCode.get(code)!.dependencies) visit(d.code, [...path, code])
    state.set(code, 'done')
  }
  for (const code of byCode.keys()) visit(code, [])
}

// --- activação --------------------------------------------------------------------------------

export const TENANT_MODULE_STATUSES = [
  'DISABLED',
  'ENABLING',
  'ENABLED',
  'DISABLING',
  'ERROR',
] as const
export type TenantModuleStatus = (typeof TENANT_MODULE_STATUSES)[number]

export interface RegistryModule {
  id: string
  code: string
  name: string
  kind: ModuleKind
  releaseVersion: string
  status: 'AVAILABLE' | 'DEPRECATED'
  dependencies: { code: string; constraint: string; optional: boolean }[]
  features: { id: string; code: string; name: string; defaultEnabled: boolean }[]
}

/**
 * Dependências obrigatórias (transitivas) de `code` que ainda não estão activas, pela ordem em que
 * têm de ser activadas (as folhas primeiro). Dependências opcionais não contam.
 */
export function missingDependencies(
  code: string,
  modules: ReadonlyMap<string, RegistryModule>,
  enabled: ReadonlySet<string>
): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const visit = (current: string) => {
    for (const d of modules.get(current)?.dependencies ?? []) {
      if (d.optional || seen.has(d.code)) continue
      seen.add(d.code)
      visit(d.code)
      const dep = modules.get(d.code)
      if (dep && dep.kind !== 'FOUNDATION' && !enabled.has(d.code)) order.push(d.code)
    }
  }
  visit(code)
  return order
}

/** Módulos activos que dependem (obrigatoriamente) de `code`. */
export function activeDependents(
  code: string,
  modules: ReadonlyMap<string, RegistryModule>,
  enabled: ReadonlySet<string>
): string[] {
  return [...modules.values()]
    .filter(
      (m) => enabled.has(m.code) && m.dependencies.some((d) => d.code === code && !d.optional)
    )
    .map((m) => m.code)
    .sort()
}

export interface FeatureInputs {
  /** O módulo está activo no tenant (ou é do núcleo). */
  moduleActive: boolean
  /** A assinatura concede direitos e o módulo está licenciado. */
  moduleLicensed: boolean
  /** A funcionalidade vem por omissão no módulo, ou consta do plano. */
  featureLicensed: boolean
  defaultEnabled: boolean
  override: boolean | null
  overrideExpired: boolean
}

export type FeatureDecision = { enabled: true } | { enabled: false; reason: string }

/**
 * Acesso efectivo a uma funcionalidade = licença válida AND módulo activo AND funcionalidade ligada.
 * (Tenant operacional e autorização são decididos antes, no pedido.) Um override a favor **nunca**
 * ultrapassa a licença; um override contra desliga mesmo o que vem por omissão.
 */
export function decideFeature(i: FeatureInputs): FeatureDecision {
  if (!i.moduleLicensed) return { enabled: false, reason: 'NOT_LICENSED' }
  if (!i.featureLicensed) return { enabled: false, reason: 'FEATURE_NOT_LICENSED' }
  if (!i.moduleActive) return { enabled: false, reason: 'MODULE_DISABLED' }
  const override = i.overrideExpired ? null : i.override
  const on = override ?? i.defaultEnabled
  return on ? { enabled: true } : { enabled: false, reason: 'FEATURE_OFF' }
}
