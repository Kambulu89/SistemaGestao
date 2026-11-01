import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Token opaco de 256 bits (base64url). É o que o cliente guarda; o servidor só guarda o hash. */
export const generateOpaqueToken = (): string => randomBytes(32).toString('base64url')

/**
 * SHA-256 do token. Basta um hash rápido porque o token tem 256 bits de entropia (não é uma
 * palavra-passe escolhida por uma pessoa); a base nunca guarda o token em claro.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
