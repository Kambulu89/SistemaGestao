import type { ErrorDetail } from '#shared/http/api_error'

export type UserStatus = 'ACTIVE' | 'DISABLED'

/** Identidade global de quem entra no sistema; não é o colaborador (RH) nem o parceiro de negócio. */
export interface User {
  id: string
  email: string
  fullName: string
  status: UserStatus
  isPlatformAdmin: boolean
  lastLoginAt: Date | null
  version: number
  createdAt: Date
}

export const normalizeEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

/** Frases longas são bem-vindas: 12 a 128 caracteres. */
export function passwordIssues(value: unknown, path = 'password'): ErrorDetail[] {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    return [
      {
        path,
        code: 'WEAK_PASSWORD',
        message: 'A palavra-passe tem de ter entre 12 e 128 caracteres.',
      },
    ]
  }
  return []
}
