import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { ToastService } from '../ui/toasts';
import {
  accountingLabel,
  type Obligation,
  PAYMENT_STATE,
  type PaymentState,
  type PaymentSummary,
  paymentTone,
} from './payroll-model';

interface BankAccount {
  id: string;
  legalEntityId: string;
  bankName: string;
  iban: string | null;
  accountNumber: string | null;
  currency: string;
  status: string;
}

/**
 * Pagamento e contabilidade de um lote fechado: obrigações (líquido, IRT, INSS, descontos) com o que falta pagar,
 * registo de pagamentos (parciais ou totais) e envio à contabilidade. Fechado ≠ pago.
 */
@Component({
  selector: 'app-payroll-payments',
  imports: [FormsModule, Modal, FormField, FieldControl, ErrorAlert, MoneyInput],
  template: `
    @if (data(); as d) {
      <section class="card mt-4" aria-labelledby="pp-title" data-testid="pp">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="pp-title" class="flex items-center gap-2 font-semibold">
            Pagamento e contabilidade
            <span class="badge" [class]="tone(d.paymentStatus)" data-testid="pp-status">{{
              state(d.paymentStatus)
            }}</span>
          </h2>
          @if (d.access.account) {
            <button
              type="button"
              class="btn-secondary"
              data-testid="pp-account"
              [disabled]="action.busy()"
              (click)="account()"
            >
              Contabilizar
            </button>
          }
        </div>
        <p class="mb-3 text-sm text-muted" data-testid="pp-accounting">{{ accounting(d) }}</p>
        @if (!d.obligations.length) {
          <p class="text-sm text-muted">Sem valores a pagar neste lote.</p>
        } @else {
          <ul class="divide-y divide-border text-sm">
            @for (o of d.obligations; track o.id) {
              <li class="py-2" [attr.data-testid]="'pp-' + o.kind">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-medium">{{ o.label }}</span>
                  <span class="flex items-center gap-2">
                    <span class="tabular-nums">{{ money(o.amount) }} {{ o.currency }}</span>
                    <span class="badge" [class]="tone(o.status)">{{ state(o.status) }}</span>
                  </span>
                </div>
                @if (o.status !== 'PAID') {
                  <p class="text-muted">
                    Falta {{ money(o.outstanding) }}
                    @if (d.access.pay) {
                      ·
                      <button
                        type="button"
                        class="link"
                        [attr.data-testid]="'pp-pay-' + o.kind"
                        (click)="openPay(o)"
                      >
                        Registar pagamento
                      </button>
                    }
                  </p>
                }
                @for (p of o.payments; track p.id) {
                  <p class="text-muted">
                    {{ date(p.paidOn) }} · {{ p.reference }} · {{ money(p.amount) }}
                    {{ p.bankName ? '· ' + p.bankName : '' }}
                    {{ p.accounted ? '· contabilizado' : '' }}
                  </p>
                }
              </li>
            }
          </ul>
        }
      </section>
    }

    <app-modal
      [title]="'Pagamento — ' + (paying()?.label ?? '')"
      [open]="!!paying()"
      (closed)="paying.set(null)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Montante" [required]="true" [error]="action.field('amount')">
          <app-money-input
            data-testid="pp-amount"
            [currency]="paying()?.currency ?? 'AOA'"
            [(ngModel)]="form.amount"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Data do pagamento" [required]="true" [error]="action.field('paidOn')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="pp-date"
            [(ngModel)]="form.paidOn"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Referência" [required]="true" [error]="action.field('reference')">
          <input
            appControl
            class="input"
            data-testid="pp-reference"
            [(ngModel)]="form.reference"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Conta bancária" [error]="action.field('bankAccountId')">
          <select
            appControl
            class="input"
            data-testid="pp-bank"
            [(ngModel)]="form.bankAccountId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (b of banks(); track b.id) {
              <option [ngValue]="b.id">{{ b.bankName }} · {{ b.iban ?? b.accountNumber }}</option>
            }
          </select>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="paying.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="pp-confirm"
          [disabled]="action.busy()"
          (click)="pay()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class PayrollPayments {
  readonly runId = input.required<string>();
  readonly legalEntityId = input.required<string>();
  readonly changed = output<void>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly data = signal<PaymentSummary | null>(null);
  protected readonly paying = signal<Obligation | null>(null);
  protected readonly banks = signal<BankAccount[]>([]);
  protected readonly action = new Action();
  protected form = {
    amount: null as string | null,
    paidOn: '',
    reference: '',
    bankAccountId: null as string | null,
  };
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly date = formatDate;
  protected readonly tone = paymentTone;
  protected readonly state = (s: PaymentState) => PAYMENT_STATE[s];
  protected readonly accounting = (d: PaymentSummary) => accountingLabel(d.accounting);

  constructor() {
    effect(() => {
      const id = this.runId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    try {
      this.data.set(await this.api.get<PaymentSummary>(`hr/payroll/runs/${id}/payments`));
    } catch {
      this.data.set(null);
    }
  }

  protected async openPay(o: Obligation) {
    this.action.error.set(null);
    this.form = {
      amount: o.outstanding,
      paidOn: new Date().toISOString().slice(0, 10),
      reference: '',
      bankAccountId: null,
    };
    try {
      const page = await this.api.page<BankAccount>('bank-accounts', { limit: 200 });
      this.banks.set(
        page.items.filter(
          (b) =>
            b.legalEntityId === this.legalEntityId() &&
            b.status === 'ACTIVE' &&
            b.currency.trim() === o.currency,
        ),
      );
    } catch {
      this.banks.set([]);
    }
    this.paying.set(o);
  }

  protected async pay() {
    const o = this.paying()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/payroll/obligations/${o.id}/payments`, {
        amount: this.form.amount,
        paidOn: this.form.paidOn || null,
        reference: this.form.reference.trim(),
        bankAccountId: this.form.bankAccountId ?? undefined,
        expectedVersion: o.version,
      }),
    );
    if (!done) return;
    this.paying.set(null);
    await this.load(this.runId());
    this.changed.emit();
    this.toasts.show('Pagamento registado.');
  }

  protected async account() {
    const done = await this.action.run(() =>
      this.api.post<{ posted: number }>(`hr/payroll/runs/${this.runId()}/accounting`, {}),
    );
    if (!done) {
      const e = this.action.error() as ApiError | null;
      this.toasts.show(e?.details?.[0]?.message ?? e?.message ?? 'Erro.', 'error');
      return;
    }
    await this.load(this.runId());
    this.toasts.show(
      done.posted
        ? `${done.posted} lançamento(s) enviado(s) à contabilidade.`
        : 'Nada por contabilizar.',
    );
  }
}
