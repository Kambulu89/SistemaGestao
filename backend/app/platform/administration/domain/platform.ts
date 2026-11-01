/**
 * Administração da plataforma (SaaS) — distinta da administração do tenant. Permissões de plataforma
 * nunca vêm de papéis de tenant e **não** dão acesso a dados empresariais de nenhum tenant.
 */
export const PLATFORM_PERMISSIONS = ['platform.tenant.manage', 'platform.billing.manage'] as const
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number]

export const isPlatformPermission = (value: string): value is PlatformPermission =>
  (PLATFORM_PERMISSIONS as readonly string[]).includes(value)

export interface PlatformGrant {
  id: string
  userId: string
  permission: PlatformPermission
  reason: string
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

/** Concessão em vigor: não revogada e não expirada. */
export const grantActive = (grant: Pick<PlatformGrant, 'expiresAt' | 'revokedAt'>, now: Date) =>
  grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now)

/** Passos do provisionamento de um tenant (cada um idempotente). */
export const PROVISIONING_STEPS = [
  'TENANT',
  'SUBSCRIPTION',
  'ADMIN_ROLE',
  'ORGANIZATION',
  'ADMIN_INVITATION',
  'ACTIVATION',
] as const
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number]
