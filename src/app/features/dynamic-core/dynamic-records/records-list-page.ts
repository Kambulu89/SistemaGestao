import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { EntityRecordsGateway } from '../../../core/dynamic/data-access/entity-records.gateway';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { recordLabel } from '../../../core/dynamic/engine/record-label';
import type { EntityDefinition } from '../../../core/dynamic/models/entity-definition.model';
import type { EntityRecord, RecordQuery } from '../../../core/dynamic/models/entity-record.model';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { DynamicListRenderer } from '../../../shared/dynamic/dynamic-list-renderer';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button, buttonClasses } from '../../../shared/ui/button/button';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Icon } from '../../../shared/ui/icon/icon';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

/** Consulta inicial de uma entidade: a página e a ordenação por omissão da sua definição. */
export function defaultQuery(entity: EntityDefinition | undefined): RecordQuery {
  const sort = entity?.list.defaultSort;
  return {
    page: 1,
    pageSize: entity?.list.pageSize ?? 10,
    sort: sort ? { key: sort.field, direction: sort.direction } : undefined,
  };
}

/** Listagem de registos de qualquer entidade. Só orquestra: tudo o resto vem dos metadados. */
@Component({
  selector: 'app-records-list-page',
  imports: [PageHeader, DynamicListRenderer, Alert, Button, Dialog, EmptyState, Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      <app-page-header [title]="entity.names.plural" [description]="entity.description">
        @if (canCreate()) {
          <a pageActions routerLink="new" [class]="linkClass">
            <app-icon name="plus" class="size-4" /> Novo
          </a>
        }
      </app-page-header>

      @if (notice(); as message) {
        <app-alert class="mb-4" tone="success">{{ message }}</app-alert>
      }
      @if (actionError(); as message) {
        <app-alert class="mb-4" tone="danger">{{ message }}</app-alert>
      }

      <app-dynamic-list
        [entity]="entity"
        [result]="records.value() ?? null"
        [loading]="records.isLoading()"
        [error]="loadError()"
        [query]="query()"
        [canView]="canView"
        [canEdit]="canEdit"
        [canDelete]="canDelete"
        (queryChange)="query.set($event)"
        (view)="open($event, false)"
        (edit)="open($event, true)"
        (remove)="toDelete.set($event)"
      >
        @if (canCreate()) {
          <a emptyAction routerLink="new" [class]="linkClass"
            >Criar {{ entity.names.singular.toLowerCase() }}</a
          >
        }
      </app-dynamic-list>

      <app-dialog
        [open]="toDelete() !== null"
        [title]="'Eliminar ' + entity.names.singular.toLowerCase() + '?'"
        (closed)="toDelete.set(null)"
      >
        @if (toDelete(); as record) {
          <p>
            Vai eliminar <strong>{{ label(record) }}</strong
            >. Esta acção não pode ser anulada.
          </p>
        }
        <ng-container dialogActions>
          <app-button variant="secondary" (click)="toDelete.set(null)">Cancelar</app-button>
          <app-button variant="danger" [loading]="deleting()" (click)="confirmDelete()"
            >Eliminar</app-button
          >
        </ng-container>
      </app-dialog>
    } @else {
      <app-empty-state
        icon="cube"
        title="Entidade não encontrada"
        description="Esta entidade não existe neste tenant."
      />
    }
  `,
})
export class RecordsListPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly access = inject(EntityAccessService);
  private readonly gateway = inject(EntityRecordsGateway);
  private readonly router = inject(Router);
  private readonly tenant = inject(TenantContextService).tenant;

  /** Parâmetro de rota `:entityKey` (binding de inputs do router). */
  readonly entityKey = input.required<string>();

  protected readonly linkClass = buttonClasses('primary', 'md');

  protected readonly entity = computed(() => this.registry.find(this.entityKey()));

  /** Reinicia a consulta quando se muda de entidade. */
  protected readonly query = linkedSignal<RecordQuery>(() => defaultQuery(this.entity()));

  protected readonly records = rxResource({
    params: () => {
      const entity = this.entity();
      return entity ? { key: entity.key, query: this.query() } : undefined;
    },
    stream: ({ params }) => this.gateway.list(params.key, params.query),
  });

  protected readonly loadError = computed(() =>
    this.records.error() ? errorMessage(this.records.error()) : null,
  );

  protected readonly toDelete = signal<EntityRecord | null>(null);
  protected readonly deleting = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly canCreate = computed(() => {
    const entity = this.entity();
    return !!entity && this.access.can(entity, 'create');
  });

  // As acções por registo usam RBAC + ABAC (políticas sobre o registo).
  protected readonly canView = (r: EntityRecord) => this.can('read', r);
  protected readonly canEdit = (r: EntityRecord) => this.can('update', r);
  protected readonly canDelete = (r: EntityRecord) => this.can('delete', r);

  private can(operation: 'read' | 'update' | 'delete', record: EntityRecord): boolean {
    const entity = this.entity();
    return !!entity && this.access.can(entity, operation, record);
  }

  protected label(record: EntityRecord): string {
    const entity = this.entity();
    return entity ? recordLabel(entity, record) : record.id;
  }

  protected open(record: EntityRecord, edit: boolean): void {
    const slug = this.tenant()?.slug;
    if (!slug) return;
    void this.router.navigate([
      '/t',
      slug,
      'data',
      record.entityKey,
      record.id,
      ...(edit ? ['edit'] : []),
    ]);
  }

  protected confirmDelete(): void {
    const record = this.toDelete();
    if (!record) return;
    this.deleting.set(true);
    this.actionError.set(null);
    this.gateway.delete(record.entityKey, record.id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.toDelete.set(null);
        this.notice.set(`${this.label(record)} eliminado.`);
        this.records.reload();
      },
      error: (e: ApiError) => {
        this.deleting.set(false);
        this.toDelete.set(null);
        this.actionError.set(e.message);
      },
    });
  }
}
