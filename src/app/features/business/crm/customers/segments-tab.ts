import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { CustomersApi, type SegmentDto } from './customers.api';
import { customerError } from './customers-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Segmento' },
  { key: 'status', label: 'Estado' },
  { key: 'actions', label: '', align: 'end' },
];

/** Segmentos de clientes: nada se apaga, desactiva-se (um segmento inactivo deixa de poder ser atribuído). */
@Component({
  selector: 'app-customer-segments',
  imports: [FormsModule, Alert, Badge, Button, Card, EmptyState, Input, LoadingState, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }
    <app-card [flush]="true">
      @if (segments.isLoading() && !segments.hasValue()) {
        <app-loading-state label="A carregar segmentos…" />
      } @else if (segments.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os segmentos">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (segments.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="users" title="Sem segmentos" />
        } @else {
          <app-table caption="Segmentos" [columns]="columns" [rows]="list" data-testid="segments">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.code }}</span>
                }
                @case ('status') {
                  <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                    row.active ? 'Activo' : 'Inactivo'
                  }}</app-badge>
                }
                @case ('actions') {
                  @if (canManage()) {
                    <app-button
                      size="sm"
                      variant="secondary"
                      [disabled]="busy()"
                      (click)="toggle(row)"
                      >{{ row.active ? 'Desactivar' : 'Activar' }}</app-button
                    >
                  }
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (canManage()) {
      <app-card class="mt-4 block">
        <h3 class="mb-3 text-sm font-semibold">Novo segmento</h3>
        <div class="grid gap-4 sm:grid-cols-3">
          <app-input
            label="Código"
            [required]="true"
            [ngModel]="code()"
            (ngModelChange)="code.set($event ?? '')"
          />
          <app-input
            label="Nome"
            [required]="true"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <app-input
            label="Descrição"
            [ngModel]="description()"
            (ngModelChange)="description.set($event ?? '')"
          />
        </div>
        <app-button class="mt-4" [loading]="busy()" (click)="create()">Criar segmento</app-button>
      </app-card>
    }
  `,
})
export class SegmentsTab {
  private readonly api = inject(CustomersApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly canManage = computed(() => this.permissions.can('customer.update'));

  private readonly reload = signal(0);
  protected readonly segments = rxResource({
    params: () => ({ reload: this.reload() }),
    stream: () => this.api.segments(),
  });
  protected readonly loadError = computed(() =>
    customerError(this.segments.error(), 'Tente novamente.'),
  );

  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  private run<T>(call: Observable<T>, message: string, after?: () => void): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        after?.();
        this.notice.set(message);
        this.reload.update((n) => n + 1);
      },
      error: (error: unknown) =>
        this.actionError.set(customerError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected create(): void {
    if (!this.code().trim() || !this.name().trim()) {
      this.actionError.set('O código e o nome são obrigatórios.');
      return;
    }
    this.run(
      this.api.createSegment({
        code: this.code().trim(),
        name: this.name().trim(),
        description: this.description().trim() || null,
      }),
      'Segmento criado.',
      () => {
        this.code.set('');
        this.name.set('');
        this.description.set('');
      },
    );
  }

  protected toggle(row: SegmentDto): void {
    this.run(
      this.api.updateSegment(row.id, row.version, { active: !row.active }),
      row.active ? 'Segmento desactivado.' : 'Segmento activado.',
    );
  }
}
