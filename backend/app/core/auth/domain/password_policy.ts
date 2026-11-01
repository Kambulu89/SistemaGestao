export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

export type PasswordIssue = 'TOO_SHORT' | 'TOO_LONG' | 'SAME_AS_EMAIL' | 'TOO_COMMON'

const COMMON = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'letmein12345',
  'administrator',
  'changeme1234',
])

/**
 * Política de palavras-passe: comprimento (12–128) em vez de regras de composição, sem repetir o
 * email nem uma lista mínima de valores triviais. Os limites são parâmetros de demonstração a validar
 * com o produto (decisão registada em docs/decisions.md).
 */
export function passwordIssues(
  password: string,
  context: { email?: string } = {}
): PasswordIssue[] {
  const issues: PasswordIssue[] = []
  if (password.length < PASSWORD_MIN_LENGTH) issues.push('TOO_SHORT')
  if (password.length > PASSWORD_MAX_LENGTH) issues.push('TOO_LONG')
  const lower = password.toLowerCase()
  if (context.email && lower === context.email.toLowerCase()) issues.push('SAME_AS_EMAIL')
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) issues.push('TOO_COMMON')
  return issues
}

export const PASSWORD_ISSUE_MESSAGES: Record<PasswordIssue, string> = {
  TOO_SHORT: `A palavra-passe deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  TOO_LONG: `A palavra-passe não pode ter mais de ${PASSWORD_MAX_LENGTH} caracteres.`,
  SAME_AS_EMAIL: 'A palavra-passe não pode ser igual ao email.',
  TOO_COMMON: 'A palavra-passe é demasiado comum.',
}
