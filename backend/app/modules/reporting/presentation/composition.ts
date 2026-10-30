import { iamServices } from '#core/permissions/index'
import { LucidMembershipStore } from '#core/membership/index'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import { LucidTenantStore, isOperational, tenantServices } from '#platform/tenants/index'
import { documentServices } from '#modules/documents/index'
import { DashboardUseCases, ReportUseCases } from '#modules/reporting/application/report_use_cases'
import { ExportUseCases } from '#modules/reporting/application/export_use_cases'
import { QueryService } from '#modules/reporting/application/query_service'
import { SearchUseCases } from '#modules/reporting/application/search_use_cases'
import type {
  Authorizer,
  ContextResolver,
  GeneratedFiles,
} from '#modules/reporting/application/ports'
import {
  LucidDashboardStore,
  LucidExportStore,
  LucidQueryRunner,
  LucidReportStore,
  LucidSearchStore,
} from '#modules/reporting/infrastructure/lucid_reporting'

const authorizer: Authorizer = {
  async decide(context, permission) {
    const decision = await iamServices().authorize.decision(context, permission)
    return { allowed: decision.allowed, hiddenFields: decision.hiddenFields }
  },
}

/** Os ficheiros das exportações guardam-se pelos documentos (quota e armazenamento são deles). */
const files: GeneratedFiles = {
  store: (context, file) => documentServices().attachments.storeGenerated(context, file),
  open: (context, id) => documentServices().attachments.openGenerated(context, id),
  remove: (context, id) => documentServices().attachments.removeGenerated(context, id),
}

function build() {
  const uow = new LucidTenantDatabase()
  const clock = { now: () => new Date() }
  const memberships = new LucidMembershipStore()
  const tenants = new LucidTenantStore()
  const reports = new LucidReportStore()
  const dashboards = new LucidDashboardStore()
  const exportsStore = new LucidExportStore()
  const searchStore = new LucidSearchStore()

  const resolver: ContextResolver = {
    /** Quem pediu o trabalho, com a membership e o tenant validados agora (senão `null`). */
    async forMembership(tenantId, membershipId) {
      const service = serviceTenantContext(tenantId, `resolve-${membershipId}`)
      const membership = await uow.run(
        (scope) => memberships.findById(scope, membershipId),
        service
      )
      if (!membership) return null
      try {
        const resolved = await tenantServices().resolveTenantContext.execute({
          user: { id: membership.userId, locale: null },
          selector: { tenantId },
          correlationId: `export-${membershipId}`,
        })
        return resolved.context.membershipId === membershipId ? resolved.context : null
      } catch {
        return null
      }
    },
    async tenantIds() {
      const all = await tenants.list()
      return all.filter((t) => isOperational(t.status)).map((t) => t.id)
    },
  }

  const query = new QueryService(uow, new LucidQueryRunner(), authorizer, clock)
  const reportCases = new ReportUseCases(uow, reports, query, clock)
  return {
    query,
    reports: reportCases,
    dashboards: new DashboardUseCases(uow, dashboards, reports, reportCases),
    exports: new ExportUseCases(uow, exportsStore, reports, query, authorizer, files, clock),
    search: new SearchUseCases(uow, searchStore, authorizer),
    resolver,
  }
}

let instance: ReturnType<typeof build> | undefined

export const reportingServices = () => (instance ??= build())
