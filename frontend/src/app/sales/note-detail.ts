import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
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
import { qty } from './pricing-model';
import { METHOD } from './receipt-model';
import {
  amountOrNull,
  type Note,
  NOTE_KIND,
  NOTE_REASON,
  NOTE_STATUS,
  type NoteOptions,
  noteTone,
  type Refund,
  REFUND_STATUS,
} from './note-model';

type Dialog =
  'issue' | 'discard' | 'apply' | 'refund' | 'rf-confirm' | 'rf-reject' | 'rf-cancel' | null;

/**
 * Nota de crédito ou débito: referência à factura original, motivo, linhas com o imposto original, totais; emissão
 * numerada em simulação (a de crédito por outra pessoa); crédito disponível usado noutra factura ou reembolsado com
 * confirmação financeira por outra pessoa.
 */
@Component({
  selector: 'app-note-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    DataTable,
    Attachments,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? (x()!.number ?? kind(x()!.kind) + ' (rascunho)') : 'Nota'"
      [subtitle]="
        x() ? x()!.customer.code + ' — ' + x()!.customer.name + ' · ' + x()!.legalEntity.code : ''
      "
      formId="note-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as n) {
        @if (n.simulation) {
          <p
            class="rounded-card border border-warning bg-warning-soft p-3 text-sm text-warning-text"
            role="note"
            data-testid="nd-simulation"
          >
            {{ notice }}
          </p>
        }
        <section class="card space-y-3" aria-label="Estado" data-testid="nd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(n.status)" data-testid="nd-status">{{
              status(n.status)
            }}</span>
            <span class="text-sm" data-testid="nd-kind">{{ kind(n.kind) }}</span>
          </div>
          <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-muted">Factura original</dt>
              <dd>
                <a
                  class="link"
                  data-testid="nd-invoice"
                  [routerLink]="['/vendas/facturas', n.invoice.id]"
                  >{{ n.invoice.number }}</a
                >
                · {{ n.invoice.date }}
              </dd>
            </div>
            @if (n.returnDoc) {
              <div>
                <dt class="text-muted">Devolução física</dt>
                <dd data-testid="nd-return">
                  @if (n.order) {
                    <a class="link" [routerLink]="['/vendas/encomendas', n.order.id]">{{
                      n.returnDoc.reference
                    }}</a>
                  } @else {
                    {{ n.returnDoc.reference }}
                  }
                </dd>
              </div>
            }
            <div>
              <dt class="text-muted">Motivo</dt>
              <dd data-testid="nd-reason-text">{{ reason(n.reasonCode) }} — {{ n.reason }}</dd>
            </div>
            <div>
              <dt class="text-muted">Data</dt>
              <dd>{{ n.noteDate }}</dd>
            </div>
            <div>
              <dt class="text-muted">Cliente (como na factura)</dt>
              <dd>
                {{ n.customerSnapshot?.name ?? n.customer.name }}
                @if (n.customerSnapshot?.taxId) {
                  · NIF {{ n.customerSnapshot!.taxId }}
                }
              </dd>
            </div>
            <div>
              <dt class="text-muted">Moeda e câmbio da factura</dt>
              <dd>{{ n.currency }} · {{ n.exchangeRate }}</dd>
            </div>
            <div>
              <dt class="text-muted">Total</dt>
              <dd class="font-semibold" data-testid="nd-total">
                {{ n.kind === 'CREDIT' ? '−' : '+' }}{{ money(n.payableTotal, n.currency) }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Preparada por</dt>
              <dd>
                {{ n.createdBy ?? '—'
                }}{{ n.issuedBy ? ' · emitida por ' + n.issuedBy + ' em ' + when(n.issuedAt) : '' }}
              </dd>
            </div>
          </dl>
          @if (n.status === 'DRAFT' && n.kind === 'CREDIT' && !n.can.issue && n.can.edit) {
            <p class="text-sm text-muted">
              Preparada por si: a nota de crédito é emitida por outra pessoa.
            </p>
          }
          @if (n.discardReason) {
            <p class="text-sm">
              Descartada: <em>{{ n.discardReason }}</em>
            </p>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="false" />
          }
          <div class="flex flex-wrap gap-2">
            @if (n.can.edit) {
              <a
                class="btn-secondary"
                data-testid="nd-edit"
                [routerLink]="['/vendas/notas', n.id, 'editar']"
                >Editar</a
              >
            }
            @if (n.can.issue) {
              <button
                type="button"
                class="btn-primary"
                data-testid="nd-issue"
                (click)="open('issue')"
              >
                Emitir
              </button>
            }
            @if (n.can.discard) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="nd-discard"
                (click)="open('discard')"
              >
                Descartar
              </button>
            }
            @if (n.can.applyCredit) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="nd-apply"
                (click)="openApply()"
              >
                Usar o crédito noutra factura
              </button>
            }
            @if (n.can.refund) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="nd-refund"
                (click)="openRefund()"
              >
                Registar reembolso
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="nd-lines-title">
          <h2 id="nd-lines-title" class="mb-2 font-semibold">Linhas</h2>
          <app-data-table
            label="Linhas da nota"
            [columns]="columns"
            [rows]="n.lines"
            [total]="n.lines.length"
            [limit]="1000"
            emptyText="Sem linhas."
          />
          <div class="mt-3 grid gap-4 md:grid-cols-2">
            <div class="text-sm" data-testid="nd-taxes">
              <h3 class="mb-1 font-semibold">Impostos (os da factura original)</h3>
              @for (t of n.taxSummary; track $index) {
                <p>
                  {{ t.code }} {{ rate(t.rate) }} · base {{ money(t.base) }} · {{ money(t.amount) }}
                </p>
              } @empty {
                <p class="text-muted">—</p>
              }
            </div>
            <dl class="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm">
              <dt class="text-muted">Líquido</dt>
              <dd class="text-right">{{ money(n.netTotal, n.currency) }}</dd>
              <dt class="text-muted">Imposto</dt>
              <dd class="text-right">{{ money(n.taxTotal, n.currency) }}</dd>
              @if (n.withholdingTotal !== '0.00') {
                <dt class="text-muted">Retenção</dt>
                <dd class="text-right">−{{ money(n.withholdingTotal, n.currency) }}</dd>
              }
              <dt class="font-semibold">Total</dt>
              <dd class="text-right font-semibold">{{ money(n.payableTotal, n.currency) }}</dd>
            </dl>
          </div>
          @if (n.documentHash) {
            <p class="mt-2 text-xs break-all text-muted">
              Impressão digital interna (não é a assinatura fiscal): {{ n.documentHash }}
            </p>
          }
        </section>

        @if (n.kind === 'CREDIT' && n.status === 'ISSUED') {
          <section class="card space-y-2" aria-labelledby="nd-c-title" data-testid="nd-credit">
            <h2 id="nd-c-title" class="font-semibold">Crédito</h2>
            <dl class="grid max-w-md grid-cols-2 gap-1 text-sm">
              <dt class="text-muted">Abatido em facturas</dt>
              <dd class="text-right">{{ money(n.appliedTotal, n.currency) }}</dd>
              <dt class="text-muted">Reembolsado</dt>
              <dd class="text-right">{{ money(n.refundedTotal, n.currency) }}</dd>
              <dt class="text-muted">Reembolsos por confirmar</dt>
              <dd class="text-right">{{ money(n.pendingRefunds, n.currency) }}</dd>
              <dt class="font-semibold">Disponível</dt>
              <dd class="text-right font-semibold" data-testid="nd-available">
                {{ money(n.availableCredit, n.currency) }}
              </dd>
            </dl>
            @if (n.applications.length) {
              <ul class="space-y-1 text-sm" data-testid="nd-applications">
                @for (a of n.applications; track $index) {
                  <li>
                    Abatido em
                    <a class="link" [routerLink]="['/vendas/facturas', a.invoiceId]">{{
                      a.number
                    }}</a>
                    · {{ money(a.amount, n.currency) }} · {{ when(a.at)
                    }}{{ a.by ? ' · ' + a.by : '' }}
                  </li>
                }
              </ul>
            }
            @if (n.refunds.length) {
              <h3 class="pt-2 font-semibold">Reembolsos</h3>
              <ul class="space-y-2 text-sm" data-testid="nd-refunds">
                @for (f of n.refunds; track f.id) {
                  <li class="flex flex-wrap items-center gap-2">
                    <span class="badge" [class]="tone(f.status)" data-testid="nd-rf-status">{{
                      refundStatus(f.status)
                    }}</span>
                    {{ money(f.amount, n.currency) }} · {{ method(f.method)
                    }}{{ f.reference ? ' · ' + f.reference : '' }} · {{ f.refundDate }}
                    {{ f.registeredBy ? ' · registado por ' + f.registeredBy : '' }}
                    {{ f.confirmedBy ? ' · confirmado por ' + f.confirmedBy : '' }}
                    @if (f.decisionReason) {
                      · <em>{{ f.decisionReason }}</em>
                    }
                    @if (f.can.confirm) {
                      <button
                        type="button"
                        class="btn-primary"
                        data-testid="nd-rf-confirm"
                        (click)="openRefundDecision(f, 'rf-confirm')"
                      >
                        Confirmar pagamento
                      </button>
                    }
                    @if (f.can.reject) {
                      <button
                        type="button"
                        class="btn-secondary"
                        data-testid="nd-rf-reject"
                        (click)="openRefundDecision(f, 'rf-reject')"
                      >
                        Recusar
                      </button>
                    }
                    @if (f.can.cancel) {
                      <button
                        type="button"
                        class="btn-secondary"
                        data-testid="nd-rf-cancel"
                        (click)="openRefundDecision(f, 'rf-cancel')"
                      >
                        Anular
                      </button>
                    }
                  </li>
                }
              </ul>
            }
          </section>
        }

        <app-attachments
          subjectType="sales_note"
          [subjectId]="n.id"
          [canWrite]="n.can.edit || n.can.issue"
        />
        <app-audit-history entityType="sales_note" [entityId]="n.id" [refreshKey]="n.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @switch (dialog()) {
        @case ('issue') {
          <p class="mb-3 text-sm">
            A nota fica numerada e imutável. O elegível é recalculado com as notas já emitidas.
            {{
              x()?.kind === 'CREDIT'
                ? 'O crédito abate o que está em dívida na factura; o resto fica como crédito do cliente.'
                : 'O valor em dívida da factura aumenta.'
            }}
            {{ notice }}
          </p>
          @if (seriesChoices().length > 1) {
            <app-field label="Série" [required]="true" [error]="act.field('seriesId')">
              <select
                appControl
                class="input"
                name="series"
                data-testid="nd-series"
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
        @case ('apply') {
          <div class="space-y-3">
            <app-field label="Factura" [required]="true" [error]="act.field('invoiceId')">
              <select
                appControl
                class="input"
                name="inv"
                data-testid="nd-a-invoice"
                [(ngModel)]="apply.invoiceId"
              >
                <option value="">—</option>
                @for (i of x()?.openInvoices ?? []; track i.id) {
                  <option [value]="i.id">
                    {{ i.number }} · em dívida {{ money(i.open, x()!.currency) }}
                  </option>
                }
              </select>
            </app-field>
            <app-field
              label="Valor"
              [required]="true"
              [hint]="'Disponível: ' + money(x()?.availableCredit ?? '0')"
              [error]="act.field('amount')"
            >
              <input
                appControl
                class="input w-40"
                inputmode="decimal"
                name="amt"
                data-testid="nd-a-amount"
                [(ngModel)]="apply.amount"
              />
            </app-field>
          </div>
        }
        @case ('refund') {
          <div class="space-y-3">
            <p class="text-sm text-muted">
              Fica por confirmar: só conta quando a tesouraria (outra pessoa) confirmar o pagamento.
            </p>
            <app-field
              label="Valor"
              [required]="true"
              [hint]="'Disponível: ' + money(x()?.availableCredit ?? '0')"
              [error]="act.field('amount')"
            >
              <input
                appControl
                class="input w-40"
                inputmode="decimal"
                name="ramt"
                data-testid="nd-r-amount"
                [(ngModel)]="refund.amount"
              />
            </app-field>
            <app-field label="Data" [required]="true" [error]="act.field('refundDate')">
              <input appControl class="input" type="date" name="rdate" [(ngModel)]="refund.date" />
            </app-field>
            <app-field label="Meio" [required]="true" [error]="act.field('method')">
              <select
                appControl
                class="input"
                name="rmethod"
                data-testid="nd-r-method"
                [(ngModel)]="refund.method"
              >
                @for (m of methods; track m[0]) {
                  <option [value]="m[0]">{{ m[1] }}</option>
                }
              </select>
            </app-field>
            <app-field
              label="Conta que paga"
              [required]="refund.method === 'TRANSFER'"
              [error]="act.field('bankAccountId')"
            >
              <select
                appControl
                class="input"
                name="rbank"
                data-testid="nd-r-bank"
                [(ngModel)]="refund.bankAccountId"
              >
                <option value="">—</option>
                @for (b of banks(); track b.id) {
                  <option [value]="b.id">{{ b.label }} ({{ b.currency }})</option>
                }
              </select>
            </app-field>
            <app-field
              label="Referência"
              [required]="['TRANSFER', 'CARD', 'CHEQUE'].includes(refund.method)"
              [error]="act.field('reference')"
            >
              <input
                appControl
                class="input"
                name="rref"
                data-testid="nd-r-ref"
                [(ngModel)]="refund.reference"
              />
            </app-field>
          </div>
        }
        @case ('rf-confirm') {
          <p class="text-sm">
            Confirma que {{ money(target()?.amount ?? '0', x()?.currency) }} foram pagos ao cliente?
            O crédito da nota baixa nesse valor.
          </p>
        }
        @default {
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <textarea
              appControl
              class="input min-h-16"
              name="reason"
              data-testid="nd-reason"
              [(ngModel)]="reasonText"
            ></textarea>
          </app-field>
        }
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="nd-ok"
          [disabled]="act.busy()"
          (click)="submit()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class NoteDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Note | null>(null);
  protected readonly opts = signal<NoteOptions | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly target = signal<Refund | null>(null);
  protected readonly act = new Action();
  protected readonly notice = SIMULATION_NOTICE;
  protected readonly money = money;
  protected readonly when = formatDateTime;
  protected readonly rate = ratePct;
  protected readonly tone = noteTone;
  protected readonly status = (s: string) => NOTE_STATUS[s] ?? s;
  protected readonly kind = (s: string) => NOTE_KIND[s] ?? s;
  protected readonly reason = (s: string) => NOTE_REASON[s] ?? s;
  protected readonly refundStatus = (s: string) => REFUND_STATUS[s] ?? s;
  protected readonly method = (s: string) => METHOD[s] ?? s;
  protected readonly methods = Object.entries(METHOD);
  protected readonly seriesChoices = computed(() => {
    const n = this.x();
    if (!n) return [];
    const kind = n.kind === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
    return (this.opts()?.series ?? []).filter(
      (s) =>
        s.legalEntityId === n.legalEntity.id &&
        s.documentKind === kind &&
        s.fiscalYear === Number(n.noteDate.slice(0, 4)),
    );
  });
  protected readonly banks = computed(() =>
    (this.opts()?.bankAccounts ?? []).filter((b) => b.legalEntityId === this.x()?.legalEntity.id),
  );
  protected readonly columns: Column<Note['lines'][number]>[] = [
    {
      key: 'description',
      label: 'Linha da factura',
      required: true,
      value: (l) => `${l.invoiceLineNo}. ${l.sku} — ${l.description}`,
    },
    {
      key: 'mode',
      label: 'Correcção',
      value: (l) =>
        l.mode === 'QUANTITY' && l.quantity ? `${qty(l.quantity)} ${l.uom}` : 'Por valor',
    },
    {
      key: 'taxes',
      label: 'Impostos',
      hideOnMobile: true,
      value: (l) => l.taxes.map((t) => `${t.code} ${ratePct(t.rate)}`).join(', ') || '—',
    },
    { key: 'net', label: 'Líquido', align: 'end', value: (l) => money(l.netAmount) },
  ];
  protected seriesId = '';
  protected reasonText = '';
  protected apply = { invoiceId: '', amount: '' };
  protected refund = {
    key: '',
    amount: '',
    date: '',
    method: 'TRANSFER',
    bankAccountId: '',
    reference: '',
  };

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
          issue: 'Emitir a nota',
          discard: 'Descartar o rascunho',
          apply: 'Usar o crédito noutra factura',
          refund: 'Registar reembolso',
          'rf-confirm': 'Confirmar o reembolso',
          'rf-reject': 'Recusar o reembolso',
          'rf-cancel': 'Anular o reembolso',
        } as Record<string, string>
      )[this.dialog() ?? ''] ?? ''
    );
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [n, o] = await Promise.all([
        this.api.get<Note>(`sales/notes/${this.id()}`),
        this.api.get<NoteOptions>('sales/notes/options').catch(() => null),
      ]);
      this.opts.set(o);
      this.set(n);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(n: Note) {
    this.x.set(n);
    this.breadcrumbs.setCurrent(n.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/vendas/notas']);
  }
  protected open(d: Dialog) {
    this.act.error.set(null);
    this.reasonText = '';
    this.seriesId = '';
    this.dialog.set(d);
  }
  protected openApply() {
    this.apply = { invoiceId: '', amount: '' };
    this.open('apply');
  }
  protected openRefund() {
    this.refund = {
      key: `ui-${crypto.randomUUID()}`,
      amount: this.x()!.availableCredit,
      date: new Date().toISOString().slice(0, 10),
      method: 'TRANSFER',
      bankAccountId: '',
      reference: '',
    };
    this.open('refund');
  }
  protected openRefundDecision(f: Refund, d: Dialog) {
    this.target.set(f);
    this.open(d);
  }

  protected async submit() {
    const n = this.x()!;
    const d = this.dialog()!;
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    let call: () => Promise<Note>;
    let done: string;
    switch (d) {
      case 'issue':
        call = () =>
          this.api.post<Note>(`sales/notes/${n.id}/issue`, {
            expectedVersion: n.version,
            seriesId: nz(this.seriesId),
          });
        done = 'Nota emitida (simulação).';
        break;
      case 'discard':
        call = () =>
          this.api.post<Note>(`sales/notes/${n.id}/discard`, {
            expectedVersion: n.version,
            reason: this.reasonText,
          });
        done = 'Rascunho descartado.';
        break;
      case 'apply':
        call = () =>
          this.api.post<Note>(`sales/notes/${n.id}/apply-credit`, {
            expectedVersion: n.version,
            invoiceId: this.apply.invoiceId,
            amount: amountOrNull(this.apply.amount) ?? this.apply.amount,
          });
        done = 'Crédito abatido na factura.';
        break;
      case 'refund':
        call = () =>
          this.api.post<Note>(`sales/notes/${n.id}/refunds`, {
            requestKey: this.refund.key,
            amount: amountOrNull(this.refund.amount) ?? this.refund.amount,
            refundDate: this.refund.date,
            method: this.refund.method,
            bankAccountId: nz(this.refund.bankAccountId),
            reference: nz(this.refund.reference),
          });
        done = 'Reembolso registado: falta a confirmação da tesouraria.';
        break;
      default: {
        const f = this.target()!;
        const action = d === 'rf-confirm' ? 'confirm' : d === 'rf-reject' ? 'reject' : 'cancel';
        call = () =>
          this.api.post<Note>(`sales/refunds/${f.id}/${action}`, {
            expectedVersion: f.version,
            ...(action === 'confirm' ? {} : { reason: this.reasonText }),
          });
        done =
          action === 'confirm'
            ? 'Reembolso confirmado.'
            : action === 'reject'
              ? 'Reembolso recusado.'
              : 'Reembolso anulado.';
      }
    }
    const r = await this.act.run(call);
    if (!r) return;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show(done);
  }
}
