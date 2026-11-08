import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { type ListQuery, ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';

interface AuditEvent {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  metadata: Record<string, unknown> | null;
  requestId: string | null;
  actor: { userId: string; fullName: string | null; email: string } | null;
}

const LIMIT = 50;

/** Datas do filtro (dia local) para instantes ISO, como a API espera. */
export function auditQuery(q: ListQuery): ListQuery {
  const out = { ...q };
  if (typeof q['from'] === 'string') out['from'] = new Date(`${q['from']}T00:00:00`).toISOString();
  if (typeof q['to'] === 'string') out['to'] = new Date(`${q['to']}T23:59:59.999`).toISOString();
  return out;
}

/** Registo de auditoria (EntityListPage, só leitura): filtros por acção, entidade e período na URL. */
@Component({
  selector: 'app-audit',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Auditoria"
      subtitle="Operações sensíveis registadas nesta empresa."
      permission="audit.read"
    >
      <app-filter-bar
        id="audit"
        label="auditoria"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Eventos de auditoria"
        tableId="audit"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        emptyText="Sem eventos."
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="action" let-e
          ><span class="font-mono text-xs">{{ e.action }}</span></ng-template
        >
        <ng-template appCell="entity" let-e>
          <span class="text-xs"
            >{{ e.entityType }}<br /><span class="text-muted">{{ e.entityId ?? '' }}</span></span
          >
        </ng-template>
        <ng-template appCell="detail" let-e>
          <div class="text-xs">
            @for (c of changes(e); track c.field) {
              <div>
                <strong>{{ c.field }}</strong
                >: {{ c.from }} → {{ c.to }}
              </div>
            }
            @if (e.metadata) {
              <details>
                <summary class="cursor-pointer text-muted">Metadados</summary>
                <pre class="mt-1 whitespace-pre-wrap">{{ json(e.metadata) }}</pre>
              </details>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Audit {
  private readonly api = inject(Api);
  protected readonly filters: FilterDef[] = [
    { key: 'action', label: 'Acção', type: 'text', placeholder: 'ex.: member.*' },
    { key: 'entityType', label: 'Entidade', type: 'text', placeholder: 'ex.: legal_entity' },
    { key: 'from', label: 'Desde', type: 'date' },
    { key: 'to', label: 'Até', type: 'date' },
  ];
  protected readonly columns: Column<AuditEvent>[] = [
    {
      key: 'occurredAt',
      label: 'Quando',
      required: true,
      value: (e) => formatDateTime(e.occurredAt),
    },
    {
      key: 'actor',
      label: 'Quem',
      value: (e) => e.actor?.fullName ?? e.actor?.email ?? 'Sistema',
    },
    { key: 'action', label: 'Acção' },
    { key: 'entity', label: 'Entidade', hideOnMobile: true },
    { key: 'detail', label: 'Detalhe', hideOnMobile: true },
  ];
  protected readonly list = new ListState<AuditEvent>(this.api, {
    url: 'audit-events',
    filterKeys: ['action', 'entityType', 'from', 'to'],
    limit: LIMIT,
    transform: auditQuery,
  });

  protected changes(e: AuditEvent) {
    const show = (v: unknown) =>
      v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return Object.entries(e.changes ?? {}).map(([field, c]) => ({
      field,
      from: show(c.from),
      to: show(c.to),
    }));
  }

  protected json(value: unknown) {
    return JSON.stringify(value, null, 2);
  }
}
