import hash from '@adonisjs/core/services/hash'
import type { PasswordHasher } from '#core/auth/application/ports'

/** scrypt (config/hash.ts). O formato PHC do hash carrega os parâmetros, o que permite rehash gradual. */
export class ScryptPasswordHasher implements PasswordHasher {
  hash(password: string) {
    return hash.make(password)
  }

  async verify(hashed: string, password: string) {
    try {
      return await hash.verify(hashed, password)
    } catch {
      // Hash malformado: tratar como falha de credenciais, nunca como erro interno.
      return false
    }
  }

  needsRehash(hashed: string) {
    return hash.needsReHash(hashed)
  }
}
