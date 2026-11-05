import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { Pager } from '../ui/pager';

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

/** Registo de auditoria (só leitura), com filtros por acção, entidade e período. */
@Component({
  selector: 'app-audit',
  imports: [FormsModule, PageHeader, ErrorAlert, Pager],
  template: `
    <app-page-header title="Auditoria" subtitle="Operações sensíveis registadas nesta empresa." />
    <form class="card mb-4 grid gap-3 md:grid-cols-5" role="search" (ngSubmit)="go(0)">
      <div>
        <label class="label" for="action">Acção</label>
        <input
          id="action"
          name="action"
          class="input"
          placeholder="ex.: member.*"
          [(ngModel)]="filters.action"
        />
      </div>
      <div>
        <label class="label" for="entityType">Entidade</label>
        <input
          id="entityType"
          name="entityType"
          class="input"
          placeholder="ex.: legal_entity"
          [(ngModel)]="filters.entityType"
        />
      </div>
      <div>
        <label class="label" for="from">Desde</label>
        <input id="from" name="from" type="date" class="input" [(ngModel)]="filters.from" />
      </div>
      <div>
        <label class="label" for="to">Até</label>
        <input id="to" name="to" type="date" class="input" [(ngModel)]="filters.to" />
      </div>
      <div class="flex items-end"><button type="submit" class="btn-secondary">Filtrar</button></div>
    </form>
    <app-error-alert [error]="page.error()" />
    @if (page.loading()) {
      <p class="text-sm text-slate-500">A carregar…</p>
    } @else if ((page.value()?.items ?? []).length === 0) {
      <p class="card text-sm text-slate-600">Sem eventos.</p>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Eventos de auditoria">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Quem</th>
              <th>Acção</th>
              <th>Entidade</th>
              <th>Detalhe</th>
            </tr>
          </thead>
          <tbody>
            @for (e of page.value()?.items; track e.id) {
              <tr>
                <td class="whitespace-nowrap">{{ when(e.occurredAt) }}</td>
                <td>{{ e.actor?.fullName ?? e.actor?.email ?? 'Sistema' }}</td>
                <td class="font-mono text-xs">{{ e.action }}</td>
                <td class="text-xs">
                  {{ e.entityType }}<br /><span class="text-slate-500">{{ e.entityId ?? '' }}</span>
                </td>
                <td class="text-xs">
                  @for (c of changes(e); track c.field) {
                    <div>
                      <strong>{{ c.field }}</strong
                      >: {{ c.from }} → {{ c.to }}
                    </div>
                  }
                  @if (e.metadata) {
                    <details>
                      <summary class="cursor-pointer text-slate-600">Metadados</summary>
                      <pre class="mt-1 whitespace-pre-wrap">{{ json(e.metadata) }}</pre>
                    </details>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <app-pager
        [total]="page.value()?.total ?? 0"
        [limit]="limit"
        [offset]="offset()"
        (offsetChange)="go($event)"
      />
    }
  `,
})
export class Audit {
  private readonly api = inject(Api);
  protected readonly limit = LIMIT;
  protected readonly when = formatDateTime;
  protected readonly offset = signal(0);
  protected filters = { action: '', entityType: '', from: '', to: '' };
  protected readonly page = new Loadable(() =>
    this.api.page<AuditEvent>('audit-events', {
      action: this.filters.action.trim() || undefined,
      entityType: this.filters.entityType.trim() || undefined,
      from: this.filters.from ? new Date(`${this.filters.from}T00:00:00`).toISOString() : undefined,
      to: this.filters.to ? new Date(`${this.filters.to}T23:59:59.999`).toISOString() : undefined,
      limit: LIMIT,
      offset: this.offset(),
    }),
  );

  constructor() {
    void this.page.load();
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

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
