import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { ratePct, SIMULATION_NOTICE } from './fiscal-model';
import { SUBMISSION_STATUS } from './fiscal-integration-model';
import { percent, price, qty } from './pricing-model';
import {
  COLLECTION_STATE,
  FISCAL_STATE,
  type Invoice,
  INVOICE_EVENT,
  INVOICE_STATUS,
  type InvoiceLine,
  type InvoiceOptions,
  invoiceTone,
} from './invoice-model';

/**
 * Factura: emitente e estabelecimento, série/número, cliente fotografado (NIF e morada usados), data, vencimento,
 * moeda e câmbio, origem; linhas com unidade, preço, desconto, impostos e isenção; resumo dos impostos e totais.
 * Três estados distintos. Emitida é imutável; emissão demonstrativa (série em simulação).
 */
@Component({
  selector: 'app-invoice-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    DataTable,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    Attachments,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? (x()!.number ?? 'Factura em rascunho') : 'Factura'"
      [subtitle]="
        x() ? x()!.legalEntity.code + ' · ' + x()!.customer.code + ' — ' + x()!.customer.name : ''
      "
      formId="invoice-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as v) {
        @if (v.simulation) {
          <p
            class="rounded-card border border-warning bg-warning-soft p-3 text-sm text-warning-text"
            role="note"
            data-testid="id-simulation"
          >
            {{ notice }}
          </p>
        }
        <section class="card space-y-3" aria-label="Estados" data-testid="id-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(v.status)" data-testid="id-status">{{
              status(v.status)
            }}</span>
            <span class="text-sm text-muted" data-testid="id-kind">{{
              v.documentKind === 'INVOICE_RECEIPT' ? 'Factura-recibo' : 'Factura'
            }}</span>
            @if (v.fiscalStatus) {
              <span class="badge" [class]="tone(v.fiscalStatus)" data-testid="id-fiscal">{{
                fiscal(v.fiscalStatus)
              }}</span>
            }
            @if (fiscalSub(); as fs) {
              <a
                class="link text-sm"
                data-testid="id-fiscal-link"
                [routerLink]="['/vendas/fiscal/submissoes', fs.id]"
                >Comunicação: {{ subStatus(fs.status) }}</a
              >
            }
            @if (v.collectionStatus) {
              <span class="badge" [class]="tone(v.collectionStatus)" data-testid="id-collection">{{
                collection(v.collectionStatus)
              }}</span>
            }
            @if (v.discardReason) {
              <span class="text-sm text-muted">{{ v.discardReason }}</span>
            }
          </div>
          <div class="grid gap-4 text-sm md:grid-cols-2">
            <div>
              <h2 class="font-semibold">Emitente</h2>
              <p>
                {{ v.legalEntity.name
                }}{{ v.legalEntity.taxId ? ' · NIF ' + v.legalEntity.taxId : '' }}
              </p>
              @if (v.branch) {
                <p class="text-muted">Estabelecimento {{ v.branch.code }} — {{ v.branch.name }}</p>
              }
              @if (v.series) {
                <p class="text-muted">Série {{ v.series.code }} ({{ v.series.fiscalCode }})</p>
              }
            </div>
            <div data-testid="id-customer">
              <h2 class="font-semibold">Cliente</h2>
              @if (v.customerSnapshot; as c) {
                <p>{{ c.name }}{{ c.taxId ? ' · NIF ' + c.taxId : '' }}</p>
                <p class="text-muted">
                  {{ c.billingAddress.addressLine ?? '' }} {{ c.billingAddress.city ?? '' }}
                  {{ c.billingAddress.countryCode }}
                </p>
                <p class="text-xs text-muted">Dados fiscais como na emissão.</p>
              } @else {
                <p>{{ v.customer.code }} — {{ v.customer.name }}</p>
                <p class="text-xs text-muted">Os dados fiscais fixam-se na emissão.</p>
              }
            </div>
          </div>
          <dl class="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">Data · vencimento</dt>
              <dd>{{ v.invoiceDate }} · {{ v.dueDate ?? v.paymentTermsDays + ' dias' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Moeda · câmbio</dt>
              <dd>
                {{ v.currency
                }}{{
                  v.exchangeRate && v.currency !== v.functionalCurrency
                    ? ' · ' + v.exchangeRate + ' ' + v.functionalCurrency
                    : ''
                }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Origem</dt>
              <dd>
                @if (v.order) {
                  <a class="link" [routerLink]="['/vendas/encomendas', v.order.id]">{{
                    v.order.number
                  }}</a>
                } @else {
                  —
                }
              </dd>
            </div>
            <div>
              <dt class="text-muted">A pagar</dt>
              <dd class="font-semibold" data-testid="id-payable">
                {{ money(v.payableTotal, v.currency) }}
              </dd>
            </div>
          </dl>
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (v.can.edit) {
              <a
                class="btn-secondary"
                data-testid="id-edit"
                [routerLink]="['/vendas/facturas', v.id, 'editar']"
                >Editar</a
              >
            }
            @if (v.can.issue && v.documentKind === 'INVOICE') {
              <button
                type="button"
                class="btn-primary"
                data-testid="id-issue"
                (click)="open('issue')"
              >
                Emitir
              </button>
            }
            @if (v.status === 'DRAFT' && v.documentKind === 'INVOICE_RECEIPT') {
              <a
                class="btn-primary"
                data-testid="id-register-payment"
                routerLink="/vendas/recebimentos/novo"
                [queryParams]="{ purpose: 'INVOICE_RECEIPT' }"
                >Registar o recebimento</a
              >
              <span class="self-center text-sm text-muted"
                >Emite-se quando a tesouraria confirmar o recebimento.</span
              >
            }
            @if (correctable(v)) {
              <a
                class="btn-secondary"
                data-testid="id-credit-note"
                routerLink="/vendas/notas/nova"
                [queryParams]="{ invoiceId: v.id, kind: 'CREDIT' }"
                >Nota de crédito</a
              >
              <a
                class="btn-secondary"
                data-testid="id-debit-note"
                routerLink="/vendas/notas/nova"
                [queryParams]="{ invoiceId: v.id, kind: 'DEBIT' }"
                >Nota de débito</a
              >
            }
            @if (v.can.discard) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="id-discard"
                (click)="open('discard')"
              >
                Descartar
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="id-lines-title">
          <h2 id="id-lines-title" class="mb-2 font-semibold">Linhas</h2>
          <app-data-table
            label="Linhas da factura"
            [columns]="columns"
            [rows]="v.lines"
            [total]="v.lines.length"
            [limit]="1000"
            emptyText="Sem linhas."
          />
          <div class="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <h3 class="mb-1 text-sm font-semibold">Impostos</h3>
              <ul class="space-y-1 text-sm" data-testid="id-taxes">
                @for (s of v.taxSummary?.summary ?? []; track $index) {
                  <li>
                    {{ s.code }} {{ pct(s.rate)
                    }}{{ s.exemptionCode ? ' · isento (' + s.exemptionCode + ')' : '' }} · base
                    {{ money(s.base) }} ·
                    {{ s.applied === false ? 'abaixo da base mínima' : money(s.amount) }}
                  </li>
                }
              </ul>
              @if (v.roundingLevel) {
                <p class="mt-1 text-xs text-muted">
                  Arredondamento {{ v.roundingLevel === 'LINE' ? 'por linha' : 'por documento' }}.
                </p>
              }
            </div>
            <dl
              class="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm"
              data-testid="id-totals"
            >
              <dt class="text-muted">Líquido</dt>
              <dd class="text-right">{{ money(v.netTotal, v.currency) }}</dd>
              <dt class="text-muted">Imposto</dt>
              <dd class="text-right">{{ money(v.taxTotal, v.currency) }}</dd>
              <dt class="text-muted">Total</dt>
              <dd class="text-right">{{ money(v.grossTotal, v.currency) }}</dd>
              @if (v.withholdingTotal !== '0.00') {
                <dt class="text-muted">Retenção</dt>
                <dd class="text-right">{{ money(v.withholdingTotal, v.currency) }}</dd>
              }
              <dt class="font-semibold">A pagar</dt>
              <dd class="text-right font-semibold">{{ money(v.payableTotal, v.currency) }}</dd>
            </dl>
          </div>
          @if (v.documentHash) {
            <p class="mt-3 break-all text-xs text-muted">
              Emitida em {{ when(v.issuedAt) }}{{ v.issuedBy ? ' por ' + v.issuedBy : '' }} ·
              impressão digital interna (não é a assinatura fiscal): {{ v.documentHash }}
            </p>
          }
        </section>

        @if (v.correctionNotes.length) {
          <section class="card" aria-labelledby="id-n-title">
            <h2 id="id-n-title" class="mb-2 font-semibold">Correcções</h2>
            <p class="mb-2 text-sm text-muted">
              A factura emitida não muda: as correcções fazem-se por notas de crédito e débito.
            </p>
            <ul class="space-y-1 text-sm" data-testid="id-notes">
              @for (n of v.correctionNotes; track n.id) {
                <li>
                  <a class="link" [routerLink]="['/vendas/notas', n.id]">{{
                    n.number ??
                      (n.kind === 'CREDIT' ? 'Nota de crédito' : 'Nota de débito') + ' (rascunho)'
                  }}</a>
                  · {{ n.date }} · {{ n.kind === 'CREDIT' ? '−' : '+'
                  }}{{ money(n.payable, v.currency) }}
                </li>
              }
            </ul>
          </section>
        }
        @if (v.payments.length) {
          <section class="card" aria-labelledby="id-p-title">
            <h2 id="id-p-title" class="mb-2 font-semibold">Recebimentos</h2>
            <ul class="space-y-1 text-sm" data-testid="id-payments">
              @for (p of v.payments; track $index) {
                <li>
                  <a
                    class="link"
                    [routerLink]="[
                      p.kind === 'CREDIT_NOTE' ? '/vendas/notas' : '/vendas/recebimentos',
                      p.receiptId,
                    ]"
                    >{{
                      p.number ?? (p.kind === 'INVOICE_RECEIPT' ? 'Factura-recibo' : 'Recebimento')
                    }}</a
                  >
                  · {{ p.date }} · {{ money(p.amount, v.currency)
                  }}{{ p.kind === 'ADVANCE' ? ' (adiantamento)' : '' }}
                </li>
              }
            </ul>
            <p class="mt-1 text-sm">
              Pago: {{ money(v.paidTotal, v.currency) }} de {{ money(v.payableTotal, v.currency) }}
            </p>
          </section>
        }
        @if (v.openTotal !== null) {
          <section class="card" aria-label="Em dívida">
            <dl class="grid max-w-md grid-cols-2 gap-1 text-sm" data-testid="id-balance">
              <dt class="text-muted">A pagar</dt>
              <dd class="text-right">{{ money(v.payableTotal, v.currency) }}</dd>
              <dt class="text-muted">Notas de débito</dt>
              <dd class="text-right">+{{ money(v.debitedTotal, v.currency) }}</dd>
              <dt class="text-muted">Notas de crédito</dt>
              <dd class="text-right">−{{ money(v.creditedTotal, v.currency) }}</dd>
              <dt class="text-muted">Recebido</dt>
              <dd class="text-right">−{{ money(v.paidTotal, v.currency) }}</dd>
              <dt class="font-semibold">Em dívida</dt>
              <dd class="text-right font-semibold" data-testid="id-open">
                {{ money(v.openTotal, v.currency) }}
              </dd>
            </dl>
          </section>
        }
        <app-attachments
          subjectType="sales_invoice"
          [subjectId]="v.id"
          [canWrite]="v.can.edit || v.can.issue"
        />

        <section class="card" aria-labelledby="id-h-title">
          <h2 id="id-h-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="id-history">
            @for (h of v.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ event(h.kind)
                }}{{ h.by ? ' · ' + h.by : '' }}
                @if (h.reason) {
                  · <em>{{ h.reason }}</em>
                }
              </li>
            }
          </ul>
        </section>

        <app-audit-history entityType="sales_invoice" [entityId]="v.id" [refreshKey]="v.version" />
      }
    </app-entity-form-page>

    <app-modal
      [title]="dialog() === 'issue' ? 'Emitir a factura' : 'Descartar o rascunho'"
      [open]="dialog() !== null"
      (closed)="dialog.set(null)"
    >
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @if (dialog() === 'issue') {
        <p class="mb-3 text-sm">
          Preços e impostos são recalculados à data, o cliente é fotografado e a factura recebe o
          número da série. Depois de emitida não muda: corrige-se por nota de crédito ou débito.
          {{ notice }}
        </p>
        @if (seriesChoices().length > 1) {
          <app-field label="Série" [required]="true" [error]="act.field('seriesId')">
            <select
              appControl
              class="input"
              name="series"
              data-testid="id-series"
              [(ngModel)]="seriesId"
            >
              <option value="">—</option>
              @for (s of seriesChoices(); track s.id) {
                <option [value]="s.id">{{ s.code }} ({{ s.prefix }})</option>
              }
            </select>
          </app-field>
        }
      } @else {
        <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
          <textarea
            appControl
            class="input min-h-16"
            name="reason"
            data-testid="id-reason"
            [(ngModel)]="reason"
          ></textarea>
        </app-field>
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="id-ok"
          [disabled]="act.busy()"
          (click)="confirm()"
        >
          {{ dialog() === 'issue' ? 'Emitir' : 'Descartar' }}
        </button>
      </div>
    </app-modal>
  `,
})
export class InvoiceDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected correctable(v: Invoice) {
    return (
      (v.status === 'ISSUED' || v.status === 'CORRECTED') &&
      this.workspace.canAny('sales.notes.manage')
    );
  }
  protected readonly x = signal<Invoice | null>(null);
  protected readonly opts = signal<InvoiceOptions | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly fiscalSub = signal<{ id: string; status: string } | null>(null);
  protected readonly subStatus = (s: string) => SUBMISSION_STATUS[s] ?? s;
  protected readonly dialog = signal<'issue' | 'discard' | null>(null);
  protected readonly act = new Action();
  protected readonly notice = SIMULATION_NOTICE;
  protected readonly money = money;
  protected readonly pct = ratePct;
  protected readonly when = formatDateTime;
  protected readonly tone = invoiceTone;
  protected readonly status = (s: string) => INVOICE_STATUS[s] ?? s;
  protected readonly fiscal = (s: string) => FISCAL_STATE[s] ?? s;
  protected readonly collection = (s: string) => COLLECTION_STATE[s] ?? s;
  protected readonly event = (k: string) => INVOICE_EVENT[k] ?? k;
  protected readonly seriesChoices = computed(() => {
    const v = this.x();
    if (!v) return [];
    return (this.opts()?.series ?? []).filter(
      (s) =>
        s.legalEntityId === v.legalEntity.id && s.fiscalYear === Number(v.invoiceDate.slice(0, 4)),
    );
  });
  protected seriesId = '';
  protected reason = '';
  protected readonly columns: Column<InvoiceLine>[] = [
    {
      key: 'description',
      label: 'Descrição',
      required: true,
      value: (l) => `${l.product.sku} — ${l.description}`,
    },
    { key: 'quantity', label: 'Qtd.', align: 'end', value: (l) => `${qty(l.quantity)} ${l.uom}` },
    { key: 'price', label: 'Preço', align: 'end', value: (l) => price(l.netUnitPrice) },
    {
      key: 'discount',
      label: 'Desconto',
      align: 'end',
      hideOnMobile: true,
      value: (l) => (l.discountPct === '0.0000' ? '—' : percent(l.discountPct)),
    },
    { key: 'net', label: 'Líquido', align: 'end', value: (l) => money(l.netAmount) },
    {
      key: 'taxes',
      label: 'Impostos',
      value: (l) =>
        l.taxes
          .map(
            (t) =>
              `${t.code} ${ratePct(t.rate)}${t.exemptionCode ? ' isento ' + t.exemptionCode : ''}`,
          )
          .join(', '),
    },
  ];

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [v, o] = await Promise.all([
        this.api.get<Invoice>(`sales/invoices/${this.id()}`),
        this.api.get<InvoiceOptions>('sales/invoices/options').catch(() => null),
      ]);
      this.opts.set(o);
      this.set(v);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(v: Invoice) {
    this.x.set(v);
    void this.api
      .get<{ id: string; status: string }>(
        `sales/fiscal/submissions/document/SALES_INVOICE/${v.id}`,
      )
      .then((x) => this.fiscalSub.set(x))
      .catch(() => this.fiscalSub.set(null));
    this.breadcrumbs.setCurrent(v.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/vendas/facturas']);
  }
  protected open(d: 'issue' | 'discard') {
    this.act.error.set(null);
    this.seriesId = '';
    this.reason = '';
    this.dialog.set(d);
  }

  protected async confirm() {
    const v = this.x()!;
    const d = this.dialog()!;
    const r = await this.act.run(() =>
      this.api.post<Invoice>(`sales/invoices/${v.id}/${d}`, {
        expectedVersion: v.version,
        ...(d === 'issue' ? { seriesId: this.seriesId || null } : { reason: this.reason }),
      }),
    );
    if (!r) return;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show(
      d === 'issue' ? `Factura ${r.number} emitida (simulação).` : 'Rascunho descartado.',
    );
  }
}
