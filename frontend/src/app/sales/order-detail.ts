import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { price, qty } from './pricing-model';
import {
  APPROVAL_REASON,
  APPROVAL_STATUS,
  DELIVERY_STATUS,
  INVOICING_STATUS,
  type Order,
  ORDER_EVENT,
  ORDER_STATUS,
  type OrderLine,
  type OrderOptions,
  orderTone,
  RESERVATION_STATUS,
  subTone,
} from './order-model';

type Dialog = 'submit' | 'reject' | 'deliver' | 'close' | 'cancel' | null;

/**
 * Encomenda: estados separados (ciclo, aprovação, reserva, entrega, facturação), quantidades por linha, verificação do
 * limite de crédito, aprovação por outra pessoa, reserva/libertação e expedição pelo inventário, fecho do resto,
 * anulação, expedições, anexos, cronologia e auditoria.
 */
@Component({
  selector: 'app-order-detail',
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
      [title]="x() ? (x()!.number ?? 'Encomenda em rascunho') : 'Encomenda'"
      [subtitle]="
        x() ? x()!.customer.code + ' — ' + x()!.customer.name + ' · ' + x()!.legalEntity.code : ''
      "
      formId="order-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as o) {
        <section class="card space-y-3" aria-label="Estados" data-testid="od-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(o.status)" data-testid="od-status">{{
              label.status[o.status]
            }}</span>
            <span class="badge" [class]="sub(o.approvalStatus)" data-testid="od-approval">{{
              label.approval[o.approvalStatus]
            }}</span>
            <span class="badge" [class]="sub(o.reservationStatus)" data-testid="od-reservation">{{
              label.reservation[o.reservationStatus]
            }}</span>
            <span class="badge" [class]="sub(o.deliveryStatus)" data-testid="od-delivery">{{
              label.delivery[o.deliveryStatus]
            }}</span>
            <span class="badge" [class]="sub(o.invoicingStatus)">{{
              label.invoicing[o.invoicingStatus]
            }}</span>
          </div>
          @if (o.approvalReasons.length && o.approvalStatus !== 'NOT_REQUIRED') {
            <p class="text-sm" data-testid="od-reasons">
              Motivos de aprovação: {{ reasons(o.approvalReasons) }}
            </p>
          }
          @if (o.creditCheck; as c) {
            <p class="text-sm text-muted" data-testid="od-credit">
              Crédito: limite {{ c.limit === null ? 'sem limite' : money(c.limit, c.currency) }} ·
              em aberto {{ money(c.openOrders, c.currency) }} · esta
              {{ money(c.thisOrder, c.currency) }} · exposição
              {{ money(c.exposure, c.currency) }}
            </p>
          }
          <dl class="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">Data · entrega pedida</dt>
              <dd>{{ o.orderDate }} · {{ o.requestedDate ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Armazém</dt>
              <dd>{{ o.warehouse ? o.warehouse.code + ' — ' + o.warehouse.name : '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Entrega</dt>
              <dd>
                {{
                  o.deliveryAddress
                    ? o.deliveryAddress.label + ' · ' + o.deliveryAddress.line
                    : 'A combinar'
                }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Total</dt>
              <dd class="font-semibold" data-testid="od-total">
                {{ money(o.grossTotal, o.currency) }}
              </dd>
            </div>
          </dl>
          @if (o.quote) {
            <p class="text-sm">
              Do orçamento
              <a class="link" [routerLink]="['/vendas/orcamentos', o.quote.id]"
                >{{ o.quote.number }} v{{ o.quote.versionNo }}</a
              >
            </p>
          }
          @if (o.closedReason) {
            <p class="text-sm text-muted">{{ o.closedReason }}</p>
          }
          @if (o.approvalStatus === 'PENDING' && !o.can.approve && o.can.reject) {
            <p class="text-sm text-muted">Foi submetida por si: outra pessoa tem de aprovar.</p>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (o.can.edit) {
              <a
                class="btn-secondary"
                data-testid="od-edit"
                [routerLink]="['/vendas/encomendas', o.id, 'editar']"
                >Editar</a
              >
            }
            @if (o.can.submit) {
              <button
                type="button"
                class="btn-primary"
                data-testid="od-submit"
                (click)="openSubmit()"
              >
                Submeter
              </button>
            }
            @if (o.can.approve) {
              <button
                type="button"
                class="btn-primary"
                data-testid="od-approve"
                (click)="approve()"
              >
                Aprovar
              </button>
            }
            @if (o.can.reject) {
              <button type="button" class="btn-secondary" (click)="open('reject')">Devolver</button>
            }
            @if (o.can.reserve) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-reserve"
                (click)="reserve()"
              >
                Reservar
              </button>
            }
            @if (o.can.release) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-release"
                (click)="release()"
              >
                Libertar reservas
              </button>
            }
            @if (o.can.deliver) {
              <button
                type="button"
                class="btn-primary"
                data-testid="od-deliver"
                (click)="openDeliver(o)"
              >
                Expedir
              </button>
            }
            @if (o.can.close) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-close"
                (click)="open('close')"
              >
                Fechar o resto
              </button>
            }
            @if (o.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-cancel"
                (click)="open('cancel')"
              >
                Anular
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="od-lines-title">
          <h2 id="od-lines-title" class="mb-2 font-semibold">Linhas</h2>
          <app-data-table
            label="Linhas da encomenda"
            [columns]="columns"
            [rows]="o.lines"
            [total]="o.lines.length"
            [limit]="1000"
            emptyText="Sem linhas."
          />
          <dl class="mt-3 ml-auto grid max-w-xs grid-cols-2 gap-1 text-sm">
            <dt class="text-muted">Líquido</dt>
            <dd class="text-right">{{ money(o.netTotal, o.currency) }}</dd>
            <dt class="text-muted">Imposto</dt>
            <dd class="text-right">{{ money(o.taxTotal, o.currency) }}</dd>
            <dt class="font-semibold">Total</dt>
            <dd class="text-right font-semibold">{{ money(o.grossTotal, o.currency) }}</dd>
          </dl>
        </section>

        @if (o.deliveries.length) {
          <section class="card" aria-labelledby="od-d-title">
            <h2 id="od-d-title" class="mb-2 font-semibold">Expedições</h2>
            <ul class="space-y-1 text-sm" data-testid="od-deliveries">
              @for (d of o.deliveries; track d.id) {
                <li>
                  <strong>{{ d.reference }}</strong> · {{ d.deliveryDate
                  }}{{ d.by ? ' · ' + d.by : '' }} ·
                  @for (l of d.lines; track l.lineNo; let last = $last) {
                    linha {{ l.lineNo }}: {{ qty(l.quantity) }}{{ last ? '' : ', ' }}
                  }
                  @if (d.stockEventId) {
                    · saída de stock registada
                  }
                </li>
              }
            </ul>
          </section>
        }

        <app-attachments
          subjectType="sales_order"
          [subjectId]="o.id"
          [canWrite]="o.can.edit || o.can.deliver"
        />

        <section class="card" aria-labelledby="od-h-title">
          <h2 id="od-h-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="od-history">
            @for (h of o.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ event(h.kind) }}
                @if (h.by) {
                  · {{ h.by }}
                }
                @if (h.reason) {
                  · <em>{{ h.reason }}</em>
                }
              </li>
            }
          </ul>
        </section>

        <app-audit-history entityType="sales_order" [entityId]="o.id" [refreshKey]="o.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <div class="space-y-3">
        @switch (dialog()) {
          @case ('submit') {
            <p class="text-sm">
              Os preços e o limite de crédito são verificados; sem excepções, a encomenda fica
              confirmada e numerada.
            </p>
            @if (seriesChoices().length > 1) {
              <app-field label="Série" [required]="true" [error]="act.field('seriesId')">
                <select
                  appControl
                  class="input"
                  name="series"
                  data-testid="od-series"
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
          @case ('deliver') {
            <app-field
              label="Data da expedição"
              [required]="true"
              [error]="act.field('deliveryDate')"
            >
              <input appControl class="input" type="date" name="dd" [(ngModel)]="delivery.date" />
            </app-field>
            @for (l of delivery.lines; track l.lineId; let i = $index) {
              <app-field
                [label]="'Linha ' + l.lineNo + ' · ' + l.label + ' (falta ' + l.open + ')'"
                [error]="act.field('lines.' + i + '.quantity')"
              >
                <input
                  appControl
                  class="input w-36"
                  inputmode="decimal"
                  [name]="'q' + i"
                  data-testid="od-d-qty"
                  [(ngModel)]="l.quantity"
                />
              </app-field>
            }
            <app-field label="Notas" [error]="act.field('notes')">
              <input appControl class="input" name="dnotes" [(ngModel)]="delivery.notes" />
            </app-field>
          }
          @default {
            <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
              <textarea
                appControl
                class="input min-h-16"
                name="reason"
                data-testid="od-reason"
                [(ngModel)]="reason"
              ></textarea>
            </app-field>
          }
        }
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="od-ok"
          [disabled]="act.busy()"
          (click)="confirmDialog()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class OrderDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Order | null>(null);
  protected readonly opts = signal<OrderOptions | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly act = new Action();
  protected readonly money = money;
  protected readonly qty = qty;
  protected readonly when = formatDateTime;
  protected readonly tone = orderTone;
  protected readonly sub = subTone;
  protected readonly label = {
    status: ORDER_STATUS as Record<string, string>,
    approval: APPROVAL_STATUS,
    reservation: RESERVATION_STATUS,
    delivery: DELIVERY_STATUS,
    invoicing: INVOICING_STATUS,
  };
  protected readonly event = (k: string) => ORDER_EVENT[k] ?? k;
  protected readonly reasons = (r: string[]) => r.map((x) => APPROVAL_REASON[x] ?? x).join('; ');
  protected readonly seriesChoices = computed(() =>
    (this.opts()?.series ?? []).filter((s) => s.legalEntityId === this.x()?.legalEntity.id),
  );
  protected reason = '';
  protected seriesId = '';
  protected delivery = {
    key: '',
    date: '',
    notes: '',
    lines: [] as {
      lineId: string;
      lineNo: number;
      label: string;
      open: string;
      quantity: string;
    }[],
  };
  protected readonly columns: Column<OrderLine>[] = [
    {
      key: 'description',
      label: 'Descrição',
      required: true,
      value: (l) => `${l.product.sku} — ${l.description}${l.isStock ? '' : ' (serviço)'}`,
    },
    { key: 'quantity', label: 'Encomendada', align: 'end', value: (l) => qty(l.quantity) },
    {
      key: 'reserved',
      label: 'Reservada',
      align: 'end',
      hideOnMobile: true,
      value: (l) => (l.isStock ? qty(l.reservedQty) : '—'),
    },
    { key: 'delivered', label: 'Entregue', align: 'end', value: (l) => qty(l.deliveredQty) },
    {
      key: 'invoiced',
      label: 'Facturada',
      align: 'end',
      hideOnMobile: true,
      value: (l) => qty(l.invoicedQty),
    },
    { key: 'open', label: 'Falta', align: 'end', value: (l) => qty(l.openQty) },
    {
      key: 'net',
      label: 'Preço líquido',
      align: 'end',
      hideOnMobile: true,
      value: (l) => price(l.netUnitPrice),
    },
    { key: 'gross', label: 'Total', align: 'end', value: (l) => money(l.grossAmount) },
  ];

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
          submit: 'Submeter a encomenda',
          reject: 'Devolver a encomenda',
          deliver: 'Expedir',
          close: 'Fechar o resto da encomenda',
          cancel: 'Anular a encomenda',
        } as Record<string, string>
      )[this.dialog() ?? ''] ?? ''
    );
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [o, opts] = await Promise.all([
        this.api.get<Order>(`sales/orders/${this.id()}`),
        this.api.get<OrderOptions>('sales/orders/options').catch(() => null),
      ]);
      this.opts.set(opts);
      this.set(o);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(o: Order) {
    this.x.set(o);
    this.breadcrumbs.setCurrent(o.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/vendas/encomendas']);
  }

  protected open(d: Dialog) {
    this.act.error.set(null);
    this.reason = '';
    this.dialog.set(d);
  }
  protected openSubmit() {
    this.seriesId = '';
    this.open('submit');
  }
  protected openDeliver(o: Order) {
    this.delivery = {
      key: `ui-${crypto.randomUUID()}`,
      date: new Date().toISOString().slice(0, 10),
      notes: '',
      lines: o.lines
        .filter((l) => l.openQty !== '0.000000')
        .map((l) => ({
          lineId: l.id,
          lineNo: l.lineNo,
          label: `${l.product.sku}${l.isStock ? '' : ' (serviço)'}`,
          open: qty(l.openQty),
          quantity: qty(l.openQty).replace(',', '.'),
        })),
    };
    this.open('deliver');
  }

  private async post(action: string, body: Record<string, unknown>, done: string) {
    const o = this.x()!;
    const r = await this.act.run(() =>
      this.api.post<Order>(`sales/orders/${o.id}/${action}`, {
        expectedVersion: o.version,
        ...body,
      }),
    );
    if (!r) return;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show(done);
  }

  protected async approve() {
    const ok = await this.confirm.ask({
      title: 'Aprovar a encomenda',
      message: `Aprova as excepções (${this.reasons(this.x()!.approvalReasons)}) e confirma a encomenda.`,
      confirmLabel: 'Aprovar',
    });
    if (ok) await this.post('approve', {}, 'Encomenda aprovada e confirmada.');
  }
  protected reserve() {
    void this.post('reserve', {}, 'Reserva registada no inventário.');
  }
  protected async release() {
    const ok = await this.confirm.ask({
      title: 'Libertar reservas',
      message: 'O stock reservado para esta encomenda volta a ficar livre.',
      confirmLabel: 'Libertar',
    });
    if (ok) await this.post('release', {}, 'Reservas libertadas.');
  }

  protected async confirmDialog() {
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    switch (this.dialog()) {
      case 'submit':
        return this.post('submit', { seriesId: nz(this.seriesId) }, 'Encomenda submetida.');
      case 'deliver':
        return this.post(
          'deliver',
          {
            requestKey: this.delivery.key,
            deliveryDate: this.delivery.date,
            notes: nz(this.delivery.notes),
            lines: this.delivery.lines
              .filter((l) => nz(l.quantity) && !/^0+([.,]0*)?$/.test(l.quantity.trim()))
              .map((l) => ({ lineId: l.lineId, quantity: l.quantity.trim().replace(',', '.') })),
          },
          'Expedição registada.',
        );
      case 'reject':
        return this.post('reject', { reason: this.reason }, 'Encomenda devolvida.');
      case 'close':
        return this.post('close', { reason: this.reason }, 'Encomenda fechada.');
      case 'cancel':
        return this.post('cancel', { reason: this.reason }, 'Encomenda anulada.');
    }
  }
}
