import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import { lineValue, PROPOSAL_STATUS, type Proposal, proposalTone } from './compensation-model';

/**
 * Proposta de compensação: submeter (valida contra o estado actual), aprovar ou recusar por outra pessoa (ou no
 * workflow configurado), cancelar. Ao aprovar aplica-se de imediato, com vigência a partir da data de efeito.
 */
@Component({
  selector: 'app-compensation-proposal',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    FieldList,
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
    } @else if (!p()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let x = p()!;
      <app-page-detail
        [title]="'Compensação — ' + x.employee.fullName"
        [subtitle]="'Efeito ' + date(x.effectiveDate) + ' · ' + x.reason"
      >
        <ng-container actions>
          <a class="btn-secondary" [routerLink]="['/rh/colaboradores', x.employee.id]"
            >Ver colaborador</a
          >
          @if (x.access?.manage && x.status === 'DRAFT') {
            <button type="button" class="btn-primary" data-testid="cp-submit" (click)="submit()">
              Pedir aprovação
            </button>
          }
          @if (x.access?.approve) {
            <button
              type="button"
              class="btn-primary"
              data-testid="cp-approve"
              (click)="decide(true)"
            >
              Aprovar e aplicar
            </button>
            <button
              type="button"
              class="btn-secondary"
              data-testid="cp-reject"
              (click)="rejecting.set(true)"
            >
              Recusar
            </button>
          }
          @if (x.status === 'PENDING_APPROVAL' && x.approvalRequestId) {
            <a class="btn-secondary" [routerLink]="['/aprovacoes/pedidos', x.approvalRequestId]"
              >Ver pedido de aprovação</a
            >
          }
          @if (
            x.access?.manage &&
            (x.status === 'DRAFT' || (x.status === 'PENDING_APPROVAL' && !x.approvalRequestId))
          ) {
            <button type="button" class="btn-secondary" data-testid="cp-cancel" (click)="cancel()">
              Cancelar
            </button>
          }
        </ng-container>
        <section class="card" aria-labelledby="cp-lines-title">
          <h2 id="cp-lines-title" class="mb-3 flex items-center gap-2 font-semibold">
            Componentes
            <span class="badge" [class]="tone(x.status)" data-testid="cp-status">{{
              status(x.status)
            }}</span>
          </h2>
          <ul class="divide-y divide-border text-sm">
            @for (l of x.lines; track l.componentId) {
              <li class="flex justify-between gap-2 py-2">
                <span>{{ l.name }}</span>
                <span class="tabular-nums">{{ value(l) }}</span>
              </li>
            }
          </ul>
          @if (x.status === 'PENDING_APPROVAL' && !x.approvalRequestId && !x.access?.approve) {
            <p class="mt-3 text-sm text-muted">
              Aguarda a aprovação de outra pessoa com permissão neste âmbito.
            </p>
          }
        </section>
        <div aside>
          <section class="card" aria-labelledby="cp-summary">
            <h2 id="cp-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                { label: 'Colaborador', value: x.employee.code + ' — ' + x.employee.fullName },
                { label: 'Data de efeito', value: date(x.effectiveDate) },
                { label: 'Preparada por', value: x.createdBy },
                {
                  label: 'Aprovação',
                  value: x.approvalMode === 'WORKFLOW' ? 'Workflow configurado' : 'Decisão directa',
                },
                {
                  label: 'Decidida por',
                  value: x.decidedBy ? x.decidedBy + ' · ' + dateTime(x.decidedAt) : null,
                },
                { label: 'Comentário', value: x.decisionComment },
              ]"
            />
          </section>
          <app-audit-history
            entityType="compensation_proposal"
            [entityId]="x.id"
            [refreshKey]="x.version"
          />
        </div>
      </app-page-detail>
    }

    <app-modal title="Recusar proposta" [open]="rejecting()" (closed)="rejecting.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <app-field label="Motivo" [required]="true" [error]="action.field('comment')">
        <textarea
          appControl
          class="input min-h-20"
          data-testid="cp-reject-reason"
          [(ngModel)]="comment"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="rejecting.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="cp-reject-confirm"
          [disabled]="action.busy()"
          (click)="reject()"
        >
          Recusar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class CompensationProposal {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly p = signal<Proposal | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly rejecting = signal(false);
  protected comment = '';
  protected readonly date = formatDate;
  protected readonly dateTime = formatDateTime;
  protected readonly tone = proposalTone;
  protected readonly status = (s: keyof typeof PROPOSAL_STATUS) => PROPOSAL_STATUS[s];
  protected readonly value = (l: Proposal['lines'][number]) => lineValue(l, (v) => formatMoney(v));

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
      const x = await this.api.get<Proposal>(`hr/compensation/proposals/${id}`);
      this.p.set(x);
      this.breadcrumbs.setCurrent(`Compensação — ${x.employee.fullName}`);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async post(path: string, body: Record<string, unknown>, message: string) {
    const x = this.p()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/compensation/proposals/${x.id}/${path}`, {
        ...body,
        expectedVersion: x.version,
      }),
    );
    if (!done) {
      const e = this.action.error();
      this.toasts.show(e?.details?.[0]?.message ?? e?.message ?? 'Erro.', 'error');
      return false;
    }
    await this.load(x.id);
    this.toasts.show(message);
    return true;
  }

  protected submit() {
    return this.post('submit', {}, 'Proposta enviada para aprovação.');
  }

  protected decide(approve: boolean) {
    return this.post(
      'decision',
      { decision: approve ? 'APPROVE' : 'REJECT' },
      approve ? 'Proposta aprovada e aplicada.' : 'Proposta recusada.',
    );
  }

  protected async reject() {
    const x = this.p()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/compensation/proposals/${x.id}/decision`, {
        decision: 'REJECT',
        comment: this.comment.trim() || undefined,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.rejecting.set(false);
    await this.load(x.id);
    this.toasts.show('Proposta recusada.');
  }

  protected async cancel() {
    const ok = await this.confirm.ask({
      title: 'Cancelar proposta',
      message: 'Cancelar esta proposta de compensação?',
      confirmLabel: 'Cancelar proposta',
      danger: true,
    });
    if (ok) await this.post('cancel', {}, 'Proposta cancelada.');
  }
}
