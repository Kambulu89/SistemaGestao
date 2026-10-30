import { randomUUID } from 'node:crypto'
import {
  serviceTenantContext,
  type TenantContext,
  type TenantUnitOfWork,
} from '#core/tenancy/index'
import { searchTerms, snippetOf } from '#modules/reporting/domain/reporting'
import { failure } from '#modules/reporting/application/errors'
import type { Authorizer, SearchStore } from '#modules/reporting/application/ports'
import { allSearchSources, searchSourceOf } from '#modules/reporting/application/registry'

const BATCH = 200

export interface SearchGroup {
  type: string
  label: string
  path: string
  items: { id: string; title: string; snippet: string }[]
}

/**
 * Pesquisa global sobre um índice derivado e reconstruível (`search_documents`). A autorização acontece antes de
 * devolver títulos e excertos: o tipo exige a sua permissão e cada resultado é revalidado no módulo dono (visibilidade,
 * âmbito). O índice reconstrói-se de forma idempotente; não há actualização incremental por eventos (ver D-060).
 */
export class SearchUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: SearchStore,
    private readonly authorizer: Authorizer
  ) {}

  async search(
    context: TenantContext,
    q: string,
    types: string[] | undefined,
    limit: number
  ): Promise<{ query: string; groups: SearchGroup[]; indexedAt: string | null }> {
    const terms = searchTerms(q)
    if (terms.length === 0) throw failure('q', 'TOO_SHORT', 'Escreva pelo menos 2 caracteres.')
    const groups: SearchGroup[] = []
    for (const source of allSearchSources()) {
      if (types && !types.includes(source.type)) continue
      const decision = await this.authorizer.decide(context, source.permission)
      if (!decision.allowed) continue
      // Pede-se mais do que o limite porque alguns resultados serão recusados pela revalidação.
      const hits = await this.uow.run(
        (scope) => this.store.query(scope, source.type, terms, limit * 4),
        context
      )
      const items: SearchGroup['items'] = []
      for (const hit of hits) {
        if (items.length >= limit) break
        if (!(await source.canRead(context, hit.resourceId))) continue
        items.push({ id: hit.resourceId, title: hit.title, snippet: snippetOf(hit.text, terms) })
      }
      if (items.length > 0)
        groups.push({ type: source.type, label: source.label, path: source.path, items })
    }
    const status = await this.uow.run((scope) => this.store.status(scope), context)
    const newest = status.map((s) => s.indexedAt).filter((d): d is Date => d !== null)
    const last = newest.length ? new Date(Math.max(...newest.map((d) => d.getTime()))) : null
    return { query: q, groups, indexedAt: last ? last.toISOString() : null }
  }

  async status(context: TenantContext) {
    return this.uow.run(async (scope) => {
      const rows = await this.store.status(scope)
      return rows.map((r) => ({
        type: r.resourceType,
        label: searchSourceOf(r.resourceType)?.label ?? r.resourceType,
        documents: r.documents,
        indexedAt: r.indexedAt ? r.indexedAt.toISOString() : null,
      }))
    }, context)
  }

  /** Reconstrói o índice de um tenant, tipo a tipo. Repetir dá o mesmo resultado; o que desapareceu da origem sai. */
  async reindex(
    tenantId: string,
    only?: string[]
  ): Promise<{ type: string; indexed: number; removed: number }[]> {
    const service = serviceTenantContext(tenantId, `reindex-${randomUUID()}`)
    const out: { type: string; indexed: number; removed: number }[] = []
    for (const source of allSearchSources()) {
      if (only && !only.includes(source.type)) continue
      const version =
        (await this.uow.run((scope) => this.store.currentVersion(scope, source.type), service)) + 1
      let after: string | null = null
      let indexed = 0
      do {
        const cursor: string | null = after
        const page = await this.uow.run(async (scope) => {
          const scanned = await source.scan(scope, cursor, BATCH)
          await this.store.upsert(scope, source.type, scanned.items, version)
          return scanned
        }, service)
        indexed += page.items.length
        after = page.next
      } while (after)
      const removed = await this.uow.run(
        (scope) => this.store.prune(scope, source.type, version),
        service
      )
      out.push({ type: source.type, indexed, removed })
    }
    return out
  }
}
