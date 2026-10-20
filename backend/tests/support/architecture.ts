import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'

/**
 * Verificação automática das fronteiras de módulo (docs/architecture.md §2). Analisa apenas os
 * `import`/`export … from` e `import()` de `app/**`; não executa código. O que não é verificável
 * estaticamente (ex.: um módulo escrever na tabela de outro por SQL) fica a cargo da revisão e dos
 * testes de isolamento.
 */
export interface SourceFile {
  /** Caminho relativo à raiz do backend, com `/` (ex.: `app/core/tenancy/domain/x.ts`). */
  path: string
  source: string
}

export interface ArchitectureViolation {
  file: string
  rule: string
  message: string
}

const GROUPS = ['core', 'platform', 'modules', 'dynamic', 'verticals'] as const
const LAYERS = ['domain', 'application', 'infrastructure', 'presentation'] as const
/** Módulos partilhados por todos (kernel HTTP): não têm camadas nem restrições de importação. */
const SHARED_KERNEL = new Set(['core/http'])

const ALIASES: Record<string, string> = {
  '#core/': 'app/core/',
  '#exceptions/': 'app/exceptions/',
  '#middleware/': 'app/middleware/',
  '#start/': 'start/',
  '#config/': 'config/',
  '#database/': 'database/',
  '#tests/': 'tests/',
}

interface Location {
  group: (typeof GROUPS)[number]
  module: string
  layer: (typeof LAYERS)[number] | null
  /** `grupo/módulo`, ex.: `core/tenancy`. */
  key: string
}

function locate(path: string): Location | null {
  const [root, group, module, layer] = path.split('/')
  if (root !== 'app' || !GROUPS.includes(group as never) || !module) return null
  return {
    group: group as Location['group'],
    module,
    layer: LAYERS.includes(layer as never) ? (layer as Location['layer']) : null,
    key: `${group}/${module}`,
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Especificadores importados (estáticos, `export … from` e `import()`). */
export function importSpecifiers(source: string): string[] {
  const code = stripComments(source)
  const specifiers = new Set<string>()
  for (const match of code.matchAll(
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
  )) {
    specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Resolve um especificador para um caminho do projecto, ou `null` se for um pacote externo. */
function resolveInternal(fromPath: string, specifier: string): string | null {
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (specifier.startsWith(alias)) return stripExtension(target + specifier.slice(alias.length))
  }
  if (specifier.startsWith('.')) {
    return stripExtension(posix.normalize(posix.join(posix.dirname(fromPath), specifier)))
  }
  return null
}

const stripExtension = (path: string) => path.replace(/\.(js|ts)$/, '')

const FORBIDDEN_CONSTRUCTS: [RegExp, string][] = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/['"](?:node:)?child_process['"]/, 'child_process'],
  [/['"](?:node:)?vm['"]/, 'vm'],
]

const isExternalDatabase = (specifier: string) =>
  specifier === 'pg' || specifier.startsWith('@adonisjs/lucid') || specifier === 'knex'

export function checkArchitecture(files: SourceFile[]): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []

  for (const file of files) {
    const here = locate(file.path)
    const add = (rule: string, message: string) =>
      violations.push({ file: file.path, rule, message })

    // R5 — nunca código arbitrário.
    const code = stripComments(file.source)
    for (const [pattern, name] of FORBIDDEN_CONSTRUCTS) {
      if (pattern.test(code)) {
        add('R5', `Uso proibido de ${name}: o sistema nunca executa código arbitrário.`)
      }
    }

    for (const specifier of importSpecifiers(file.source)) {
      const target = resolveInternal(file.path, specifier)
      const there = target ? locate(target) : null

      // R6 — só a infraestrutura (e a pasta database/config/start) fala com a base de dados.
      if (isExternalDatabase(specifier) && file.path.startsWith('app/')) {
        if (here?.layer !== 'infrastructure') {
          add('R6', `"${specifier}" só pode ser usado em infrastructure/ (acesso a dados).`)
        }
      }

      if (here && !SHARED_KERNEL.has(here.key)) {
        // R1 — domain depende só de si próprio.
        if (here.layer === 'domain') {
          const external = target === null
          const allowedExternal = specifier.startsWith('node:') || specifier === 'luxon'
          if (external && !allowedExternal) {
            add('R1', `domain não pode importar "${specifier}" (só node:* e luxon).`)
          }
          if (target) {
            const sameDomain = there?.key === here.key && there.layer === 'domain'
            if (!sameDomain)
              add('R1', `domain só pode importar do próprio domain (importa "${specifier}").`)
          }
        }

        // R2 — application não conhece infrastructure nem presentation do próprio módulo.
        if (here.layer === 'application' && there && there.key === here.key) {
          if (there.layer === 'infrastructure' || there.layer === 'presentation') {
            add('R2', `application não pode importar ${there.layer} ("${specifier}").`)
          }
        }
        if (here.layer === 'application' && target === null) {
          if (specifier === '@adonisjs/core/http') {
            add('R2', 'application não pode depender do HTTP do framework.')
          }
        }
      }

      if (there && here && there.key !== here.key) {
        // R4 — direcção entre grupos.
        if (here.group === 'core' && there.group !== 'core') {
          add('R4', `core não pode depender de ${there.group} ("${specifier}").`)
        }
        if (there.group === 'verticals' && here.group !== 'verticals') {
          add('R4', `${here.group} não pode depender de verticais ("${specifier}").`)
        }
        if (here.group === 'verticals' && there.group === 'verticals') {
          add('R4', `um vertical não pode depender de outro vertical ("${specifier}").`)
        }

        // R3 — entre módulos só pela API pública (index).
        if (!SHARED_KERNEL.has(there.key) && target !== `app/${there.key}/index`) {
          add(
            'R3',
            `Importe ${there.key} apenas por "${there.key}/index" (importa "${specifier}").`
          )
        }
      }
    }
  }
  return violations
}

/** Lê todos os `.ts` de `app/`. */
export function readAppSources(root: string): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        files.push({
          path: relative(root, full).split('\\').join('/'),
          source: readFileSync(full, 'utf8'),
        })
      }
    }
  }
  walk(join(root, 'app'))
  return files
}
