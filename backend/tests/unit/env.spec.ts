import { test } from '@japa/runner'
import { Env } from '@adonisjs/core/env'
import { envSchema } from '#start/env_schema'

const VALID = {
  NODE_ENV: 'test',
  PORT: '3333',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  APP_KEY: 'k'.repeat(32),
  CORS_ORIGINS: 'http://localhost:4200',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_DATABASE: 'db',
  DB_USER: 'runtime',
  DB_PASSWORD: 'pw-runtime',
  DB_OWNER_USER: 'owner',
  DB_OWNER_PASSWORD: 'pw-owner',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
}

/**
 * `Env.rules().validate()` dá prioridade a `process.env` sobre os valores recebidos; nos testes o
 * ambiente real (`.env.test`) já está carregado, por isso é retirado enquanto se valida.
 */
const validate = (values: Record<string, string | undefined>) => {
  const saved = new Map(Object.keys(envSchema).map((key) => [key, process.env[key]]))
  for (const key of saved.keys()) delete process.env[key]
  try {
    return Env.rules(envSchema).validate(values)
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test.group('validação do ambiente', () => {
  test('aceita uma configuração completa e converte os tipos', ({ assert }) => {
    const env = validate(VALID)
    assert.strictEqual(env.PORT, 3333)
    assert.strictEqual(env.DB_PORT, 5432)
    assert.strictEqual(env.NODE_ENV, 'test')
  })

  for (const key of [
    'APP_KEY',
    'DB_PASSWORD',
    'DB_OWNER_PASSWORD',
    'DB_USER',
    'DB_DATABASE',
    'REDIS_HOST',
    'CORS_ORIGINS',
  ]) {
    test(`recusa arrancar sem ${key}`, ({ assert }) => {
      const values: Record<string, string> = { ...VALID }
      delete values[key]
      assert.throws(() => validate(values))
    })
  }

  test('recusa valores inválidos', ({ assert }) => {
    assert.throws(() => validate({ ...VALID, PORT: 'abc' }))
    assert.throws(() => validate({ ...VALID, NODE_ENV: 'staging' }))
    assert.throws(() => validate({ ...VALID, LOG_LEVEL: 'verbose' }))
    assert.throws(() => validate({ ...VALID, DB_PORT: '' }))
  })

  test('a chave da aplicação é um Secret: não aparece em texto, JSON nem consola', async ({
    assert,
  }) => {
    const { appKey } = await import('#config/app')
    const value = appKey.release()
    assert.notInclude(String(appKey), value)
    assert.notInclude(JSON.stringify({ appKey }), value)
  })

  test('a conta de runtime e a de migrations são variáveis distintas', ({ assert }) => {
    const env = validate(VALID)
    assert.notStrictEqual(env.DB_USER, env.DB_OWNER_USER)
  })
})
