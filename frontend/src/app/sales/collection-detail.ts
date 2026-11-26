import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import {
  ACTIVITY_KIND,
  ACTIVITY_OUTCOME,
  BUCKET,
  bucketTone,
  type Promise_,
  PROMISE_STATUS,
  promiseTone,
  type Statement,
} from './collections-model';

type Dialog = 'promise' | 'activity' | 'cancel' | null;
type InvoiceItem = Statement['receivables']['invoices'][number];

/**
 * Cobrança de um cliente: contas a receber por entidade e moeda com antiguidade, facturas em dívida, adiantamentos e
 * crédito de notas, limite e exposição, promessas (não são pagamentos) e contactos.
 */
@Component({
  selector: 'app-collection-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    DataTable,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? x()!.customer.code + ' — ' + x()!.customer.name : 'Cobrança'"
      [subtitle]="
        x()
          ? 'Situação em ' +
            x()!.receivables.asOf +
            ' · prazo ' +
            x()!.customer.paymentTermsDays +
            ' dias'
          : ''
      "
      formId="collection-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as s) {
        <section class="card space-y-3" aria-labelledby="cd-credit-title" data-testid="cd-credit">
          <h2 id="cd-credit-title" class="font-semibold">
            Limite de crédito ({{ s.credit.currency }})
          </h2>
          <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <dt class="text-muted">Limite</dt>
              <dd>{{ s.credit.limit === null ? 'Sem limite' : money(s.credit.limit) }}</dd>
            </div>
            <div>
              <dt class="text-muted">A receber (líquido)</dt>
              <dd>{{ money(s.credit.receivables) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Encomendas por facturar</dt>
              <dd>{{ money(s.credit.openOrders) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Exposição</dt>
              <dd class="font-semibold" data-testid="cd-exposure">
                {{ money(s.credit.exposure) }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Disponível</dt>
              <dd
                [class]="s.credit.exceeded ? 'font-semibold text-danger-text' : ''"
                data-testid="cd-available"
              >
                {{ s.credit.available === null ? '—' : money(s.credit.available) }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Contactos</dt>
              <dd>
                @for (c of s.contacts; track $index) {
                  <span class="block"
                    >{{ c.name }}{{ c.role ? ' (' + c.role + ')' : ''
                    }}{{ c.phone ? ' · ' + c.phone : '' }}{{ c.email ? ' · ' + c.email : '' }}</span
                  >
                } @empty {
                  —
                }
              </dd>
            </div>
          </dl>
          @if (s.credit.missingRates.length) {
            <p class="text-sm text-warning-text">
              Sem câmbio para {{ s.credit.missingRates.join(', ') }}: esses valores não entram na
              exposição.
            </p>
          }
          @if (canManage()) {
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="btn-primary"
                data-testid="cd-new-promise"
                (click)="openPromise()"
              >
                Registar promessa
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-new-activity"
                (click)="openActivity()"
              >
                Registar contacto
              </button>
            </div>
          }
        </section>

        @for (g of s.receivables.summary; track g.legalEntityId + g.currency) {
          <section
            class="card space-y-2"
            [attr.aria-label]="'Resumo ' + le(g.legalEntityId)"
            data-testid="cd-summary"
          >
            <h2 class="font-semibold">{{ le(g.legalEntityId) }} · {{ g.currency }}</h2>
            <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <dt class="text-muted">Em dívida</dt>
                <dd class="font-semibold" data-testid="cd-open">{{ money(g.open, g.currency) }}</dd>
              </div>
              <div>
                <dt class="text-muted">Vencido</dt>
                <dd class="text-danger-text" data-testid="cd-overdue">
                  {{ money(g.overdue, g.currency) }}
                </dd>
              </div>
              @for (b of buckets; track b[0]) {
                @if (b[0] !== 'CURRENT') {
                  <div>
                    <dt class="text-muted">{{ b[1] }}</dt>
                    <dd>{{ money(g.aging[b[0]], g.currency) }}</dd>
                  </div>
                }
              }
              <div>
                <dt class="text-muted">Adiantamentos por usar</dt>
                <dd>{{ money(g.advances, g.currency) }}</dd>
              </div>
              <div>
                <dt class="text-muted">Crédito de notas</dt>
                <dd>{{ money(g.credits, g.currency) }}</dd>
              </div>
              <div>
                <dt class="text-muted">Líquido</dt>
                <dd class="font-semibold">{{ money(g.net, g.currency) }}</dd>
              </div>
            </dl>
          </section>
        } @empty {
          <p class="card text-sm text-muted">Nada em dívida.</p>
        }

        <section class="card" aria-labelledby="cd-inv-title">
          <h2 id="cd-inv-title" class="mb-2 font-semibold">Facturas em dívida</h2>
          <app-data-table
            label="Facturas em dívida"
            [columns]="columns"
            [rows]="s.receivables.invoices"
            [total]="s.receivables.invoices.length"
            [limit]="1000"
            emptyText="Sem facturas em dívida."
          />
          @if (s.receivables.advances.length || s.receivables.credits.length) {
            <ul class="mt-3 space-y-1 text-sm">
              @for (a of s.receivables.advances; track a.receiptId) {
                <li>
                  Adiantamento
                  <a class="link" [routerLink]="['/vendas/recebimentos', a.receiptId]">{{
                    a.number
                  }}</a>
                  · {{ money(a.remaining, a.currency) }} por usar
                </li>
              }
              @for (c of s.receivables.credits; track c.noteId) {
                <li>
                  Crédito da nota
                  <a class="link" [routerLink]="['/vendas/notas', c.noteId]">{{ c.number }}</a>
                  · {{ money(c.available, c.currency) }} disponível
                </li>
              }
            </ul>
          }
        </section>

        <section class="card space-y-2" aria-labelledby="cd-p-title">
          <h2 id="cd-p-title" class="font-semibold">Promessas de pagamento</h2>
          <p class="text-sm text-muted">
            Uma promessa não é um pagamento: não altera saldos. Fica cumprida quando os recebimentos
            confirmados depois dela chegam ao valor.
          </p>
          <ul class="space-y-2 text-sm" data-testid="cd-promises">
            @for (p of s.promises; track p.id) {
              <li class="flex flex-wrap items-center gap-2">
                <span class="badge" [class]="pTone(p.status)" data-testid="cd-p-status">{{
                  pStatus(p.status)
                }}</span>
                {{ money(p.amount, p.currency) }} até {{ p.promisedDate }} · recebido
                {{ money(p.paidSince, p.currency) }}{{ p.contactName ? ' · ' + p.contactName : ''
                }}{{ p.invoiceIds.length ? ' · ' + invoiceNumbers(p) : '' }}
                @if (p.cancelReason) {
                  · <em>{{ p.cancelReason }}</em>
                }
                @if (p.status === 'OPEN' && canManageLe(p.legalEntityId)) {
                  <button
                    type="button"
                    class="link"
                    data-testid="cd-p-cancel"
                    (click)="openCancel(p)"
                  >
                    Anular
                  </button>
                }
              </li>
            } @empty {
              <li class="text-muted">Sem promessas.</li>
            }
          </ul>
        </section>

        <section class="card space-y-2" aria-labelledby="cd-a-title">
          <h2 id="cd-a-title" class="font-semibold">Contactos de cobrança</h2>
          <ul class="space-y-1 text-sm" data-testid="cd-activities">
            @for (a of s.activities; track a.id) {
              <li>
                <span class="text-muted">{{ when(a.at) }}</span> · {{ kind(a.kind) }} ·
                {{ outcome(a.outcome) }}{{ a.contactName ? ' · ' + a.contactName : '' }} ·
                {{ a.notes }}{{ a.nextActionDate ? ' · próxima acção ' + a.nextActionDate : ''
                }}{{ a.by ? ' · ' + a.by : '' }}
              </li>
            } @empty {
              <li class="text-muted">Sem contactos registados.</li>
            }
          </ul>
        </section>
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @switch (dialog()) {
        @case ('promise') {
          <div class="space-y-3">
            <p class="text-sm text-muted">Não altera saldos nem é um recebimento.</p>
            <app-field label="Entidade" [required]="true" [error]="act.field('legalEntityId')">
              <select
                appControl
                class="input"
                name="ple"
                data-testid="cd-p-le"
                [(ngModel)]="pf.legalEntityId"
              >
                @for (e of managed(); track e.id) {
                  <option [value]="e.id">{{ e.code }}</option>
                }
              </select>
            </app-field>
            <fieldset class="space-y-1 text-sm">
              <legend class="mb-1 font-medium">Facturas (opcional)</legend>
              @for (i of openOf(pf.legalEntityId); track i.id) {
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    [name]="'pi' + i.id"
                    [attr.data-testid]="'cd-p-inv-' + i.number"
                    [(ngModel)]="pf.invoices[i.id]"
                  />
                  {{ i.number }} · vence {{ i.dueDate }} · {{ money(i.open, i.currency) }}
                </label>
              }
            </fieldset>
            <app-field label="Valor prometido" [required]="true" [error]="act.field('amount')">
              <input
                appControl
                class="input w-40"
                inputmode="decimal"
                name="pamt"
                data-testid="cd-p-amount"
                [(ngModel)]="pf.amount"
              />
            </app-field>
            <app-field label="Data prometida" [required]="true" [error]="act.field('promisedDate')">
              <input
                appControl
                class="input"
                type="date"
                name="pdate"
                data-testid="cd-p-date"
                [(ngModel)]="pf.promisedDate"
              />
            </app-field>
            <app-field label="Quem prometeu" [error]="act.field('contactName')">
              <input
                appControl
                class="input"
                name="pcontact"
                data-testid="cd-p-contact"
                [(ngModel)]="pf.contactName"
              />
            </app-field>
            <app-field label="Notas" [error]="act.field('notes')">
              <input appControl class="input" name="pnotes" [(ngModel)]="pf.notes" />
            </app-field>
          </div>
        }
        @case ('activity') {
          <div class="space-y-3">
            <app-field label="Entidade" [required]="true" [error]="act.field('legalEntityId')">
              <select appControl class="input" name="ale" [(ngModel)]="af.legalEntityId">
                @for (e of managed(); track e.id) {
                  <option [value]="e.id">{{ e.code }}</option>
                }
              </select>
            </app-field>
            <app-field label="Tipo" [required]="true" [error]="act.field('kind')">
              <select
                appControl
                class="input"
                name="akind"
                data-testid="cd-a-kind"
                [(ngModel)]="af.kind"
              >
                @for (k of kinds; track k[0]) {
                  <option [value]="k[0]">{{ k[1] }}</option>
                }
              </select>
            </app-field>
            <app-field label="Resultado" [required]="true" [error]="act.field('outcome')">
              <select
                appControl
                class="input"
                name="aout"
                data-testid="cd-a-outcome"
                [(ngModel)]="af.outcome"
              >
                @for (k of outcomes; track k[0]) {
                  <option [value]="k[0]">{{ k[1] }}</option>
                }
              </select>
            </app-field>
            <app-field label="Pessoa contactada" [error]="act.field('contactName')">
              <input appControl class="input" name="acontact" [(ngModel)]="af.contactName" />
            </app-field>
            <app-field label="O que ficou combinado" [required]="true" [error]="act.field('notes')">
              <textarea
                appControl
                class="input min-h-16"
                name="anotes"
                data-testid="cd-a-notes"
                [(ngModel)]="af.notes"
              ></textarea>
            </app-field>
            <app-field label="Próxima acção" [error]="act.field('nextActionDate')">
              <input
                appControl
                class="input"
                type="date"
                name="anext"
                data-testid="cd-a-next"
                [(ngModel)]="af.nextActionDate"
              />
            </app-field>
            <app-field label="Promessa relacionada" [error]="act.field('promiseId')">
              <select appControl class="input" name="aprom" [(ngModel)]="af.promiseId">
                <option value="">—</option>
                @for (p of openPromises(); track p.id) {
                  <option [value]="p.id">
                    {{ money(p.amount, p.currency) }} até {{ p.promisedDate }}
                  </option>
                }
              </select>
            </app-field>
          </div>
        }
        @case ('cancel') {
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <textarea
              appControl
              class="input min-h-16"
              name="reason"
              data-testid="cd-reason"
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
          data-testid="cd-ok"
          [disabled]="act.busy()"
          (click)="submit()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class CollectionDetail {
  readonly customerId = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Statement | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly target = signal<Promise_ | null>(null);
  protected readonly act = new Action();
  protected readonly money = money;
  protected readonly when = formatDateTime;
  protected readonly pTone = promiseTone;
  protected readonly pStatus = (s: string) => PROMISE_STATUS[s] ?? s;
  protected readonly kind = (s: string) => ACTIVITY_KIND[s] ?? s;
  protected readonly outcome = (s: string) => ACTIVITY_OUTCOME[s] ?? s;
  protected readonly buckets = Object.entries(BUCKET) as [
    keyof Statement['receivables']['summary'][number]['aging'],
    string,
  ][];
  protected readonly kinds = Object.entries(ACTIVITY_KIND);
  protected readonly outcomes = Object.entries(ACTIVITY_OUTCOME);
  protected readonly managed = computed(() =>
    (this.x()?.legalEntities ?? []).filter((e) => e.canManage),
  );
  protected readonly canManage = computed(() => this.managed().length > 0);
  protected readonly openPromises = computed(() =>
    (this.x()?.promises ?? []).filter((p) => p.status === 'OPEN'),
  );
  protected readonly columns: Column<InvoiceItem>[] = [
    {
      key: 'number',
      label: 'Factura',
      required: true,
      link: (i) => ['/vendas/facturas', i.id],
      value: (i) => i.number,
    },
    { key: 'entity', label: 'Entidade', hideOnMobile: true, value: (i) => i.legalEntity.code },
    { key: 'dueDate', label: 'Vencimento' },
    {
      key: 'bucket',
      label: 'Antiguidade',
      value: (i) => (i.daysOverdue ? `${BUCKET[i.bucket]} (${i.daysOverdue} d)` : BUCKET[i.bucket]),
    },
    {
      key: 'adjusted',
      label: 'Valor corrigido',
      align: 'end',
      hideOnMobile: true,
      value: (i) => money(i.adjusted, i.currency),
    },
    {
      key: 'paid',
      label: 'Recebido',
      align: 'end',
      hideOnMobile: true,
      value: (i) => money(i.paid, i.currency),
    },
    { key: 'open', label: 'Em dívida', align: 'end', value: (i) => money(i.open, i.currency) },
  ];
  protected pf = {
    legalEntityId: '',
    amount: '',
    promisedDate: '',
    contactName: '',
    notes: '',
    invoices: {} as Record<string, boolean>,
  };
  protected af = {
    legalEntityId: '',
    kind: 'CALL',
    outcome: 'REACHED',
    contactName: '',
    notes: '',
    nextActionDate: '',
    promiseId: '',
  };
  protected reason = '';
  protected readonly tone = bucketTone;

  constructor() {
    effect(() => {
      this.customerId();
      untracked(() => void this.load());
    });
  }

  protected le(id: string) {
    return this.x()?.legalEntities.find((e) => e.id === id)?.code ?? '—';
  }
  protected canManageLe(id: string) {
    return this.managed().some((e) => e.id === id);
  }
  protected openOf(le: string) {
    return (this.x()?.receivables.invoices ?? []).filter((i) => i.legalEntity.id === le);
  }
  protected invoiceNumbers(p: Promise_) {
    const all = this.x()?.receivables.invoices ?? [];
    return p.invoiceIds
      .map((id) => all.find((i) => i.id === id)?.number ?? 'factura paga')
      .join(', ');
  }
  protected dialogTitle() {
    return (
      (
        {
          promise: 'Registar promessa de pagamento',
          activity: 'Registar contacto',
          cancel: 'Anular a promessa',
        } as Record<string, string>
      )[this.dialog() ?? ''] ?? ''
    );
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const s = await this.api.get<Statement>(`sales/collections/${this.customerId()}`);
      this.x.set(s);
      this.breadcrumbs.setCurrent(s.customer.code);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  protected back() {
    void this.router.navigate(['/vendas/cobrancas']);
  }
  private open(d: Dialog) {
    this.act.error.set(null);
    this.dialog.set(d);
  }
  protected openPromise() {
    const le = this.managed()[0]?.id ?? '';
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    this.pf = {
      legalEntityId: le,
      amount: '',
      promisedDate: d.toISOString().slice(0, 10),
      contactName: '',
      notes: '',
      invoices: {},
    };
    this.open('promise');
  }
  protected openActivity() {
    this.af = {
      legalEntityId: this.managed()[0]?.id ?? '',
      kind: 'CALL',
      outcome: 'REACHED',
      contactName: '',
      notes: '',
      nextActionDate: '',
      promiseId: '',
    };
    this.open('activity');
  }
  protected openCancel(p: Promise_) {
    this.target.set(p);
    this.reason = '';
    this.open('cancel');
  }

  protected async submit() {
    const id = this.customerId();
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    const d = this.dialog();
    let done: string;
    let call: () => Promise<unknown>;
    if (d === 'promise') {
      call = () =>
        this.api.post(`sales/collections/${id}/promises`, {
          legalEntityId: this.pf.legalEntityId,
          amount: this.pf.amount.trim().replace(',', '.'),
          promisedDate: this.pf.promisedDate,
          invoiceIds: Object.entries(this.pf.invoices)
            .filter(([, on]) => on)
            .map(([k]) => k),
          contactName: nz(this.pf.contactName),
          notes: nz(this.pf.notes),
        });
      done = 'Promessa registada (não é um pagamento).';
    } else if (d === 'activity') {
      call = () =>
        this.api.post(`sales/collections/${id}/activities`, {
          ...this.af,
          contactName: nz(this.af.contactName),
          nextActionDate: nz(this.af.nextActionDate),
          promiseId: nz(this.af.promiseId),
        });
      done = 'Contacto registado.';
    } else {
      const p = this.target()!;
      call = () =>
        this.api.post(`sales/collection-promises/${p.id}/cancel`, {
          expectedVersion: p.version,
          reason: this.reason,
        });
      done = 'Promessa anulada.';
    }
    const r = await this.act.run(call);
    if (!r) return;
    this.dialog.set(null);
    this.toasts.show(done);
    await this.load();
  }
}
