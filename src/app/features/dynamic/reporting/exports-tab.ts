import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { ReportingApi, type ExportDto } from './reporting.api';
import { EXPORT_STATUS, errorTextOf, reportingError } from './reporting-model';

const POLL_MS = 3000;

/**
 * Exportações assíncronas em CSV. O ficheiro só existe depois de o trabalhador o gerar; ao descarregar, o servidor
 * revalida o acesso a este momento (uma exportação pronta deixa de se poder descarregar se a pessoa perdeu o acesso).
 */
@Component({
  selector: 'app-exports-tab',
  imports: [Alert, Badge, Button, Card, EmptyState, LoadingState, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="mb-3 text-sm text-fg-muted">
      As exportações correm em segundo plano com os seus direitos de acesso e expiram ao fim de 24
      horas. Peça-as a partir de um relatório publicado.
    </p>
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block" data-testid="export-error">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (exports.isLoading() && !exports.hasValue()) {
        <app-loading-state label="A carregar exportações…" />
      } @else if (exports.error()) {
        <div class="p-5">
          <app-alert tone="danger">{{ describe(exports.error()) }}</app-alert>
        </div>
      } @else if (list().length === 0) {
        <app-empty-state icon="chart" title="Sem exportações" />
      } @else {
        <app-table caption="Exportações" [columns]="columns" [rows]="list()">
          <ng-template let-row let-column="column">
            @switch (column.key) {
              @case ('report') {
                {{ reportName(row.reportId) }}
                <span class="block text-xs text-fg-muted">{{
                  row.createdAt.slice(0, 16).replace('T', ' ')
                }}</span>
              }
              @case ('status') {
                <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                @if (row.errorCode) {
                  <span class="block text-xs text-fg-muted">{{
                    text(row.errorCode, row.errorMessage ?? '')
                  }}</span>
                }
              }
              @case ('rows') {
                {{ row.rowCount ?? '—' }}
              }
              @case ('actions') {
                @if (row.status === 'READY') {
                  <app-button size="sm" variant="secondary" (click)="download(row)"
                    >Descarregar</app-button
                  >
                }
              }
            }
          </ng-template>
        </app-table>
      }
    </app-card>
  `,
})
export class ExportsTab {
  private readonly api = inject(ReportingApi);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly columns: readonly TableColumn[] = [
    { key: 'report', label: 'Relatório' },
    { key: 'status', label: 'Estado' },
    { key: 'rows', label: 'Linhas', align: 'end' },
    { key: 'actions', label: '', align: 'end' },
  ];
  private readonly tick = signal(0);
  protected readonly actionError = signal<string | null>(null);

  protected readonly exports = rxResource({
    params: () => {
      const t = this.tenantId();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.exports(),
  });
  private readonly reports = rxResource({
    params: () => {
      const t = this.tenantId();
      return t ? { tenantId: t.id } : undefined;
    },
    stream: () => this.api.reports(),
  });

  protected readonly list = computed<readonly ExportDto[]>(() =>
    this.exports.hasValue() ? this.exports.value() : [],
  );

  constructor() {
    // Enquanto houver exportações por terminar, volta a perguntar ao servidor.
    effect((onCleanup) => {
      if (!this.list().some((e) => e.status === 'QUEUED' || e.status === 'RUNNING')) return;
      const handle = setTimeout(() => this.tick.update((t) => t + 1), POLL_MS);
      onCleanup(() => clearTimeout(handle));
    });
  }

  protected describe = (e: unknown) => reportingError(e, 'Pedido falhado.');
  protected text = errorTextOf;
  protected status = (e: ExportDto) => EXPORT_STATUS[e.status];
  protected reportName = (id: string) =>
    (this.reports.hasValue() ? this.reports.value() : []).find((r) => r.id === id)?.name ?? id;

  protected download(row: ExportDto): void {
    this.actionError.set(null);
    this.api.downloadExport(row.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.reportName(row.reportId)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      },
      error: (e: unknown) => this.actionError.set(this.describe(e)),
    });
  }
}
