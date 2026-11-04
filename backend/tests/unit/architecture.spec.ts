import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from '@japa/runner'

const root = join(import.meta.dirname, '..', '..')
const modulesDir = join(root, 'app', 'modules')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

test.group('arquitectura | fronteiras dos módulos', () => {
  test('um módulo só importa outro pela sua API pública (index.ts)', ({ assert }) => {
    const violations: string[] = []
    for (const file of files(modulesDir)) {
      const own = relative(modulesDir, file).split('/')[0]
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/from '#modules\/([a-z_]+)\/([^']+)'/g)) {
        const [, target, rest] = match
        if (target !== own && rest !== 'index')
          violations.push(`${relative(root, file)} → ${match[0]}`)
      }
    }
    assert.deepEqual(violations, [])
  })

  test('o código partilhado (app/shared) não depende de módulos', ({ assert }) => {
    const offenders = files(join(root, 'app', 'shared')).filter((f) =>
      readFileSync(f, 'utf8').includes("'#modules/")
    )
    assert.deepEqual(offenders, [])
  })
})
