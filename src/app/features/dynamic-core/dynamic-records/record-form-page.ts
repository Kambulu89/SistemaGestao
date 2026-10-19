import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { EntityRecordsGateway } from '../../../core/dynamic/data-access/entity-records.gateway';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { recordLabel } from '../../../core/dynamic/engine/record-label';
import type { EntityRecord, RecordData } from '../../../core/dynamic/models/entity-record.model';
import type {
  RecordValidationFailure,
  ValidationIssue,
} from '../../../core/dynamic/models/validation-issue.model';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { DynamicFormRenderer } from '../../../shared/dynamic/dynamic-form-renderer';
import { Alert } from '../../../shared/ui/alert/alert';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

/** Criar ou editar um registo de qualquer entidade (`id` presente = edição). */
@Component({
  selector: 'app-record-form-page',
  imports: [PageHeader, DynamicFormRenderer, Alert, EmptyState, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      <app-page-header [title]="title()" [description]="entity.description" />

      @if (record.isLoading() && !record.hasValue()) {
        <app-loading-state label="A carregar registo…" />
      } @else if (loadError(); as message) {
        <app-alert tone="danger" title="Não foi possível carregar o registo">{{
          message
        }}</app-alert>
      } @else {
        <app-dynamic-form
          [entity]="entity"
          [mode]="mode()"
          [value]="record.value()?.data ?? null"
          [status]="record.value()?.status ?? null"
          [issues]="issues()"
          [submitting]="submitting()"
          [access]="fieldAccess"
          (submitted)="save($event)"
          (cancelled)="back()"
        />
      }
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada" />
    }
  `,
})
export class RecordFormPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly gateway = inject(EntityRecordsGateway);
  private readonly router = inject(Router);
  private readonly tenant = inject(TenantContextService).tenant;
  protected readonly fieldAccess = inject(EntityAccessService).fieldAccess;

  readonly entityKey = input.required<string>();
  /** Presente nas rotas de edição. */
  readonly id = input<string>();

  protected readonly entity = computed(() => this.registry.find(this.entityKey()));
  protected readonly mode = computed(() => (this.id() ? 'edit' : 'create'));

  protected readonly record = rxResource({
    params: () => {
      const id = this.id();
      return id && this.entity() ? { key: this.entityKey(), id } : undefined;
    },
    stream: ({ params }) => this.gateway.get(params.key, params.id),
  });

  protected readonly loadError = computed(() =>
    this.record.error() ? errorMessage(this.record.error()) : null,
  );

  protected readonly issues = signal<readonly ValidationIssue[]>([]);
  protected readonly submitting = signal(false);

  protected readonly title = computed(() => {
    const entity = this.entity();
    if (!entity) return '';
    const record = this.record.value();
    return record
      ? `Editar ${recordLabel(entity, record)}`
      : `Criar ${entity.names.singular.toLowerCase()}`;
  });

  protected save(values: RecordData): void {
    const id = this.id();
    const current = this.record.value();
    this.submitting.set(true);
    this.issues.set([]);

    const request =
      id && current
        ? this.gateway.update(this.entityKey(), id, {
            data: values,
            expectedRowVersion: current.rowVersion,
          })
        : this.gateway.create(this.entityKey(), { data: values });

    request.subscribe({
      next: (saved) => {
        this.submitting.set(false);
        this.goTo(saved);
      },
      error: (error: ApiError) => {
        this.submitting.set(false);
        const failure =
          error.status === 422 ? (error.details as RecordValidationFailure | undefined) : undefined;
        this.issues.set(
          failure?.issues ?? [{ fieldKey: null, rule: 'server', message: error.message }],
        );
      },
    });
  }

  protected back(): void {
    const slug = this.tenant()?.slug;
    const id = this.id();
    if (slug)
      void this.router.navigate(['/t', slug, 'data', this.entityKey(), ...(id ? [id] : [])]);
  }

  private goTo(record: EntityRecord): void {
    const slug = this.tenant()?.slug;
    if (slug) void this.router.navigate(['/t', slug, 'data', record.entityKey, record.id]);
  }
}
