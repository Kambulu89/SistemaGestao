/** Normalização usada para guardar, comparar e limitar tentativas: minúsculas e sem espaços nas pontas. */
export const normalizeEmail = (email: string): string =>
  email.normalize('NFKC').trim().toLowerCase()

const MAX_EMAIL = 254
// Validação deliberadamente simples: a prova de que o email existe é a verificação por token.
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL && SHAPE.test(email)
}
