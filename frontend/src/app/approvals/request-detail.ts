import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { type StepItem } from '../ui/stepper';
import { ApprovalWorkflowPage } from '../ui/templates';
import { ConfirmService } from '../ui/confirm';
import { ToastService } from '../ui/toasts';
import { Breadcrumbs } from '../core/breadcrumbs';
import { personName, type RequestDetail, requestTimeline } from './types';

/** Pedido (ApprovalWorkflowPage): etapas, linha temporal, decidir (por si ou por delegação), cancelar e anexos. */
@Component({
  selector: 'app-request-detail',
  imports: [FormsModule, RouterLink, ErrorAlert, Attachments, ApprovalWorkflowPage],
  template: `
    <app-error-alert [error]="request.error()" />
    @if (request.value(); as r) {
      <app-approval-workflow-page
        [title]="r.title"
        [status]="r.status"
        [subtitle]="
          r.workflow.name + ' · pedido por ' + person(r.requestedBy) + ' em ' + when(r.createdAt)
        "
        [steps]="stepItems()"
        [timeline]="timeline()"
      >
        <a actions routerLink="/aprovacoes" class="btn-secondary">Voltar</a>
        <section summary class="card">
          <p class="text-sm">
            {{
              r.status === 'PENDING'
                ? 'Em curso na etapa ' + r.currentStep + ' de ' + r.steps.length + '.'
                : 'Concluído' + (r.completedAt ? ' em ' + when(r.completedAt) : '') + '.'
            }}
          </p>
          @if (r.description) {
            <p class="mt-2 text-sm whitespace-pre-line text-fg">{{ r.description }}</p>
          }
        </section>

        @if (r.myOptions.length > 0) {
          <form
            decision
            class="card space-y-3 border-primary"
            (ngSubmit)="decide()"
            aria-label="Decidir"
          >
            <h2 class="font-semibold">A sua decisão — etapa {{ r.currentStep }}</h2>
            <app-error-alert [error]="action.error()" />
            @if (r.myOptions.length > 1 || r.myOptions[0].onBehalfOf) {
              <div>
                <label class="label" for="behalf">Decidir</label>
                <select id="behalf" name="behalf" class="input" [(ngModel)]="onBehalfOf">
                  @for (o of r.myOptions; track o.onBehalfOf) {
                    <option [ngValue]="o.onBehalfOf">
                      {{ o.onBehalfOf ? 'Em nome de quem me delegou' : 'Por mim' }}
                    </option>
                  }
                </select>
              </div>
            }
            <div>
              <label class="label" for="comment">Comentário (obrigatório para rejeitar)</label>
              <textarea
                id="comment"
                name="comment"
                rows="3"
                class="input"
                [(ngModel)]="comment"
              ></textarea>
            </div>
            <div class="flex gap-2">
              <button
                type="submit"
                class="btn-primary"
                [disabled]="action.busy()"
                (click)="decision.set('APPROVE')"
              >
                Aprovar
              </button>
              <button
                type="submit"
                class="btn-danger"
                [disabled]="action.busy() || !comment().trim()"
                (click)="decision.set('REJECT')"
              >
                Rejeitar
              </button>
            </div>
          </form>
        }

        @if (canCancel()) {
          <section aside class="card space-y-2">
            <h2 class="font-semibold">Cancelar pedido</h2>
            <label class="label" for="reason">Motivo</label>
            <input id="reason" class="input" [(ngModel)]="reason" name="reason" />
            <button
              type="button"
              class="btn-secondary"
              [disabled]="action.busy()"
              (click)="cancel()"
            >
              Cancelar pedido
            </button>
          </section>
        }
        <app-attachments
          aside
          subjectType="approval_request"
          [subjectId]="r.id"
          [canWrite]="canAttach()"
        />
      </app-approval-workflow-page>
    }
  `,
})
export class RequestDetailPage {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly when = formatDateTime;
  protected readonly person = personName;
  protected readonly comment = signal('');
  protected readonly reason = signal('');
  protected readonly decision = signal<'APPROVE' | 'REJECT'>('APPROVE');
  protected readonly onBehalfOf = signal<string | null>(null);
  protected readonly action = new Action();
  protected readonly request = new Loadable(async () => {
    const r = await this.api.get<RequestDetail>(`approvals/requests/${this.id()}`);
    this.breadcrumbs.setCurrent(r.title);
    this.onBehalfOf.set(r.myOptions[0]?.onBehalfOf ?? null);
    return r;
  });
  private readonly mine = computed(
    () => this.request.value()?.requestedBy.membershipId === this.workspace.context()?.membershipId,
  );
  protected readonly canCancel = computed(
    () =>
      this.request.value()?.status === 'PENDING' &&
      (this.mine() || this.workspace.can('approvals.manage')),
  );
  protected readonly canAttach = computed(
    () =>
      this.workspace.has('attachments.storage_mb') &&
      ((this.mine() && this.request.value()?.status === 'PENDING') ||
        this.workspace.can('approvals.manage')),
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.request.load());
    });
  }

  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);

  protected readonly stepItems = computed<StepItem[]>(() => {
    const r = this.request.value();
    if (!r) return [];
    return r.steps.map((s) => {
      const decisions = r.decisions.filter((d) => d.stepSequence === s.sequence);
      const rejected = decisions.some((d) => d.decision === 'REJECT');
      const approvals = decisions.filter((d) => d.decision === 'APPROVE').length;
      const state: StepItem['state'] = rejected
        ? 'failed'
        : r.status === 'PENDING' && r.currentStep === s.sequence
          ? 'current'
          : approvals >= s.requiredApprovals
            ? 'done'
            : 'pending';
      return {
        label: s.name,
        state,
        detail: `${approvals} de ${s.requiredApprovals} aprovação(ões)`,
      };
    });
  });

  protected readonly timeline = computed(() => {
    const r = this.request.value();
    return r ? requestTimeline(r) : [];
  });

  protected async decide() {
    const updated = await this.action.run(() =>
      this.api.post<RequestDetail>(`approvals/requests/${this.id()}/decisions`, {
        decision: this.decision(),
        comment: this.comment().trim() || null,
        onBehalfOf: this.onBehalfOf(),
      }),
    );
    if (updated) {
      this.comment.set('');
      this.request.value.set(updated);
      this.toasts.show(
        this.decision() === 'APPROVE' ? 'Aprovação registada.' : 'Rejeição registada.',
      );
    }
  }

  protected async cancel() {
    const ok = await this.confirm.ask({
      title: 'Cancelar pedido',
      message: 'O pedido deixa de poder ser decidido.',
      confirmLabel: 'Cancelar pedido',
      danger: true,
    });
    if (!ok) return;
    const updated = await this.action.run(() =>
      this.api.post<RequestDetail>(`approvals/requests/${this.id()}/cancel`, {
        reason: this.reason().trim() || null,
      }),
    );
    if (updated) {
      this.request.value.set(updated);
      this.toasts.show('Pedido cancelado.');
    }
  }
}
