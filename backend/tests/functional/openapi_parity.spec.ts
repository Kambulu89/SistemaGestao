import { readFileSync } from 'node:fs'
import { test } from '@japa/runner'
import { parse } from 'yaml'
import router from '@adonisjs/core/services/router'

const IGNORED = new Set(['HEAD'])

const toOpenApiPath = (pattern: string) =>
  pattern.replace(/^\/api\/v1/, '').replaceAll(/:(\w+)/g, '{$1}')

test.group('OpenAPI | paridade com as rotas', () => {
  test('cada rota registada está documentada e vice-versa', ({ assert }) => {
    const spec = parse(readFileSync('openapi/openapi.yaml', 'utf8')) as {
      paths: Record<string, Record<string, unknown>>
    }
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
      )
    )

    const registered = new Set<string>()
    for (const routes of Object.values(router.toJSON())) {
      for (const route of routes) {
        for (const method of route.methods) {
          if (IGNORED.has(method)) continue
          registered.add(`${method} ${toOpenApiPath(route.pattern)}`)
        }
      }
    }

    assert.isAbove(registered.size, 5)
    assert.deepEqual([...registered].sort(), [...documented].sort())
  })
})
