import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { plain } from './rfq-model';
import {
  ACCOUNTING_DOCUMENT,
  ACCOUNTING_STATUS,
  accountingTone,
  type AccountingEvent,
  nonZeroAmounts,
  type Payable,
  PAYABLE_STATUS,
  payableTone,
} from './finance-model';

/**
 * Obrigação a pagar de uma factura de fornecedor (9.10): valor, notas de crédito, pagamentos e saldo; registar um
 * pagamento (tesouraria: conta bancária activa da entidade na moeda da factura, nunca acima do saldo); contabilização
 * da factura, das notas de crédito e dos pagamentos, com os falhados a repetir.
 */
@Component({
  selector: 'app-payable-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="'Obrigação ' + (x()?.invoice?.number ?? '')"
      [subtitle]="x() ? x()!.supplier.code + ' — ' + x()!.supplier.name : ''"
      formId="payable-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as p) {
        <section class="card space-y-3" aria-label="Estado" data-testid="py-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(p)" data-testid="py-status">{{ label(p) }}</span>
            <span class="text-sm text-muted">
              Factura
              <a class="link" [routerLink]="['/compras/facturas', p.invoice.id]">{{
                p.invoice.number
              }}</a>
              ({{ p.invoice.invoiceNumber }}) · ordem
              <a class="link" [routerLink]="['/compras/ordens', p.order.id]">{{
                p.order.number
              }}</a>
              · vence {{ date(p.dueDate) }}
              @if (p.costCenter) {
                · centro de custo {{ p.costCenter.code }}
              }
            </span>
          </div>
          <dl class="grid gap-2 text-sm sm:grid-cols-4" data-testid="py-amounts">
            <div>
              <dt class="text-muted">Valor da factura</dt>
              <dd class="tabular-nums">{{ money(p.amount, p.currency) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Notas de crédito</dt>
              <dd class="tabular-nums">{{ money(p.creditedAmount, p.currency) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Pago</dt>
              <dd class="tabular-nums">{{ money(p.paidAmount, p.currency) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Saldo</dt>
              <dd class="font-semibold tabular-nums" data-testid="py-balance">
                {{ money(p.balance, p.currency) }}
              </dd>
            </div>
          </dl>
          @if (!payOpen() && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (p.can.pay) {
              <button type="button" class="btn-primary" data-testid="py-pay" (click)="openPay(p)">
                Registar pagamento
              </button>
            }
            @if (p.can.retry && hasFailed(p)) {
              <button type="button" class="btn-secondary" data-testid="py-retry" (click)="retry()">
                Repetir contabilização
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="py-payments-title">
          <h2 id="py-payments-title" class="mb-2 font-semibold">Pagamentos</h2>
          <ul class="space-y-1 text-sm" data-testid="py-payments">
            @for (x of p.payments; track x.id) {
              <li>
                {{ date(x.paidOn) }} · {{ money(x.amount, p.currency) }} · {{ x.reference }}
                @if (x.bank) {
                  · {{ x.bank }}
                }
                @if (x.by) {
                  · {{ x.by }}
                }
                @if (x.exchangeRate !== '1.0000000000') {
                  <span class="text-muted">
                    · {{ money(x.amountFunctional, null) }} na moeda funcional</span
                  >
                }
              </li>
            } @empty {
              <li class="text-muted">Sem pagamentos.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="py-acc-title">
          <h2 id="py-acc-title" class="mb-2 font-semibold">Contabilização</h2>
          <p class="mb-2 text-xs text-muted">
            A factura salda as recepções por facturar pelo valor a que entraram no inventário e só
            lança a diferença: o stock nunca é lançado duas vezes. As contas vêm das regras de
            contabilização da empresa (origem PROCUREMENT).
          </p>
          <ul class="space-y-2 text-sm" data-testid="py-accounting">
            @for (e of p.accounting; track e.id) {
              <li class="rounded border border-border p-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="badge" [class]="atone(e.status)">{{ astatus(e.status) }}</span>
                  <span>{{ doc(e) }} · {{ e.sourceRef }} · {{ date(e.occurredOn) }}</span>
                  @if (e.entryNumber) {
                    <span class="text-muted">· lançamento {{ e.entryNumber }}</span>
                  }
                </div>
                <div class="mt-1 flex flex-wrap gap-x-4 text-xs text-muted">
                  @for (a of amounts(e); track a.label) {
                    <span>{{ a.label }} {{ money(a.value, null) }}</span>
                  }
                </div>
                @if (e.error) {
                  <p class="mt-1 text-xs text-danger-text">{{ e.error }}</p>
                }
              </li>
            } @empty {
              <li class="text-muted">Sem eventos.</li>
            }
          </ul>
        </section>

        <app-audit-history
          entityType="procurement_payable"
          [entityId]="p.id"
          [refreshKey]="p.version"
        />
      }
    </app-entity-form-page>

    <app-modal title="Registar pagamento" [open]="payOpen()" (closed)="payOpen.set(false)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Conta bancária" [required]="true" [error]="act.field('bankAccountId')">
          <select
            appControl
            class="input"
            name="bank"
            data-testid="py-bank"
            [(ngModel)]="f.bankAccountId"
          >
            <option value="">Escolher…</option>
            @for (b of x()?.bankAccounts ?? []; track b.id) {
              <option [value]="b.id">{{ b.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data" [required]="true" [error]="act.field('paidOn')">
          <input appControl class="input w-44" type="date" name="paidOn" [(ngModel)]="f.paidOn" />
        </app-field>
        <app-field
          [label]="'Valor (' + (x()?.currency ?? '') + ')'"
          [required]="true"
          [error]="act.field('amount')"
        >
          <input
            appControl
            class="input w-48"
            inputmode="decimal"
            name="amount"
            data-testid="py-amount"
            [(ngModel)]="f.amount"
          />
        </app-field>
        <app-field label="Referência" [required]="true" [error]="act.field('reference')">
          <input
            appControl
            class="input"
            name="reference"
            data-testid="py-reference"
            [(ngModel)]="f.reference"
          />
        </app-field>
        <app-field label="Notas" [error]="act.field('notes')">
          <input appControl class="input" name="notes" [(ngModel)]="f.notes" />
        </app-field>
        <p class="text-xs text-muted">
          Nunca acima do saldo; o pagamento não se altera depois de registado e segue para a
          contabilização.
        </p>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="payOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="py-pay-ok"
          [disabled]="act.busy()"
          (click)="pay()"
        >
          Registar
        </button>
      </div>
    </app-modal>
  `,
})
export class PayableDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Payable | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly payOpen = signal(false);
  protected f = { bankAccountId: '', paidOn: '', amount: '', reference: '', notes: '' };
  protected readonly money = money;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = (p: Payable) => payableTone(p.status, p.overdue);
  protected readonly label = (p: Payable) =>
    p.overdue && p.status !== 'SETTLED' ? 'Em atraso' : PAYABLE_STATUS[p.status];
  protected readonly atone = accountingTone;
  protected readonly astatus = (s: AccountingEvent['status']) => ACCOUNTING_STATUS[s];
  protected readonly doc = (e: AccountingEvent) => ACCOUNTING_DOCUMENT[e.documentType];
  protected readonly amounts = (e: AccountingEvent) => nonZeroAmounts(e.amounts);
  protected readonly hasFailed = (p: Payable) =>
    p.accounting.some((e) => e.status === 'FAILED' || e.status === 'PENDING');

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<Payable>(`procurement/payables/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(p: Payable) {
    this.x.set(p);
    this.breadcrumbs.setCurrent(p.invoice.number);
  }
  protected back() {
    void this.router.navigate(['/compras/obrigacoes']);
  }

  protected openPay(p: Payable) {
    this.act.error.set(null);
    this.f = {
      bankAccountId: p.bankAccounts.length === 1 ? p.bankAccounts[0].id : '',
      paidOn: new Date().toISOString().slice(0, 10),
      amount: plain(p.balance),
      reference: '',
      notes: '',
    };
    this.payOpen.set(true);
  }

  protected async pay() {
    const p = this.x()!;
    const res = await this.act.run(() =>
      this.api.post<Payable>(`procurement/payables/${p.id}/payments`, {
        expectedVersion: p.version,
        bankAccountId: this.f.bankAccountId || null,
        paidOn: this.f.paidOn,
        amount: this.f.amount.trim().replace(',', '.'),
        reference: this.f.reference,
        notes: this.f.notes.trim() || null,
      }),
    );
    if (!res) return;
    this.set(res);
    this.payOpen.set(false);
    this.toasts.show('Pagamento registado.');
  }

  protected async retry() {
    const p = this.x()!;
    const res = await this.act.run(() =>
      this.api.post<Payable>(`procurement/payables/${p.id}/accounting/retry`, {}),
    );
    if (!res) return;
    this.set(res);
    this.toasts.show(
      res.accounting.some((e) => e.status === 'FAILED')
        ? 'Ainda há eventos falhados: veja o motivo.'
        : 'Contabilização repetida.',
    );
  }
}
