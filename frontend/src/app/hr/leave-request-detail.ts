import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { formatDate, formatDateTime } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import { daysLabel, LEAVE_STATUS, type LeaveRequest, leaveTone } from './leave-model';

/**
 * Pedido de ausência: decisão da chefia ou de quem aprova (recusar exige motivo), cancelamento (aprovado só por quem
 * gere, devolvendo os dias) e justificativo. Nos tipos confidenciais, quem decide não vê o tipo, o motivo nem o anexo.
 */
@Component({
  selector: 'app-leave-request-detail',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    FieldList,
    Attachments,
    AuditHistory,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Skeleton,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!r()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let x = r()!;
      <app-page-detail
        [title]="x.employee.fullName"
        [subtitle]="x.leaveType.name + ' · ' + date(x.startDate) + ' – ' + date(x.endDate)"
      >
        <ng-container actions>
          <a class="btn-secondary" routerLink="/rh/ausencias">Voltar</a>
          @if (x.access?.approve) {
            <button
              type="button"
              class="btn-primary"
              data-testid="lv-approve"
              (click)="decide(true)"
            >
              Aprovar
            </button>
            <button
              type="button"
              class="btn-secondary"
              data-testid="lv-reject"
              (click)="openReason('reject')"
            >
              Recusar
            </button>
          }
          @if (x.access?.cancel) {
            <button
              type="button"
              class="btn-secondary"
              data-testid="lv-cancel"
              (click)="openReason('cancel')"
            >
              Cancelar pedido
            </button>
          }
        </ng-container>
        <section class="card" aria-labelledby="lv-summary">
          <h2 id="lv-summary" class="mb-3 flex items-center gap-2 font-semibold">
            Pedido
            <span class="badge" [class]="tone(x.status)" data-testid="lv-status">{{
              status(x.status)
            }}</span>
          </h2>
          <app-field-list
            [fields]="[
              { label: 'Colaborador', value: x.employee.code + ' — ' + x.employee.fullName },
              { label: 'Tipo', value: x.leaveType.name },
              { label: 'Período', value: date(x.startDate) + ' – ' + date(x.endDate) },
              {
                label: 'Dias',
                value:
                  days(x.days) + (x.deductsBalance ? ' (desconta férias de ' + x.year + ')' : ''),
              },
              { label: 'Remunerada', value: x.paid ? 'Sim' : 'Não' },
              { label: 'Motivo', value: x.reason },
              {
                label: 'Decidido por',
                value: x.decidedBy ? x.decidedBy + ' · ' + dateTime(x.decidedAt) : null,
              },
              { label: 'Comentário da decisão', value: x.decisionComment },
              { label: 'Motivo do cancelamento', value: x.cancelReason },
            ]"
          />
          @if (x.leaveType.confidential && !x.leaveType.code) {
            <p class="mt-3 text-sm text-muted">
              Tipo e motivo reservados (dados de saúde): decide pelas datas.
            </p>
          }
        </section>
        <div aside>
          @if (x.access?.documents) {
            <app-attachments
              subjectType="leave_request"
              [subjectId]="x.id"
              [canWrite]="workspace.has('attachments.storage_mb')"
            />
          }
          <app-audit-history
            entityType="leave_request"
            [entityId]="x.id"
            [refreshKey]="x.version"
          />
        </div>
      </app-page-detail>
    }

    <app-modal
      [title]="reasonFor() === 'reject' ? 'Recusar pedido' : 'Cancelar pedido'"
      [open]="reasonFor() !== null"
      (closed)="reasonFor.set(null)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <app-field
        label="Motivo"
        [required]="reasonRequired()"
        [error]="action.field('comment') ?? action.field('reason')"
      >
        <textarea
          appControl
          class="input min-h-20"
          data-testid="lv-reason"
          [(ngModel)]="reason"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="reasonFor.set(null)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="lv-reason-confirm"
          [disabled]="action.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LeaveRequestDetail {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly workspace = inject(Workspace);
  protected readonly r = signal<LeaveRequest | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly reasonFor = signal<'reject' | 'cancel' | null>(null);
  protected reason = '';
  protected readonly days = daysLabel;
  protected readonly date = formatDate;
  protected readonly dateTime = formatDateTime;
  protected readonly tone = leaveTone;
  protected readonly status = (s: keyof typeof LEAVE_STATUS) => LEAVE_STATUS[s];
  protected readonly reasonRequired = computed(
    () => this.reasonFor() === 'reject' || this.r()?.status === 'APPROVED',
  );

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loadError.set(null);
    try {
      const x = await this.api.get<LeaveRequest>(`hr/leave/requests/${id}`);
      this.r.set(x);
      this.breadcrumbs.setCurrent(x.employee.fullName);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected async decide(approve: boolean, comment?: string) {
    const x = this.r()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/leave/requests/${x.id}/decision`, {
        decision: approve ? 'APPROVE' : 'REJECT',
        comment: comment || undefined,
        expectedVersion: x.version,
      }),
    );
    if (!done) {
      if (approve) this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
      return false;
    }
    await this.load(x.id);
    this.toasts.show(approve ? 'Ausência aprovada.' : 'Pedido recusado.');
    return true;
  }

  protected openReason(kind: 'reject' | 'cancel') {
    this.reason = '';
    this.action.error.set(null);
    this.reasonFor.set(kind);
  }

  protected async confirmReason() {
    const x = this.r()!;
    if (this.reasonFor() === 'reject') {
      if (await this.decide(false, this.reason.trim())) this.reasonFor.set(null);
      return;
    }
    const done = await this.action.run(() =>
      this.api.post(`hr/leave/requests/${x.id}/cancel`, {
        reason: this.reason.trim() || undefined,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.reasonFor.set(null);
    await this.load(x.id);
    this.toasts.show('Pedido cancelado.');
  }
}
