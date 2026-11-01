import type { HttpContext } from '@adonisjs/core/http'
import { envelope } from '#core/http/api_response'
import { iamServices, redactFields } from '#core/permissions/index'
import { AUDIT_READ_PERMISSION } from '#core/audit/domain/security_event'
import { camelKeys, snakeCase } from '#core/audit/domain/redaction'
import { auditServices } from '#core/audit/presentation/composition'
import { auditQueryValidator, pageValidator } from '#core/audit/presentation/validators'

/** Campos que as regras de campo (C06) escondem a este actor em `party.read`, já em snake_case (as colunas). */
function hiddenColumns(fields: readonly string[]): string[] {
  return fields.map(snakeCase)
}

export default class AuditController {
  /**
   * Histórico de alterações. Cada recurso só aparece a quem pode **ler** esse recurso (RBAC) e os campos
   * escondidos pelas regras de campo saem das diferenças (antes/depois), tal como na API do próprio recurso.
   */
  async list(ctx: HttpContext) {
    const query = await ctx.request.validateUsing(auditQueryValidator, { data: ctx.request.qs() })
    const context = ctx.tenantContext

    const permissions = [...new Set(Object.values(AUDIT_READ_PERMISSION))]
    const decisions = new Map(
      await Promise.all(
        permissions.map(
          async (p) => [p, await iamServices().authorize.decision(context, p)] as const
        )
      )
    )
    const allowedResourceTypes = Object.entries(AUDIT_READ_PERMISSION)
      .filter(([, permission]) => decisions.get(permission)?.allowed)
      .map(([resourceType]) => resourceType)

    const entries = await auditServices.uow.run(
      (scope) =>
        auditServices.audit.list(scope, {
          ...query,
          allowedResourceTypes,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
        }),
      context
    )

    const data = entries.map((entry) => {
      const hidden = hiddenColumns(
        decisions.get(AUDIT_READ_PERMISSION[entry.resourceType] ?? '')?.hiddenFields ?? []
      )
      const strip = (row: Record<string, unknown> | null) =>
        row === null ? null : camelKeys(redactFields(row, hidden))
      return { ...entry, before: strip(entry.before), after: strip(entry.after) }
    })
    return envelope(ctx, data)
  }

  async securityEvents(ctx: HttpContext) {
    const { limit, offset } = await ctx.request.validateUsing(pageValidator, {
      data: ctx.request.qs(),
    })
    const events = await auditServices.uow.run(
      (scope) => auditServices.events.listForTenant(scope, limit ?? 50, offset ?? 0),
      ctx.tenantContext
    )
    return envelope(ctx, events)
  }

  /** Actividade da própria conta (login, palavra-passe…). Não exige tenant. */
  async myEvents(ctx: HttpContext) {
    const { limit } = await ctx.request.validateUsing(pageValidator, { data: ctx.request.qs() })
    return envelope(ctx, await auditServices.events.listForUser(ctx.principal.user.id, limit ?? 50))
  }
}
