import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { SIMULATION_NOTICE } from './fiscal-model';
import {
  METHOD,
  type OpenItems,
  PURPOSE,
  type Receipt,
  RECEIPT_STATUS,
  type ReceiptOptions,
  receiptTone,
} from './receipt-model';

type Dialog = 'confirm' | 'reject' | 'cancel' | 'advance' | null;

/**
 * Recebimento: valor, meio e referência, afectações e adiantamento; confirmação financeira (outra pessoa) que afecta
 * as facturas e numera o recibo ou emite a factura-recibo; recusa ou anulação com motivo; uso do adiantamento.
 */
@Component({
  selector: 'app-receipt-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    Attachments,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="
        x()
          ? (x()!.number ??
            (x()!.invoice?.number
              ? 'Factura-recibo ' + x()!.invoice!.number
              : 'Recebimento por confirmar'))
          : 'Recebimento'
      "
      [subtitle]="
        x() ? x()!.customer.code + ' — ' + x()!.customer.name + ' · ' + x()!.legalEntity.code : ''
      "
      formId="receipt-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as r) {
        <section class="card space-y-3" aria-label="Estado" data-testid="rd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(r.status)" data-testid="rcd-status">{{
              status(r.status)
            }}</span>
            <span class="text-sm text-muted">{{ purpose(r.purpose) }}</span>
            @if (r.decisionReason) {
              <span class="text-sm text-muted">{{ r.decisionReason }}</span>
            }
          </div>
          @if (r.status === 'PENDING') {
            <p class="text-sm text-muted">
              Ainda não conta: as facturas só são abatidas quando a tesouraria confirmar.
            </p>
          }
          <dl class="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">Valor</dt>
              <dd class="font-semibold" data-testid="rcd-amount">
                {{ money(r.amount, r.currency) }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Meio · referência</dt>
              <dd>{{ method(r.method) }}{{ r.reference ? ' · ' + r.reference : '' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Data</dt>
              <dd>{{ r.receivedDate }}</dd>
            </div>
            <div>
              <dt class="text-muted">Conta</dt>
              <dd>{{ r.bankAccount?.label ?? '—' }}</dd>
            </div>
          </dl>
          <p class="text-sm">
            Registado por {{ r.registeredBy ?? '—'
            }}{{
              r.confirmedBy
                ? ' · confirmado por ' + r.confirmedBy + ' em ' + when(r.confirmedAt)
                : ''
            }}
          </p>
          @if (r.status === 'PENDING' && !r.can.confirm && r.can.reject) {
            <p class="text-sm text-muted">Foi registado por si: outra pessoa tem de confirmar.</p>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (r.can.confirm) {
              <button
                type="button"
                class="btn-primary"
                data-testid="rcd-confirm"
                (click)="open('confirm')"
              >
                Confirmar recebimento
              </button>
            }
            @if (r.can.reject) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rcd-reject"
                (click)="open('reject')"
              >
                Recusar
              </button>
            }
            @if (r.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rcd-cancel"
                (click)="open('cancel')"
              >
                Anular
              </button>
            }
            @if (r.can.applyAdvance) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rcd-advance"
                (click)="openAdvance(r)"
              >
                Usar adiantamento
              </button>
            }
            @if (r.invoice) {
              <a class="link self-center" [routerLink]="['/vendas/facturas', r.invoice.id]"
                >Ver a factura-recibo</a
              >
            }
          </div>
        </section>

        <section class="card space-y-2" aria-labelledby="rcd-alloc">
          <h2 id="rcd-alloc" class="font-semibold">Afectação</h2>
          <ul class="space-y-1 text-sm" data-testid="rcd-allocations">
            @for (a of r.allocations; track a.invoiceId) {
              <li>
                <a class="link" [routerLink]="['/vendas/facturas', a.invoiceId]">{{ a.number }}</a>
                · {{ money(a.amount, r.currency) }}
              </li>
            }
            @for (a of r.applications; track $index) {
              <li>
                Adiantamento usado em
                <a class="link" [routerLink]="['/vendas/facturas', a.invoiceId]">{{ a.number }}</a>
                · {{ money(a.amount, r.currency) }} · {{ when(a.at) }}{{ a.by ? ' · ' + a.by : '' }}
              </li>
            }
          </ul>
          @if (r.status === 'CONFIRMED' && r.purpose === 'RECEIPT') {
            <p class="text-sm" data-testid="rcd-advance-balance">
              Adiantamento: {{ money(r.advanceTotal, r.currency) }} · usado
              {{ money(r.advanceUsed, r.currency) }} · disponível
              {{ money(r.advanceRemaining, r.currency) }}
            </p>
          }
        </section>

        <app-attachments
          subjectType="sales_receipt"
          [subjectId]="r.id"
          [canWrite]="r.can.cancel || r.can.confirm"
        />
        <app-audit-history entityType="sales_receipt" [entityId]="r.id" [refreshKey]="r.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @switch (dialog()) {
        @case ('confirm') {
          <p class="mb-3 text-sm">
            Confirma que {{ money(x()?.amount ?? '0', x()?.currency) }} entraram efectivamente? As
            facturas são abatidas,
            {{
              x()?.purpose === 'INVOICE_RECEIPT'
                ? 'a factura-recibo é emitida'
                : 'o recibo é numerado'
            }}
            e o excedente fica como adiantamento. {{ notice }}
          </p>
          @if (seriesChoices().length > 1) {
            <app-field label="Série" [required]="true" [error]="act.field('seriesId')">
              <select
                appControl
                class="input"
                name="series"
                data-testid="rcd-series"
                [(ngModel)]="seriesId"
              >
                <option value="">—</option>
                @for (s of seriesChoices(); track s.id) {
                  <option [value]="s.id">{{ s.code }} ({{ s.prefix }})</option>
                }
              </select>
            </app-field>
          }
        }
        @case ('advance') {
          <div class="space-y-3">
            <app-field label="Factura" [required]="true" [error]="act.field('invoiceId')">
              <select
                appControl
                class="input"
                name="inv"
                data-testid="rcd-a-invoice"
                [(ngModel)]="adv.invoiceId"
              >
                <option value="">—</option>
                @for (i of openInvoices(); track i.id) {
                  <option [value]="i.id">
                    {{ i.number }} · por receber {{ money(i.open, i.currency) }}
                  </option>
                }
              </select>
            </app-field>
            <app-field
              label="Valor"
              [required]="true"
              [hint]="'Disponível: ' + money(x()?.advanceRemaining ?? '0')"
              [error]="act.field('amount')"
            >
              <input
                appControl
                class="input w-40"
                inputmode="decimal"
                name="amt"
                data-testid="rcd-a-amount"
                [(ngModel)]="adv.amount"
              />
            </app-field>
          </div>
        }
        @default {
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <textarea
              appControl
              class="input min-h-16"
              name="reason"
              data-testid="rcd-reason"
              [(ngModel)]="reason"
            ></textarea>
          </app-field>
        }
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rcd-ok"
          [disabled]="act.busy()"
          (click)="submit()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class ReceiptDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Receipt | null>(null);
  protected readonly opts = signal<ReceiptOptions | null>(null);
  protected readonly openInvoices = signal<OpenItems['invoices']>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly act = new Action();
  protected readonly notice = SIMULATION_NOTICE;
  protected readonly money = money;
  protected readonly when = formatDateTime;
  protected readonly tone = receiptTone;
  protected readonly status = (s: string) => RECEIPT_STATUS[s] ?? s;
  protected readonly method = (s: string) => METHOD[s] ?? s;
  protected readonly purpose = (s: string) => PURPOSE[s] ?? s;
  protected readonly seriesChoices = computed(() => {
    const r = this.x();
    if (!r) return [];
    const kind = r.purpose === 'INVOICE_RECEIPT' ? 'INVOICE_RECEIPT' : 'RECEIPT';
    return (this.opts()?.series ?? []).filter(
      (s) =>
        s.legalEntityId === r.legalEntity.id &&
        s.documentKind === kind &&
        s.fiscalYear === Number(r.receivedDate.slice(0, 4)),
    );
  });
  protected seriesId = '';
  protected reason = '';
  protected adv = { invoiceId: '', amount: '' };

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected dialogTitle() {
    return (
      (
        {
          confirm: 'Confirmar o recebimento',
          reject: 'Recusar o recebimento',
          cancel: 'Anular o registo',
          advance: 'Usar adiantamento',
        } as Record<string, string>
      )[this.dialog() ?? ''] ?? ''
    );
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [r, o] = await Promise.all([
        this.api.get<Receipt>(`sales/receipts/${this.id()}`),
        this.api.get<ReceiptOptions>('sales/receipts/options').catch(() => null),
      ]);
      this.opts.set(o);
      this.set(r);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(r: Receipt) {
    this.x.set(r);
    this.breadcrumbs.setCurrent(r.number ?? 'Recebimento');
  }
  protected back() {
    void this.router.navigate(['/vendas/recebimentos']);
  }
  protected open(d: Dialog) {
    this.act.error.set(null);
    this.reason = '';
    this.seriesId = '';
    this.dialog.set(d);
  }
  protected async openAdvance(r: Receipt) {
    this.adv = { invoiceId: '', amount: '' };
    const items = await this.api
      .get<OpenItems>(`sales/receipts/open-items/${r.legalEntity.id}/${r.customer.id}`)
      .catch(() => null);
    this.openInvoices.set((items?.invoices ?? []).filter((i) => i.currency === r.currency));
    this.open('advance');
  }

  protected async submit() {
    const r = this.x()!;
    const d = this.dialog()!;
    const body: Record<string, unknown> = { expectedVersion: r.version };
    let path: string = d;
    if (d === 'confirm') body['seriesId'] = this.seriesId || null;
    else if (d === 'advance') {
      path = 'apply-advance';
      body['invoiceId'] = this.adv.invoiceId;
      body['amount'] = this.adv.amount.trim().replace(',', '.');
    } else body['reason'] = this.reason;
    const res = await this.act.run(() =>
      this.api.post<Receipt>(`sales/receipts/${r.id}/${path}`, body),
    );
    if (!res) return;
    this.set(res);
    this.dialog.set(null);
    this.toasts.show(
      {
        confirm: 'Recebimento confirmado.',
        reject: 'Recebimento recusado.',
        cancel: 'Registo anulado.',
        advance: 'Adiantamento aplicado.',
      }[d],
    );
  }
}
