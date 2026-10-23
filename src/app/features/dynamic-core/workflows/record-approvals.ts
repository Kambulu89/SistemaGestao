import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, of } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { END_REASON, INSTANCE_STATUS, TASK_STATUS } from './approvals-model';
import { ApprovalsApi, type InstanceDto } from './workflows.api';

/**
 * Aprovação de um registo (C14): os processos do registo, a etapa em curso e a submissão a um workflow publicado.
 * Alterar o registo depois de submetido cancela o processo (o servidor garante-o); aqui apenas se mostra.
 */
@Component({
  selector: 'app-record-approvals',
  imports: [DatePipe, FormsModule, Alert, Badge, Button, Card, Dialog, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (visible()) {
      <app-card class="mb-6" title="Aprovação" data-testid="approvals-panel">
        @if (notice(); as message) {
          <app-alert class="mb-3" tone="success">{{ message }}</app-alert>
        }
        @if (error(); as message) {
          <app-alert class="mb-3" tone="danger">{{ message }}</app-alert>
        }

        @if (latest(); as current) {
          <div class="flex flex-wrap items-center gap-2" data-testid="approval-current">
            <app-badge [tone]="status(current).tone">{{ status(current).label }}</app-badge>
            <span class="text-sm">
              {{ current.workflowName }} (revisão {{ current.workflowRevision }}), submetido na
              versão {{ current.resourceVersion }} em
              {{ current.startedAt | date: 'dd/MM/yyyy HH:mm' }}
            </span>
          </div>
          @if (reasonOf(current); as text) {
            <p class="mt-1 text-sm text-fg-muted">{{ text }}</p>
          }
          @if (detail.value(); as d) {
            <ol class="mt-3 space-y-1 text-sm" aria-label="Tarefas do processo">
              @for (task of d.tasks; track task.id) {
                <li class="flex flex-wrap items-center gap-2">
                  <span class="text-fg-muted">{{ task.stageCode }}</span>
                  <app-badge [tone]="taskStatus(task.status).tone">{{
                    taskStatus(task.status).label
                  }}</app-badge>
                  @if (task.decisionReason) {
                    <span class="text-fg-muted">— {{ task.decisionReason }}</span>
                  }
                </li>
              }
            </ol>
          }
          @if (isActive(current) && canSubmit()) {
            <div class="mt-3">
              <app-button
                size="sm"
                variant="secondary"
                [loading]="working()"
                (click)="cancel(current)"
                >Cancelar processo</app-button
              >
            </div>
          }
        } @else {
          <p class="text-sm text-fg-muted">Este registo ainda não foi submetido a aprovação.</p>
        }

        @if (canSubmit() && !hasActive()) {
          <div class="mt-3">
            <app-button size="sm" (click)="openSubmit()" data-testid="submit-approval"
              >Submeter para aprovação</app-button
            >
          </div>
        }
      </app-card>

      <app-dialog
        [open]="submitting()"
        title="Submeter para aprovação"
        (closed)="submitting.set(false)"
      >
        @if (options().length === 0) {
          <p>Não há workflows publicados para esta entidade.</p>
        } @else {
          <div class="text-fg">
            <app-select
              label="Workflow"
              [options]="options()"
              [ngModel]="chosen()"
              (ngModelChange)="chosen.set($event ?? '')"
            />
            @if (stagesOf(chosen()); as stages) {
              <p class="mt-2 text-sm text-fg-muted">Etapas: {{ stages }}</p>
            }
          </div>
          <p class="mt-3">
            O registo fica congelado nesta versão. Se for alterado antes da decisão, o processo é
            cancelado e a aprovação recomeça.
          </p>
        }
        <ng-container dialogActions>
          <app-button variant="secondary" (click)="submitting.set(false)">Cancelar</app-button>
          <app-button [loading]="working()" [disabled]="chosen() === ''" (click)="submit()"
            >Submeter</app-button
          >
        </ng-container>
      </app-dialog>
    }
  `,
})
export class RecordApprovals {
  private readonly approvals = inject(ApprovalsApi);
  private readonly permissions = inject(PermissionService);

  readonly entityCode = input.required<string>();
  readonly recordId = input.required<string>();
  /** Muda quando o registo é alterado (ex.: `updatedAt`): recarrega os processos. */
  readonly refreshKey = input<string>();

  private readonly reload = signal(0);
  protected readonly working = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly chosen = signal('');

  protected readonly canSubmit = computed(() => this.permissions.can('workflow.submit'));

  protected readonly instances = rxResource({
    params: () => ({
      entity: this.entityCode(),
      id: this.recordId(),
      key: this.refreshKey(),
      reload: this.reload(),
    }),
    // Sem acesso (ou sem módulo no servidor) o painel simplesmente não aparece.
    stream: ({ params }) =>
      this.approvals
        .instancesOf(params.entity, params.id)
        .pipe(catchError(() => of([] as readonly InstanceDto[]))),
  });

  protected readonly visible = computed(
    () => this.canSubmit() || (this.instances.hasValue() && this.instances.value().length > 0),
  );
  protected readonly latest = computed(() => this.instances.value()?.[0] ?? null);
  protected readonly hasActive = computed(() => (this.instances.value() ?? []).some(isActive));

  protected readonly detail = rxResource({
    params: () => {
      const current = this.latest();
      return current
        ? { id: current.id, status: current.status, reload: this.reload() }
        : undefined;
    },
    stream: ({ params }) => this.approvals.instance(params.id).pipe(catchError(() => of(null))),
  });

  private readonly submittable = rxResource({
    params: () => (this.submitting() ? this.entityCode() : undefined),
    stream: ({ params }) => this.approvals.submittable(params),
  });
  protected readonly options = computed<readonly SelectOption[]>(() =>
    (this.submittable.value() ?? []).map((w) => ({ value: w.code, label: w.name })),
  );

  protected status(instance: InstanceDto) {
    return INSTANCE_STATUS[instance.status];
  }

  protected taskStatus(status: keyof typeof TASK_STATUS) {
    return TASK_STATUS[status];
  }

  protected isActive(instance: InstanceDto): boolean {
    return instance.status === 'WAITING' || instance.status === 'RUNNING';
  }

  protected reasonOf(instance: InstanceDto): string | null {
    return instance.endReason ? (END_REASON[instance.endReason] ?? null) : null;
  }

  protected stagesOf(code: string): string | null {
    const found = this.submittable.value()?.find((w) => w.code === code);
    return found ? found.stages.map((s) => s.label).join(' → ') : null;
  }

  protected openSubmit(): void {
    this.notice.set(null);
    this.error.set(null);
    this.chosen.set('');
    this.submitting.set(true);
  }

  protected submit(): void {
    this.working.set(true);
    this.approvals
      .submit(this.entityCode(), this.chosen(), this.recordId())
      .pipe(finalize(() => this.working.set(false)))
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.notice.set('Submetido para aprovação.');
          this.reload.update((n) => n + 1);
        },
        error: (error: ApiError) => {
          this.submitting.set(false);
          this.error.set(errorMessage(error));
        },
      });
  }

  protected cancel(instance: InstanceDto): void {
    this.notice.set(null);
    this.error.set(null);
    this.working.set(true);
    this.approvals
      .cancel(instance.id)
      .pipe(finalize(() => this.working.set(false)))
      .subscribe({
        next: () => {
          this.notice.set('Processo cancelado.');
          this.reload.update((n) => n + 1);
        },
        error: (error: ApiError) => this.error.set(errorMessage(error)),
      });
  }
}

function isActive(instance: InstanceDto): boolean {
  return instance.status === 'WAITING' || instance.status === 'RUNNING';
}
