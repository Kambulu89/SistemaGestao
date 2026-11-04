import type { ErrorDetail } from '#shared/http/api_error'
import { PERMISSION_CODES } from '#modules/rbac/domain/permissions'

export type RoleStatus = 'ACTIVE' | 'INACTIVE'

export interface Role {
  id: string
  code: string
  name: string
  description: string | null
  isSystem: boolean
  status: RoleStatus
  permissionCodes: string[]
  version: number
}

export interface RoleValues {
  code: string
  name: string
  description: string | null
  status: RoleStatus
  permissionCodes: string[]
}

const CODE = /^[a-z][a-z0-9_]{1,49}$/

/** Valida um perfil; numa alteração (`base`) o código não muda. */
export function normalizeRole(
  input: {
    code?: unknown
    name?: unknown
    description?: unknown
    status?: unknown
    permissionCodes?: unknown
  },
  base: RoleValues | null
): { values: RoleValues | null; issues: ErrorDetail[] } {
  const issues: ErrorDetail[] = []
  if (base && input.code !== undefined && input.code !== base.code) {
    issues.push({ path: 'code', code: 'IMMUTABLE', message: 'O código não se altera.' })
  }
  const code = base?.code ?? String(input.code ?? '').trim()
  if (!CODE.test(code)) {
    issues.push({
      path: 'code',
      code: 'INVALID_CODE',
      message: 'Código: minúsculas, números e _ (2 a 50).',
    })
  }
  const name = String(input.name ?? base?.name ?? '').trim()
  if (name.length < 2 || name.length > 120) {
    issues.push({ path: 'name', code: 'INVALID_NAME', message: 'Nome: 2 a 120 caracteres.' })
  }
  const rawDescription = input.description === undefined ? base?.description : input.description
  const description =
    typeof rawDescription === 'string' && rawDescription.trim() ? rawDescription.trim() : null
  if (description && description.length > 500) {
    issues.push({
      path: 'description',
      code: 'TOO_LONG',
      message: 'Descrição: até 500 caracteres.',
    })
  }
  const status = (input.status ?? base?.status ?? 'ACTIVE') as RoleStatus
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    issues.push({ path: 'status', code: 'INVALID_STATUS', message: 'Estado: ACTIVE ou INACTIVE.' })
  }
  const rawCodes =
    input.permissionCodes === undefined ? base?.permissionCodes : input.permissionCodes
  const permissionCodes = Array.isArray(rawCodes) ? [...new Set(rawCodes.map(String))].sort() : []
  for (const permission of permissionCodes) {
    if (!PERMISSION_CODES.has(permission)) {
      issues.push({
        path: 'permissionCodes',
        code: 'UNKNOWN_PERMISSION',
        message: `Permissão inexistente: ${permission}.`,
      })
    }
  }
  if (issues.length > 0) return { values: null, issues }
  return { values: { code, name, description, status, permissionCodes }, issues }
}
