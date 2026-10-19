import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { EntityRecordsGateway } from '../../../core/dynamic/data-access/entity-records.gateway';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { AUDIT_ACTION_LABELS, describeChange } from '../../../core/dynamic/engine/audit-summary';
import { recordLabel } from '../../../core/dynamic/engine/record-label';
import {
  availableTransitions,
  statusOf,
  type TransitionAvailability,
} from '../../../core/dynamic/engine/workflow';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { DynamicFormRenderer } from '../../../shared/dynamic/dynamic-form-renderer';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button, buttonClasses } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

/** Detalhe de um registo: dados, estado, transições do workflow e histórico de auditoria. */
@Component({
  selector: 'app-record-detail-page',
  imports: [
    PageHeader,
    DynamicFormRenderer,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    LoadingState,
    RouterLink,
    DatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      @if (record.isLoading() && !record.hasValue()) {
        <app-loading-state label="A carregar registo…" />
      } @else if (loadError(); as message) {
        <app-alert tone="danger" title="Não foi possível carregar o registo">{{
          message
        }}</app-alert>
      } @else if (record.value(); as rec) {
        <app-page-header [title]="label()" [description]="entity.names.singular">
          <div pageActions class="flex flex-wrap items-center gap-2">
            @if (status(); as s) {
              <app-badge [tone]="s.color">{{ s.name }}</app-badge>
            }
            @if (canUpdate()) {
              <a routerLink="edit" [class]="secondaryLink">Editar</a>
            }
            @if (canDelete()) {
              <app-button variant="danger" (click)="confirming.set(true)">Eliminar</app-button>
            }
          </div>
        </app-page-header>

        @if (notice(); as message) {
          <app-alert class="mb-4" tone="success">{{ message }}</app-alert>
        }
        @if (actionError(); as message) {
          <app-alert class="mb-4" tone="danger">{{ message }}</app-alert>
        }

        @if (visibleTransitions().length > 0) {
          <app-card class="mb-6" title="Mudar de estado">
            <ul class="flex flex-wrap gap-4">
              @for (item of visibleTransitions(); track item.transition.key) {
                <li>
                  <app-button
                    variant="secondary"
                    [disabled]="item.blockedBy !== null || transitioning()"
                    (click)="run(item.transition.key, item.transition.name)"
                  >
                    {{ item.transition.name }}
                  </app-button>
                  @if (item.blockedBy === 'approval') {
                    <p class="mt-1 text-xs text-fg-muted">Requer aprovação</p>
                  } @else if (item.blockedBy === 'condition') {
                    <p class="mt-1 text-xs text-fg-muted">Condições não satisfeitas</p>
                  }
                </li>
              }
            </ul>
          </app-card>
        }

        <app-dynamic-form
          [entity]="entity"
          mode="read"
          [value]="rec.data"
          [status]="rec.status"
          [access]="fieldAccess"
        />

        @if (entity.audit.enabled) {
          <h2 class="mb-3 mt-8 text-lg font-semibold">Histórico</h2>
          <app-card>
            @if (audit.isLoading() && !audit.hasValue()) {
              <app-loading-state label="A carregar histórico…" />
            } @else {
              <ol class="space-y-4" aria-label="Histórico de alterações">
                @for (entry of audit.value() ?? []; track entry.id) {
                  <li class="text-sm">
                    <p>
                      <strong>{{ actionLabel(entry.action) }}</strong>
                      <span class="text-fg-muted">
                        · {{ entry.actorName }} · {{ entry.at | date: 'medium' }}</span
                      >
                    </p>
                    @if (entry.changes.length > 0) {
                      <ul class="mt-1 list-disc ps-5 text-fg-muted">
                        @for (change of entry.changes; track change.field) {
                          @if (describe(change); as c) {
                            <li>{{ c.label }}: {{ c.from }} → {{ c.to }}</li>
                          }
                        }
                      </ul>
                    }
                  </li>
                }
              </ol>
            }
          </app-card>
        }

        <app-dialog
          [open]="confirming()"
          [title]="'Eliminar ' + entity.names.singular.toLowerCase() + '?'"
          (closed)="confirming.set(false)"
        >
          <p>
            Vai eliminar <strong>{{ label() }}</strong
            >. Esta acção não pode ser anulada.
          </p>
          <ng-container dialogActions>
            <app-button variant="secondary" (click)="confirming.set(false)">Cancelar</app-button>
            <app-button variant="danger" [loading]="deleting()" (click)="remove()"
              >Eliminar</app-button
            >
          </ng-container>
        </app-dialog>
      }
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada" />
    }
  `,
})
export class RecordDetailPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly gateway = inject(EntityRecordsGateway);
  private readonly access = inject(EntityAccessService);
  private readonly permissions = inject(PermissionService);
  private readonly router = inject(Router);
  private readonly tenant = inject(TenantContextService).tenant;
  protected readonly fieldAccess = this.access.fieldAccess;
  protected readonly secondaryLink = buttonClasses('secondary', 'md');

  readonly entityKey = input.required<string>();
  readonly id = input.required<string>();

  protected readonly entity = computed(() => this.registry.find(this.entityKey()));

  protected readonly record = rxResource({
    params: () => (this.entity() ? { key: this.entityKey(), id: this.id() } : undefined),
    stream: ({ params }) => this.gateway.get(params.key, params.id),
  });

  protected readonly audit = rxResource({
    params: () =>
      this.entity()?.audit.enabled ? { key: this.entityKey(), id: this.id() } : undefined,
    stream: ({ params }) => this.gateway.audit(params.key, params.id),
  });

  protected readonly loadError = computed(() =>
    this.record.error() ? errorMessage(this.record.error()) : null,
  );

  protected readonly confirming = signal(false);
  protected readonly deleting = signal(false);
  protected readonly transitioning = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly label = computed(() => {
    const entity = this.entity();
    const record = this.record.value();
    return entity && record ? recordLabel(entity, record) : '';
  });

  protected readonly status = computed(() => {
    const entity = this.entity();
    return entity ? statusOf(entity, this.record.value()?.status ?? null) : undefined;
  });

  protected readonly canUpdate = computed(() => this.can('update'));
  protected readonly canDelete = computed(() => this.can('delete'));

  /**
   * Transições a mostrar: as executáveis e as bloqueadas por aprovação ou condições
   * (desactivadas, com o motivo). As que o utilizador nem pode ver por permissão ficam escondidas.
   */
  protected readonly visibleTransitions = computed<readonly TransitionAvailability[]>(() => {
    const entity = this.entity();
    const record = this.record.value();
    if (!entity || !record) return [];
    return availableTransitions(entity, record, { can: (p) => this.permissions.can(p) }).filter(
      (t) => t.blockedBy === null || t.blockedBy === 'approval' || t.blockedBy === 'condition',
    );
  });

  private can(operation: 'update' | 'delete'): boolean {
    const entity = this.entity();
    const record = this.record.value();
    return !!entity && !!record && this.access.can(entity, operation, record);
  }

  protected actionLabel(action: keyof typeof AUDIT_ACTION_LABELS): string {
    return AUDIT_ACTION_LABELS[action];
  }

  protected describe(change: Parameters<typeof describeChange>[1]) {
    const entity = this.entity();
    return entity ? describeChange(entity, change) : null;
  }

  protected run(transitionKey: string, name: string): void {
    this.transitioning.set(true);
    this.actionError.set(null);
    this.notice.set(null);
    this.gateway.transition(this.entityKey(), this.id(), transitionKey).subscribe({
      next: () => {
        this.transitioning.set(false);
        this.notice.set(`${name}: concluído.`);
        this.record.reload();
        this.audit.reload();
      },
      error: (e: ApiError) => {
        this.transitioning.set(false);
        this.actionError.set(e.message);
      },
    });
  }

  protected remove(): void {
    this.deleting.set(true);
    this.gateway.delete(this.entityKey(), this.id()).subscribe({
      next: () => {
        this.deleting.set(false);
        const slug = this.tenant()?.slug;
        if (slug) void this.router.navigate(['/t', slug, 'data', this.entityKey()]);
      },
      error: (e: ApiError) => {
        this.deleting.set(false);
        this.confirming.set(false);
        this.actionError.set(e.message);
      },
    });
  }
}
