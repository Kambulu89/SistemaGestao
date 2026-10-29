import type { TenantContext } from '#core/tenancy/index'
import { documentResourceOf } from '#modules/documents/application/registry'
import type { Access, Authorize, DocumentRecord } from '#modules/documents/application/ports'

/**
 * Quem pode ver o quê. O acesso decide-se **no momento do pedido**: um documento de recurso deixa de se ver quando a
 * pessoa perde o acesso ao recurso, e um vínculo a um recurso apagado deixa de abrir.
 */
export class AccessPolicy {
  constructor(private readonly authorize: Authorize) {}

  async canUseResource(context: TenantContext, type: string, id: string): Promise<boolean> {
    const resource = documentResourceOf(type)
    if (!resource) return false
    if (!(await this.authorize(context, resource.permission))) return false
    return resource.exists(context, id)
  }

  async canReadDocument(context: TenantContext, doc: DocumentRecord): Promise<boolean> {
    if (doc.status !== 'ACTIVE') return false
    if (!(await this.authorize(context, 'document.read'))) return false
    if (doc.visibility === 'PRIVATE') return doc.ownerMembershipId === context.membershipId
    if (doc.visibility === 'TENANT') return true
    return doc.resourceType && doc.resourceId
      ? this.canUseResource(context, doc.resourceType, doc.resourceId)
      : false
  }

  /** Um anexo vê-se por um documento legível, por um recurso acessível ou, enquanto solto, por quem o carregou. */
  async canReadAttachment(context: TenantContext, access: Access): Promise<boolean> {
    if (!(await this.authorize(context, 'document.read'))) return false
    for (const doc of access.documents) {
      if (await this.canReadDocument(context, doc)) return true
    }
    for (const link of access.resources) {
      if (await this.canUseResource(context, link.resourceType, link.resourceId)) return true
    }
    const linked = access.documents.length > 0 || access.resources.length > 0
    return !linked && access.uploadedBy === context.membershipId
  }
}
