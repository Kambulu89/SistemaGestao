import { createHash, randomBytes } from 'node:crypto'

/** SHA-256 do token (256 bits de entropia: um hash rápido chega). A base nunca guarda o token. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'

export interface Invitation {
  id: string
  email: string
  invitedByMembershipId: string | null
  expiresAt: Date
  acceptedAt: Date | null
  status: InvitationStatus
  roleIds: string[]
  unitIds: string[]
  version: number
}

/** Parâmetros de demonstração (validar com o produto): validade por omissão e máxima, e limites de listas. */
export const INVITATION_DEFAULT_DAYS = 7
export const INVITATION_MAX_DAYS = 30
export const INVITATION_MAX_ITEMS = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Token do convite: `<tenantId>.<segredo de 256 bits>`. O id do tenant serve só para localizar a linha
 * (a RLS exige um tenant); a prova é o segredo, de que a base guarda apenas o SHA-256.
 */
export function newInvitationToken(tenantId: string): { token: string; tokenHash: string } {
  const token = `${tenantId}.${randomBytes(32).toString('base64url')}`
  return { token, tokenHash: hashToken(token) }
}

export function parseInvitationToken(
  token: string
): { tenantId: string; tokenHash: string } | null {
  const [tenantId, secret, ...rest] = token.split('.')
  if (rest.length > 0 || !tenantId || !secret || !UUID.test(tenantId) || secret.length < 20) {
    return null
  }
  return { tenantId, tokenHash: hashToken(token) }
}

/** O estado "EXPIRED" é derivado: um convite pendente depois do prazo já não pode ser aceite. */
export function effectiveStatus(invitation: Invitation, now: Date): InvitationStatus {
  return invitation.status === 'PENDING' && invitation.expiresAt.getTime() <= now.getTime()
    ? 'EXPIRED'
    : invitation.status
}
