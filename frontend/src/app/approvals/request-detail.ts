import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { personName, type RequestDetail } from './types';

/** Pedido: etapas, decisões, decidir (por si ou por delegação), cancelar e anexos. */
@Component({
  selector: 'app-request-detail',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, StatusBadge, Attachments],
  template: `
    <app-error-alert [error]="request.error()" />
    @if (request.value(); as r) {
      <app-page-header
        [title]="r.title"
        [subtitle]="
          r.workflow.name + ' · pedido por ' + person(r.requestedBy) + ' em ' + when(r.createdAt)
        "
      >
        <a routerLink="/aprovacoes" class="btn-secondary">Voltar</a>
      </app-page-header>
      <div class="grid gap-4 lg:grid-cols-3">
        <div class="space-y-4 lg:col-span-2">
          <section class="card">
            <p class="text-sm">Estado: <app-status-badge [status]="r.status" /></p>
            @if (r.description) {
              <p class="mt-2 text-sm whitespace-pre-line text-slate-700">{{ r.description }}</p>
            }
          </section>

          @if (r.myOptions.length > 0) {
            <form
              class="card space-y-3 border-indigo-200"
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

          <section class="card">
            <h2 class="font-semibold">Etapas</h2>
            <ol class="mt-2 space-y-3">
              @for (s of r.steps; track s.sequence) {
                <li class="text-sm">
                  <span class="font-medium">{{ s.sequence }}. {{ s.name }}</span>
                  @if (r.status === 'PENDING' && r.currentStep === s.sequence) {
                    <span class="badge ml-1 bg-amber-100 text-amber-800">Em curso</span>
                  }
                  <span class="text-xs text-slate-500">
                    · {{ s.requiredApprovals }} aprovação(ões)</span
                  >
                  <ul class="mt-1 pl-4 text-xs text-slate-700">
                    @for (d of decisionsFor(s.sequence); track $index) {
                      <li>
                        {{ d.decision === 'APPROVE' ? 'Aprovado' : 'Rejeitado' }} por
                        {{ person(d.decidedBy) }}
                        @if (d.onBehalfOf) {
                          (em nome de {{ person(d.onBehalfOf) }})
                        }
                        · {{ when(d.decidedAt) }}{{ d.comment ? ' — ' + d.comment : '' }}
                      </li>
                    }
                  </ul>
                </li>
              }
            </ol>
          </section>
        </div>
        <div class="space-y-4">
          @if (canCancel()) {
            <section class="card space-y-2">
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
            subjectType="approval_request"
            [subjectId]="r.id"
            [canWrite]="canAttach()"
          />
        </div>
      </div>
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

  protected decisionsFor(step: number) {
    return (this.request.value()?.decisions ?? []).filter((d) => d.stepSequence === step);
  }

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
    }
  }

  protected async cancel() {
    if (!confirm('Cancelar este pedido?')) return;
    const updated = await this.action.run(() =>
      this.api.post<RequestDetail>(`approvals/requests/${this.id()}/cancel`, {
        reason: this.reason().trim() || null,
      }),
    );
    if (updated) this.request.value.set(updated);
  }
}
