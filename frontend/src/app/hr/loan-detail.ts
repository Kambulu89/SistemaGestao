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
import {
  type Installment,
  INSTALLMENT_STATUS,
  installmentTone,
  type Loan,
  LOAN_KIND,
  LOAN_STATUS,
  loanTone,
  periodLabel,
  settledPercent,
} from './loans-model';

/**
 * Adiantamento ou empréstimo: plano de prestações e saldo; submeter (valida limites e contrato), aprovar ou recusar
 * por outra pessoa, cancelar antes da aprovação e registar pagamentos directos. Os descontos vêm do processamento.
 */
@Component({
  selector: 'app-loan-detail',
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
    } @else if (!l()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let x = l()!;
      <app-page-detail
        [title]="kind(x) + ' ' + x.code + ' — ' + x.employee.fullName"
        [subtitle]="money(x.principal) + ' ' + x.currency + ' · ' + x.reason"
      >
        <ng-container actions>
          <a class="btn-secondary" [routerLink]="['/rh/colaboradores', x.employee.id]"
            >Ver colaborador</a
          >
          @if (x.access?.manage && x.status === 'DRAFT') {
            <button type="button" class="btn-primary" data-testid="ln-submit" (click)="submit()">
              Pedir aprovação
            </button>
          }
          @if (x.access?.approve) {
            <button type="button" class="btn-primary" data-testid="ln-approve" (click)="approve()">
              Aprovar
            </button>
            <button
              type="button"
              class="btn-secondary"
              data-testid="ln-reject"
              (click)="rejecting.set(true)"
            >
              Recusar
            </button>
          }
          @if (x.access?.manage && (x.status === 'DRAFT' || x.status === 'PENDING_APPROVAL')) {
            <button type="button" class="btn-secondary" data-testid="ln-cancel" (click)="cancel()">
              Cancelar
            </button>
          }
        </ng-container>

        @if (x.issues?.length) {
          <div
            class="mb-4 rounded-card bg-warning-soft p-3 text-sm text-warning-text"
            role="status"
            data-testid="ln-issues"
          >
            <p class="font-medium">Hoje este pedido não passaria:</p>
            <ul class="mt-1 list-disc pl-5">
              @for (i of x.issues; track $index) {
                <li>{{ i.message }}</li>
              }
            </ul>
          </div>
        }

        <section class="card" aria-labelledby="ln-plan-title">
          <h2 id="ln-plan-title" class="mb-3 flex items-center gap-2 font-semibold">
            Plano de prestações
            <span class="badge" [class]="tone(x.status)" data-testid="ln-status">{{
              status(x.status)
            }}</span>
          </h2>
          @if (x.status === 'ACTIVE' || x.status === 'SETTLED') {
            <div class="mb-3">
              <div class="flex justify-between text-sm">
                <span
                  >Liquidado
                  <strong class="tabular-nums" data-testid="ln-paid">{{
                    money(x.paidAmount)
                  }}</strong></span
                >
                <span
                  >Em dívida
                  <strong class="tabular-nums" data-testid="ln-outstanding">{{
                    money(x.outstandingAmount)
                  }}</strong></span
                >
              </div>
              <div
                class="mt-1 h-2 rounded-full bg-surface-2"
                role="progressbar"
                aria-label="Liquidado"
                [attr.aria-valuenow]="progress(x)"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div class="h-2 rounded-full bg-primary" [style.width.%]="progress(x)"></div>
              </div>
            </div>
          } @else if (x.status === 'DRAFT' || x.status === 'PENDING_APPROVAL') {
            <p class="mb-3 text-sm text-muted">
              Plano previsto: as prestações criam-se na aprovação.
            </p>
          }
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="ln-installments">
              <caption class="sr-only">
                Prestações
              </caption>
              <thead>
                <tr class="text-left text-muted">
                  <th scope="col" class="py-1 pr-2 font-medium">#</th>
                  <th scope="col" class="py-1 font-medium">Mês</th>
                  <th scope="col" class="py-1 pr-3 text-right font-medium whitespace-nowrap">
                    Valor ({{ x.currency }})
                  </th>
                  <th scope="col" class="py-1 font-medium">Estado</th>
                  <th scope="col" class="py-1 font-medium"><span class="sr-only">Acções</span></th>
                </tr>
              </thead>
              <tbody>
                @for (i of x.installments ?? []; track i.sequence) {
                  <tr class="border-t border-border">
                    <td class="py-1 pr-2 tabular-nums">{{ i.sequence }}</td>
                    <td class="py-1">{{ month(i.duePeriod) }}</td>
                    <td class="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                      {{ money(i.amount) }}
                    </td>
                    <td class="py-1">
                      <span class="badge whitespace-nowrap" [class]="iTone(i.status)">{{
                        iStatus(i.status)
                      }}</span>
                      @if (i.settlementReference) {
                        <span class="ml-1 text-muted"
                          >{{ i.settlementReference }} · {{ date(i.settledOn) }}</span
                        >
                      }
                    </td>
                    <td class="py-1 text-right">
                      @if (x.access?.manage && x.status === 'ACTIVE' && i.status === 'PENDING') {
                        <button
                          type="button"
                          class="btn-ghost px-2 py-1"
                          [attr.data-testid]="'ln-pay-' + i.sequence"
                          [attr.aria-label]="'Registar pagamento da prestação ' + i.sequence"
                          (click)="openPay(i)"
                        >
                          Pagar
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (x.status === 'PENDING_APPROVAL' && !x.access?.approve) {
            <p class="mt-3 text-sm text-muted">
              Aguarda a aprovação de outra pessoa com permissão neste âmbito (nunca quem preparou
              nem o próprio).
            </p>
          }
        </section>
        <div aside>
          <section class="card" aria-labelledby="ln-summary">
            <h2 id="ln-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                { label: 'Colaborador', value: x.employee.code + ' — ' + x.employee.fullName },
                { label: 'Tipo', value: kind(x) },
                { label: 'Montante', value: money(x.principal) + ' ' + x.currency },
                { label: 'Prestações', value: '' + x.installmentsCount },
                { label: 'Primeiro desconto', value: month(x.firstPeriod) },
                { label: 'Preparado por', value: x.createdBy },
                {
                  label: 'Decidido por',
                  value: x.decidedBy ? x.decidedBy + ' · ' + dateTime(x.decidedAt) : null,
                },
                { label: 'Comentário', value: x.decisionComment },
                { label: 'Limites', value: limits(x) },
              ]"
            />
          </section>
          <app-audit-history
            entityType="employee_loan"
            [entityId]="x.id"
            [refreshKey]="x.version"
          />
        </div>
      </app-page-detail>
    }

    <app-modal title="Recusar pedido" [open]="rejecting()" (closed)="rejecting.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <app-field label="Motivo" [required]="true" [error]="action.field('comment')">
        <textarea
          appControl
          class="input min-h-20"
          data-testid="ln-reject-reason"
          [(ngModel)]="comment"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="rejecting.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ln-reject-confirm"
          [disabled]="action.busy()"
          (click)="reject()"
        >
          Recusar
        </button>
      </ng-container>
    </app-modal>

    <app-modal
      [title]="'Pagamento da prestação ' + (paying()?.sequence ?? '')"
      [open]="!!paying()"
      (closed)="paying.set(null)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Para pagamentos fora do processamento salarial (por exemplo, amortização antecipada). A
        prestação fica liquidada e não volta a ser descontada.
      </p>
      <div class="space-y-3">
        <app-field label="Referência" [required]="true" [error]="action.field('reference')">
          <input
            appControl
            class="input"
            data-testid="ln-pay-ref"
            [(ngModel)]="pay.reference"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Data do pagamento" [required]="true" [error]="action.field('paidOn')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="ln-pay-date"
            [(ngModel)]="pay.paidOn"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Nota" [error]="action.field('note')">
          <input
            appControl
            class="input"
            [(ngModel)]="pay.note"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="paying.set(null)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ln-pay-confirm"
          [disabled]="action.busy()"
          (click)="confirmPay()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LoanDetail {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly l = signal<Loan | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly rejecting = signal(false);
  protected readonly paying = signal<Installment | null>(null);
  protected comment = '';
  protected pay = { reference: '', paidOn: '', note: '' };
  protected readonly date = formatDate;
  protected readonly dateTime = formatDateTime;
  protected readonly month = periodLabel;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly tone = loanTone;
  protected readonly status = (s: Loan['status']) => LOAN_STATUS[s];
  protected readonly iTone = installmentTone;
  protected readonly iStatus = (s: Installment['status']) => INSTALLMENT_STATUS[s];
  protected readonly kind = (x: Loan) => LOAN_KIND[x.kind];
  protected readonly progress = settledPercent;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected limits(x: Loan) {
    const l = x.limits;
    if (!l || (!l.maxInstallmentPercent && !l.maxInstallments)) return 'Sem limites configurados';
    const parts: string[] = [];
    if (l.maxInstallmentPercent)
      parts.push(`até ${l.maxInstallmentPercent.replace(/\.?0+$/, '')}% do salário base por mês`);
    if (l.maxInstallments) parts.push(`até ${l.maxInstallments} prestações`);
    return `${parts.join(', ')} (${l.policyReference})`;
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loadError.set(null);
    try {
      const x = await this.api.get<Loan>(`hr/loans/${id}`);
      this.l.set(x);
      this.breadcrumbs.setCurrent(`${x.code} — ${x.employee.fullName}`);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async post(path: string, body: Record<string, unknown>, message: string) {
    const x = this.l()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/loans/${x.id}/${path}`, { ...body, expectedVersion: x.version }),
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
    return this.post('submit', {}, 'Pedido enviado para aprovação.');
  }

  protected approve() {
    return this.post(
      'decision',
      { decision: 'APPROVE' },
      'Aprovado: as prestações descontam-se no processamento.',
    );
  }

  protected async reject() {
    const x = this.l()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/loans/${x.id}/decision`, {
        decision: 'REJECT',
        comment: this.comment.trim() || undefined,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.rejecting.set(false);
    await this.load(x.id);
    this.toasts.show('Pedido recusado.');
  }

  protected async cancel() {
    const ok = await this.confirm.ask({
      title: 'Cancelar pedido',
      message: 'Cancelar este pedido de adiantamento ou empréstimo?',
      confirmLabel: 'Cancelar pedido',
      danger: true,
    });
    if (ok) await this.post('cancel', {}, 'Pedido cancelado.');
  }

  protected openPay(i: Installment) {
    this.action.error.set(null);
    this.pay = { reference: '', paidOn: new Date().toISOString().slice(0, 10), note: '' };
    this.paying.set(i);
  }

  protected async confirmPay() {
    const x = this.l()!;
    const i = this.paying()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/loans/${x.id}/installments/${i.id}/payment`, {
        reference: this.pay.reference.trim(),
        paidOn: this.pay.paidOn,
        note: this.pay.note.trim() || undefined,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.paying.set(null);
    await this.load(x.id);
    this.toasts.show('Pagamento registado.');
  }
}
