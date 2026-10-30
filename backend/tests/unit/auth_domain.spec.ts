import { test } from '@japa/runner'
import { isValidEmail, normalizeEmail } from '#core/auth/domain/email'
import { passwordIssues } from '#core/auth/domain/password_policy'
import { generateOpaqueToken, hashToken, safeEqual } from '#core/auth/domain/tokens'
import { canLogin, isSessionActive, type AuthSession, type User } from '#core/auth/domain/identity'
import {
  canTransition,
  isOperational,
  isValidHostname,
  isValidTenantCode,
  normalizeHostname,
} from '#platform/tenants/domain/tenant'

const user = (over: Partial<User> = {}): User => ({
  id: 'u1',
  email: 'a@b.pt',
  displayName: 'A',
  passwordHash: 'hash',
  emailVerifiedAt: new Date(),
  status: 'ACTIVE',
  locale: null,
  ...over,
})

test.group('email', () => {
  test('normaliza para minúsculas e sem espaços', ({ assert }) => {
    assert.strictEqual(normalizeEmail('  Ana@Exemplo.PT '), 'ana@exemplo.pt')
  })

  test('valida a forma do endereço', ({ assert }) => {
    assert.isTrue(isValidEmail('ana@exemplo.pt'))
    for (const bad of ['', 'ana', 'ana@', '@exemplo.pt', 'a b@exemplo.pt', 'ana@exemplo']) {
      assert.isFalse(isValidEmail(bad), bad)
    }
  })
})

test.group('política de palavras-passe', () => {
  test('aceita uma frase longa', ({ assert }) => {
    assert.deepEqual(passwordIssues('uma frase bastante longa'), [])
  })

  test('rejeita curta, igual ao email, trivial e demasiado longa', ({ assert }) => {
    assert.include(passwordIssues('curta'), 'TOO_SHORT')
    assert.include(passwordIssues('ana@exemplo.pt', { email: 'ANA@exemplo.pt' }), 'SAME_AS_EMAIL')
    assert.include(passwordIssues('aaaaaaaaaaaaaaaa'), 'TOO_COMMON')
    assert.include(passwordIssues('password1234'), 'TOO_COMMON')
    assert.include(passwordIssues('x'.repeat(129)), 'TOO_LONG')
  })
})

test.group('tokens opacos', () => {
  test('são aleatórios, de 256 bits e o hash não revela o token', ({ assert }) => {
    const a = generateOpaqueToken()
    assert.notStrictEqual(a, generateOpaqueToken())
    assert.lengthOf(Buffer.from(a, 'base64url'), 32)
    assert.notInclude(hashToken(a), a)
    assert.strictEqual(hashToken(a), hashToken(a))
  })

  test('safeEqual compara em tempo constante e trata tamanhos diferentes', ({ assert }) => {
    assert.isTrue(safeEqual('abc', 'abc'))
    assert.isFalse(safeEqual('abc', 'abd'))
    assert.isFalse(safeEqual('abc', 'abcd'))
  })
})

test.group('sessões e contas', () => {
  const session = (over: Partial<AuthSession> = {}): AuthSession => ({
    id: 's',
    userId: 'u1',
    expiresAt: new Date(Date.now() + 1000),
    revokedAt: null,
    lastSeenAt: new Date(),
    createdAt: new Date(),
    ip: null,
    userAgent: null,
    ...over,
  })

  test('uma sessão expirada ou revogada não está activa', ({ assert }) => {
    const now = new Date()
    assert.isTrue(isSessionActive(session(), now))
    assert.isFalse(isSessionActive(session({ expiresAt: new Date(now.getTime() - 1) }), now))
    assert.isFalse(isSessionActive(session({ revokedAt: now }), now))
  })

  test('só contas activas com palavra-passe iniciam sessão', ({ assert }) => {
    assert.isTrue(canLogin(user()))
    assert.isFalse(canLogin(user({ status: 'PENDING' })))
    assert.isFalse(canLogin(user({ status: 'BLOCKED' })))
    assert.isFalse(canLogin(user({ passwordHash: null })))
  })
})

test.group('tenant', () => {
  test('máquina de estados do ciclo de vida', ({ assert }) => {
    assert.isTrue(canTransition('PROVISIONING', 'ACTIVE'))
    assert.isTrue(canTransition('ACTIVE', 'SUSPENDED'))
    assert.isTrue(canTransition('SUSPENDED', 'ACTIVE'))
    assert.isTrue(canTransition('SUSPENDED', 'CLOSING'))
    assert.isTrue(canTransition('CLOSING', 'CLOSED'))
    assert.isFalse(canTransition('PROVISIONING', 'SUSPENDED'))
    assert.isFalse(canTransition('ACTIVE', 'CLOSED'))
    assert.isFalse(canTransition('CLOSED', 'ACTIVE'))
    assert.isFalse(canTransition('CLOSING', 'ACTIVE'))
  })

  test('só um tenant activo é operacional', ({ assert }) => {
    assert.isTrue(isOperational('ACTIVE'))
    for (const s of ['PROVISIONING', 'SUSPENDED', 'CLOSING', 'CLOSED'] as const) {
      assert.isFalse(isOperational(s))
    }
  })

  test('código e domínio válidos', ({ assert }) => {
    assert.isTrue(isValidTenantCode('demo_a1'))
    for (const bad of ['', 'A', 'Demo', 'a-b', 'a b', 'x'.repeat(51)]) {
      assert.isFalse(isValidTenantCode(bad), bad)
    }
    assert.strictEqual(normalizeHostname(' Empresa.Exemplo.AO. '), 'empresa.exemplo.ao')
    assert.isTrue(isValidHostname('empresa.exemplo.ao'))
    for (const bad of [
      'localhost',
      'a..b',
      '-a.b',
      'a_b.pt',
      '*.pt',
      'http://a.pt',
      'a.pt/x',
      'a.pt:80',
    ]) {
      assert.isFalse(isValidHostname(bad), bad)
    }
  })
})
