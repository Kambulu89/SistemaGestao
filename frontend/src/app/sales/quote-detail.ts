import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Workspace } from '../core/workspace';
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
import { percent, price, qty, REASON } from './pricing-model';
import {
  type Quote,
  QUOTE_EVENT,
  type QuoteLine,
  type QuoteOptions,
  quoteStatusLabel,
  quoteTone,
  SEND_CHANNEL,
} from './quote-model';

type Dialog = 'reject' | 'send' | 'accept' | 'decline' | 'revise' | 'cancel' | 'convert' | null;

/**
 * Orçamento: linhas com a origem do preço (tabela, regra, desconto e limite), totais, aprovação dos descontos acima do
 * limite (outra pessoa), envio numerado com a versão fotografada, decisão do cliente sobre a versão enviada, revisões,
 * anulação, anexos, cronologia e auditoria.
 */
@Component({
  selector: 'app-quote-detail',
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
      [title]="
        x() ? (x()!.number ?? 'Orçamento em rascunho') + ' · versão ' + x()!.versionNo : 'Orçamento'
      "
      [subtitle]="
        x() ? x()!.customer.code + ' — ' + x()!.customer.name + ' · ' + x()!.legalEntity.code : ''
      "
      formId="quote-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as q) {
        <section class="card space-y-3" aria-label="Estado" data-testid="qd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(q)" data-testid="qd-status">{{ label(q) }}</span>
            @if (q.requiresApproval && q.status === 'PENDING_APPROVAL') {
              <span class="text-sm text-muted">Descontos acima do limite ou preço manual.</span>
            }
            @if (q.decisionReason) {
              <span class="text-sm text-muted">{{ q.decisionReason }}</span>
            }
          </div>
          <dl class="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">Data · validade</dt>
              <dd>{{ q.quoteDate }} · {{ q.validUntil }}</dd>
            </div>
            <div>
              <dt class="text-muted">Comercial</dt>
              <dd>{{ q.salesperson.name }}</dd>
            </div>
            <div>
              <dt class="text-muted">Pagamento</dt>
              <dd>{{ q.paymentTermsDays }} dias · {{ q.currency }}</dd>
            </div>
            <div>
              <dt class="text-muted">Total</dt>
              <dd class="font-semibold" data-testid="qd-total">
                {{ money(q.grossTotal, q.currency) }}
              </dd>
            </div>
          </dl>
          @if (q.decidedByName) {
            <p class="text-sm">
              Decisão do cliente: {{ q.decidedByName }} · {{ when(q.decidedAt) }}
            </p>
          }
          @if (q.status === 'PENDING_APPROVAL' && !q.can.approve && q.can.reject) {
            <p class="text-sm text-muted">Foi submetido por si: outra pessoa tem de aprovar.</p>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (q.can.edit) {
              <a
                class="btn-secondary"
                data-testid="qd-edit"
                [routerLink]="['/vendas/orcamentos', q.id, 'editar']"
                >Editar</a
              >
            }
            @if (q.can.submit) {
              <button type="button" class="btn-primary" data-testid="qd-submit" (click)="submit()">
                Submeter
              </button>
            }
            @if (q.can.approve) {
              <button
                type="button"
                class="btn-primary"
                data-testid="qd-approve"
                (click)="approve()"
              >
                Aprovar
              </button>
            }
            @if (q.can.reject) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="qd-reject"
                (click)="open('reject')"
              >
                Devolver
              </button>
            }
            @if (q.can.send && !q.expired) {
              <button
                type="button"
                class="btn-primary"
                data-testid="qd-send"
                (click)="open('send')"
              >
                {{ q.status === 'SENT' ? 'Reenviar' : 'Enviar ao cliente' }}
              </button>
            }
            @if (q.can.accept && !q.expired) {
              <button
                type="button"
                class="btn-primary"
                data-testid="qd-accept"
                (click)="open('accept')"
              >
                Registar aceitação
              </button>
            }
            @if (q.can.decline) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="qd-decline"
                (click)="open('decline')"
              >
                Registar recusa
              </button>
            }
            @if (q.can.revise) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="qd-revise"
                (click)="open('revise')"
              >
                Rever (nova versão)
              </button>
            }
            @if (q.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="qd-cancel"
                (click)="open('cancel')"
              >
                Anular
              </button>
            }
            @if (q.status === 'ACCEPTED' && canConvert()) {
              <button
                type="button"
                class="btn-primary"
                data-testid="qd-convert"
                (click)="openConvert()"
              >
                Converter em encomenda
              </button>
            }
            @if (q.convertedOrderId) {
              <a
                class="link self-center"
                data-testid="qd-order"
                [routerLink]="['/vendas/encomendas', q.convertedOrderId]"
                >Ver a encomenda</a
              >
            }
          </div>
        </section>

        <section class="card" aria-labelledby="qd-lines-title">
          <h2 id="qd-lines-title" class="mb-2 font-semibold">Linhas</h2>
          <app-data-table
            label="Linhas do orçamento"
            [columns]="columns"
            [rows]="q.lines"
            [total]="q.lines.length"
            [limit]="1000"
            emptyText="Sem linhas."
          />
          <dl class="mt-3 ml-auto grid max-w-xs grid-cols-2 gap-1 text-sm" data-testid="qd-totals">
            <dt class="text-muted">Líquido</dt>
            <dd class="text-right">{{ money(q.netTotal, q.currency) }}</dd>
            <dt class="text-muted">Imposto</dt>
            <dd class="text-right">{{ money(q.taxTotal, q.currency) }}</dd>
            <dt class="font-semibold">Total</dt>
            <dd class="text-right font-semibold">{{ money(q.grossTotal, q.currency) }}</dd>
          </dl>
          @if (q.notes) {
            <p class="mt-3 whitespace-pre-line text-sm">{{ q.notes }}</p>
          }
        </section>

        @if (q.versions.length) {
          <section class="card" aria-labelledby="qd-v-title">
            <h2 id="qd-v-title" class="mb-1 font-semibold">Versões enviadas</h2>
            <p class="mb-2 text-xs text-muted">
              O que o cliente recebeu fica fotografado e não muda; a aceitação refere-se a uma
              versão.
            </p>
            <ol class="space-y-1 text-sm" data-testid="qd-versions">
              @for (v of q.versions; track v.versionNo) {
                <li>
                  <strong>Versão {{ v.versionNo }}</strong> · {{ when(v.at) }} ·
                  {{ channel(v.channel) }}{{ v.sentTo ? ' · ' + v.sentTo : '' }} · dados do cliente
                  v{{ v.customerVersionNo }}
                  <span class="block break-all text-xs text-muted">{{ v.hash }}</span>
                </li>
              }
            </ol>
          </section>
        }

        <app-attachments
          subjectType="sales_quote"
          [subjectId]="q.id"
          [canWrite]="q.can.edit || q.can.send"
        />

        <section class="card" aria-labelledby="qd-h-title">
          <h2 id="qd-h-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="qd-history">
            @for (h of q.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · v{{ h.versionNo }} ·
                {{ event(h.kind) }}
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

        <app-audit-history entityType="sales_quote" [entityId]="q.id" [refreshKey]="q.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <div class="space-y-3">
        @switch (dialog()) {
          @case ('send') {
            @if (!x()?.number && seriesChoices().length > 1) {
              <app-field label="Série" [required]="true" [error]="act.field('seriesId')">
                <select
                  appControl
                  class="input"
                  name="series"
                  data-testid="qd-series"
                  [(ngModel)]="send.seriesId"
                >
                  <option value="">—</option>
                  @for (s of seriesChoices(); track s.id) {
                    <option [value]="s.id">{{ s.code }} ({{ s.prefix }})</option>
                  }
                </select>
              </app-field>
            }
            <app-field label="Canal" [required]="true" [error]="act.field('channel')">
              <select
                appControl
                class="input"
                name="channel"
                data-testid="qd-channel"
                [(ngModel)]="send.channel"
              >
                @for (c of channels; track c[0]) {
                  <option [value]="c[0]">{{ c[1] }}</option>
                }
              </select>
            </app-field>
            <app-field
              label="Destinatário"
              [required]="send.channel === 'EMAIL'"
              hint="O envio fica registado; o envio automático por e-mail com o PDF ainda não existe."
              [error]="act.field('sentTo')"
            >
              <input
                appControl
                class="input"
                name="sentTo"
                data-testid="qd-sent-to"
                [(ngModel)]="send.sentTo"
              />
            </app-field>
          }
          @case ('convert') {
            <p class="text-sm">
              A encomenda fica em rascunho com as linhas e os preços aceites pelo cliente; o
              orçamento passa a convertido (uma única vez).
            </p>
            <app-field
              label="Armazém"
              hint="De onde sai a mercadoria (pode escolher depois)."
              [error]="act.field('warehouseId')"
            >
              <select
                appControl
                class="input"
                name="cwh"
                data-testid="qd-c-warehouse"
                [(ngModel)]="convertWarehouse"
              >
                <option value="">—</option>
                @for (w of warehouses(); track w.id) {
                  <option [value]="w.id">{{ w.code }} — {{ w.name }}</option>
                }
              </select>
            </app-field>
          }
          @case ('accept') {
            <p class="text-sm">Aceitação da versão {{ x()?.versionNo }} enviada.</p>
            <app-field
              label="Quem aceitou (cliente)"
              [required]="true"
              [error]="act.field('decidedByName')"
            >
              <input
                appControl
                class="input"
                name="by"
                data-testid="qd-by"
                [(ngModel)]="decision.name"
              />
            </app-field>
            <app-field
              label="Referência do cliente (ex.: nota de encomenda)"
              [error]="act.field('customerReference')"
            >
              <input appControl class="input" name="cref" [(ngModel)]="decision.ref" />
            </app-field>
          }
          @case ('decline') {
            <app-field
              label="Quem recusou (cliente)"
              [required]="true"
              [error]="act.field('decidedByName')"
            >
              <input
                appControl
                class="input"
                name="by"
                data-testid="qd-by"
                [(ngModel)]="decision.name"
              />
            </app-field>
            <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
              <textarea
                appControl
                class="input min-h-16"
                name="reason"
                data-testid="qd-reason"
                [(ngModel)]="reason"
              ></textarea>
            </app-field>
          }
          @default {
            <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
              <textarea
                appControl
                class="input min-h-16"
                name="reason"
                data-testid="qd-reason"
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
          data-testid="qd-ok"
          [disabled]="act.busy()"
          (click)="confirmDialog()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class QuoteDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly canConvert = computed(() => this.workspace.canAny('sales.orders.manage'));
  protected readonly warehouses = signal<{ id: string; code: string; name: string }[]>([]);
  protected convertWarehouse = '';
  protected readonly x = signal<Quote | null>(null);
  protected readonly opts = signal<QuoteOptions | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly act = new Action();
  protected readonly money = money;
  protected readonly when = formatDateTime;
  protected readonly tone = quoteTone;
  protected readonly label = quoteStatusLabel;
  protected readonly channels = Object.entries(SEND_CHANNEL);
  protected readonly channel = (c: string) => SEND_CHANNEL[c] ?? c;
  protected readonly event = (k: string) => QUOTE_EVENT[k] ?? k;
  protected readonly seriesChoices = computed(() =>
    (this.opts()?.series ?? []).filter((s) => s.legalEntityId === this.x()?.legalEntity.id),
  );
  protected reason = '';
  protected send = { seriesId: '', channel: 'EMAIL', sentTo: '' };
  protected decision = { name: '', ref: '' };
  protected readonly columns: Column<QuoteLine>[] = [
    {
      key: 'description',
      label: 'Descrição',
      required: true,
      value: (l) => `${l.product.sku} — ${l.description}`,
    },
    { key: 'quantity', label: 'Qtd.', align: 'end', value: (l) => qty(l.quantity) },
    {
      key: 'source',
      label: 'Origem do preço',
      hideOnMobile: true,
      value: (l) => this.origin(l),
    },
    { key: 'net', label: 'Preço líquido', align: 'end', value: (l) => price(l.netUnitPrice) },
    {
      key: 'tax',
      label: 'Imposto',
      align: 'end',
      hideOnMobile: true,
      value: (l) =>
        `${percent(l.taxRate)}${l.taxExemptionReason ? ' (isento)' : ''} · ${money(l.taxAmount)}`,
    },
    { key: 'gross', label: 'Total', align: 'end', value: (l) => money(l.grossAmount) },
    {
      key: 'approval',
      label: 'Aprovação',
      hideOnMobile: true,
      value: (l) =>
        l.pricing.reasons?.length ? l.pricing.reasons.map((r) => REASON[r] ?? r).join('; ') : '—',
    },
  ];

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private origin(l: QuoteLine) {
    const src = { LIST: 'Tabela', CATALOG: 'Catálogo', MANUAL: 'Manual', NONE: 'Sem preço' }[
      l.priceSource
    ];
    const parts = [
      `${src}${l.pricing.priceListCode ? ' ' + l.pricing.priceListCode : ''} ${price(l.basePrice)}`,
    ];
    if (l.pricing.ruleCode) parts.push(`regra ${l.pricing.ruleCode} ${percent(l.pricing.rulePct)}`);
    if (l.pricing.manualDiscountPct && l.pricing.manualDiscountPct !== '0.00')
      parts.push(
        `desconto ${percent(l.pricing.manualDiscountPct)} (limite ${percent(l.pricing.limitPct)})`,
      );
    return parts.join(' · ');
  }

  protected dialogTitle() {
    return (
      (
        {
          reject: 'Devolver para correcção',
          convert: 'Converter em encomenda',
          send: 'Enviar ao cliente',
          accept: 'Aceitação do cliente',
          decline: 'Recusa do cliente',
          revise: 'Rever o orçamento',
          cancel: 'Anular o orçamento',
        } as Record<string, string>
      )[this.dialog() ?? ''] ?? ''
    );
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [q, o] = await Promise.all([
        this.api.get<Quote>(`sales/quotes/${this.id()}`),
        this.api.get<QuoteOptions>('sales/quotes/options').catch(() => null),
      ]);
      this.opts.set(o);
      this.set(q);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(q: Quote) {
    this.x.set(q);
    this.breadcrumbs.setCurrent(q.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/vendas/orcamentos']);
  }

  protected open(d: Dialog) {
    this.act.error.set(null);
    this.reason = '';
    this.decision = { name: '', ref: '' };
    this.send = { seriesId: '', channel: 'EMAIL', sentTo: '' };
    this.dialog.set(d);
  }

  private async post(action: string, body: Record<string, unknown>, done: string) {
    const q = this.x()!;
    const r = await this.act.run(() =>
      this.api.post<Quote>(`sales/quotes/${q.id}/${action}`, {
        expectedVersion: q.version,
        ...body,
      }),
    );
    if (!r) return;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show(done);
  }

  protected submit() {
    void this.post('submit', {}, 'Orçamento submetido.');
  }
  protected async approve() {
    const ok = await this.confirm.ask({
      title: 'Aprovar o orçamento',
      message: 'Aprova os descontos acima do limite e os preços manuais deste orçamento.',
      confirmLabel: 'Aprovar',
    });
    if (ok) await this.post('approve', {}, 'Orçamento aprovado.');
  }

  protected async confirmDialog() {
    const q = this.x()!;
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    switch (this.dialog()) {
      case 'send':
        return this.post(
          'send',
          {
            channel: this.send.channel,
            sentTo: nz(this.send.sentTo),
            seriesId: nz(this.send.seriesId),
          },
          'Envio registado.',
        );
      case 'accept':
        return this.post(
          'accept',
          {
            versionNo: q.versionNo,
            decidedByName: this.decision.name,
            customerReference: nz(this.decision.ref),
          },
          'Aceitação registada.',
        );
      case 'decline':
        return this.post(
          'decline',
          { versionNo: q.versionNo, decidedByName: this.decision.name, reason: this.reason },
          'Recusa registada.',
        );
      case 'reject':
        return this.post('reject', { reason: this.reason }, 'Orçamento devolvido.');
      case 'revise':
        return this.post('revise', { reason: this.reason }, 'Nova versão em rascunho.');
      case 'cancel':
        return this.post('cancel', { reason: this.reason }, 'Orçamento anulado.');
      case 'convert': {
        const r = await this.act.run(() =>
          this.api.post<{ id: string }>('sales/orders/from-quote', {
            quoteId: q.id,
            warehouseId: nz(this.convertWarehouse),
          }),
        );
        if (!r) return;
        this.dialog.set(null);
        this.toasts.show('Encomenda criada a partir do orçamento.');
        await this.router.navigate(['/vendas/encomendas', r.id]);
        return;
      }
    }
  }

  protected async openConvert() {
    this.convertWarehouse = '';
    this.open('convert');
    const o = await this.api
      .get<{ warehouses: { id: string; code: string; name: string; legalEntityId: string }[] }>(
        'sales/orders/options',
      )
      .catch(() => null);
    this.warehouses.set(
      (o?.warehouses ?? []).filter((w) => w.legalEntityId === this.x()?.legalEntity.id),
    );
  }
}
