import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import {
  checkArchitecture,
  importSpecifiers,
  readAppSources,
  type SourceFile,
} from '#tests/support/architecture'

const file = (path: string, source: string): SourceFile => ({ path, source })
const rules = (files: SourceFile[]) => checkArchitecture(files).map((v) => v.rule)

test.group('fronteiras de módulo: o código real', () => {
  test('app/ cumpre todas as regras de arquitectura', ({ assert }) => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const files = readAppSources(root)
    assert.isAbove(files.length, 10) // garante que a análise leu mesmo o código
    assert.deepEqual(checkArchitecture(files), [])
  })
})

test.group('fronteiras de módulo: detecção (controlos negativos)', () => {
  test('lê imports estáticos, re-exports e dinâmicos; ignora comentários', ({ assert }) => {
    const source = `
      import a from '#core/x/index'
      import type { B } from './b.js'
      export { c } from "../c.js"
      const d = () => import('@adonisjs/core/http')
      // import ignorado from '#core/comentario'
      /* import tambem from 'ignorado' */
    `
    assert.sameMembers(importSpecifiers(source), [
      '#core/x/index',
      './b.js',
      '../c.js',
      '@adonisjs/core/http',
    ])
  })

  test('R1: domain só depende do próprio domain', ({ assert }) => {
    assert.deepEqual(rules([file('app/core/m/domain/a.ts', `import x from './b.js'`)]), [])
    assert.include(
      rules([file('app/core/m/domain/a.ts', `import x from '#core/m/infrastructure/repo'`)]),
      'R1'
    )
    assert.include(
      rules([file('app/core/m/domain/a.ts', `import { db } from '@adonisjs/lucid'`)]),
      'R1'
    )
    assert.include(
      rules([file('app/core/m/domain/a.ts', `import e from '#core/http/api_error'`)]),
      'R1'
    )
    assert.deepEqual(
      rules([file('app/core/m/domain/a.ts', `import { DateTime } from 'luxon'`)]),
      []
    )
  })

  test('R2: application não importa infrastructure nem presentation nem o HTTP do framework', ({
    assert,
  }) => {
    assert.include(
      rules([file('app/core/m/application/uc.ts', `import r from '#core/m/infrastructure/repo'`)]),
      'R2'
    )
    assert.include(
      rules([
        file('app/core/m/application/uc.ts', `import c from '../presentation/controller.js'`),
      ]),
      'R2'
    )
    assert.include(
      rules([
        file('app/core/m/application/uc.ts', `import { HttpContext } from '@adonisjs/core/http'`),
      ]),
      'R2'
    )
    assert.deepEqual(
      rules([file('app/core/m/application/uc.ts', `import d from '#core/m/domain/entity'`)]),
      []
    )
  })

  test('R3: entre módulos só pela API pública (index)', ({ assert }) => {
    const other = `import x from '#core/tenancy/infrastructure/tenant_repository'`
    assert.include(rules([file('app/modules/crm/application/uc.ts', other)]), 'R3')
    assert.deepEqual(
      rules([file('app/modules/crm/application/uc.ts', `import x from '#core/tenancy/index'`)]),
      []
    )
    // O kernel HTTP é partilhado.
    assert.deepEqual(
      rules([
        file(
          'app/modules/crm/presentation/c.ts',
          `import { ApiError } from '#core/http/api_error'`
        ),
      ]),
      []
    )
  })

  test('R4: direcção entre grupos e verticais isolados', ({ assert }) => {
    assert.include(
      rules([
        file('app/core/tenancy/application/a.ts', `import x from '../../../modules/crm/index.js'`),
      ]),
      'R4'
    )
    assert.include(
      rules([
        file(
          'app/modules/crm/application/a.ts',
          `import x from '../../../verticals/training/index.js'`
        ),
      ]),
      'R4'
    )
    assert.include(
      rules([
        file('app/verticals/school/application/a.ts', `import x from '../../training/index.js'`),
      ]),
      'R4'
    )
    assert.deepEqual(
      rules([
        file(
          'app/verticals/training/application/a.ts',
          `import x from '../../../core/tenancy/index.js'`
        ),
      ]),
      []
    )
  })

  test('R5: nunca eval, new Function, child_process ou vm', ({ assert }) => {
    for (const source of [
      'const r = eval(code)',
      'const f = new Function("a", "return a")',
      `import cp from 'node:child_process'`,
      `import vm from 'vm'`,
    ]) {
      assert.include(rules([file('app/core/m/application/a.ts', source)]), 'R5', source)
    }
    // Menções em comentários não contam.
    assert.deepEqual(
      rules([file('app/core/m/application/a.ts', '// nunca usar eval(x)\nexport const a = 1')]),
      []
    )
  })

  test('R6: só a infraestrutura acede à base de dados', ({ assert }) => {
    const lucid = `import db from '@adonisjs/lucid/services/db'`
    assert.include(rules([file('app/core/m/presentation/c.ts', lucid)]), 'R6')
    assert.include(rules([file('app/core/m/application/uc.ts', lucid)]), 'R6')
    assert.include(rules([file('app/exceptions/handler.ts', `import pg from 'pg'`)]), 'R6')
    assert.deepEqual(rules([file('app/core/m/infrastructure/repo.ts', lucid)]), [])
  })
})
