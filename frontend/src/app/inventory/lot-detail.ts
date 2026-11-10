import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  daysToExpiry,
  LOT_EVENT,
  type LotDetail,
  lotActions,
  lotStatusLabel,
  lotTone,
  sourceLink,
} from './lot-model';
import { BUCKET, POSTING_TYPE, qty, signedQty, sourceLabel } from './stock-model';

type ModalKind = 'block' | 'unblock' | 'recall';

/**
 * Lote (8.8): rastreabilidade ponta a ponta — de onde veio (entradas), onde está (saldos por armazém e estado), para
 * onde foi (saídas por origem: a lista de uma recolha) e as séries —; bloqueio, desbloqueio e recolha com motivo.
 */
@Component({
  selector: 'app-lot-detail',
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
      [title]="title()"
      [subtitle]="subtitle()"
      formId="lot-detail"
      [loading]="!lot()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (lot(); as x) {
        <div class="card space-y-3" data-testid="lot-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(x)" data-testid="lot-status">{{
              statusLabel(x)
            }}</span>
            @if (x.expiryDate) {
              <span class="text-sm text-muted" data-testid="lot-expiry"
                >Validade {{ date(x.expiryDate) }} · {{ expiryText(x.expiryDate) }}</span
              >
            } @else {
              <span class="text-sm text-muted">Sem validade</span>
            }
            @if (x.blockReason) {
              <span class="text-sm text-muted">Bloqueado: {{ x.blockReason }}</span>
            }
            @if (x.recallReason) {
              <span class="text-sm text-muted"
                >Recolhido em {{ when(x.recalledAt!) }}: {{ x.recallReason }}</span
              >
            }
            <span class="ml-auto flex flex-wrap gap-2">
              @if (acts().block) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="lot-block"
                  [disabled]="act.busy()"
                  (click)="open('block')"
                >
                  Bloquear
                </button>
              }
              @if (acts().unblock) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="lot-unblock"
                  [disabled]="act.busy()"
                  (click)="open('unblock')"
                >
                  Desbloquear
                </button>
              }
              @if (acts().recall) {
                <button
                  type="button"
                  class="btn-danger"
                  data-testid="lot-recall"
                  [disabled]="act.busy()"
                  (click)="open('recall')"
                >
                  Recolher
                </button>
              }
            </span>
          </div>
        </div>

        <section class="card" aria-labelledby="lot-where">
          <h2 id="lot-where" class="mb-3 font-semibold">Onde está</h2>
          @if (x.balances.length) {
            <div class="overflow-x-auto">
              <table class="w-full text-sm" data-testid="lot-balances">
                <thead>
                  <tr class="border-b border-border text-left text-muted">
                    <th class="py-2 pr-3">Armazém</th>
                    <th class="py-2 pr-3">Localização</th>
                    <th class="py-2 pr-3 text-right">Livre</th>
                    <th class="py-2 pr-3 text-right">Bloqueado</th>
                    <th class="py-2 pr-3 text-right">Quarentena</th>
                    <th class="py-2 text-right">Em trânsito</th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of x.balances; track $index) {
                    <tr
                      class="border-b border-border"
                      [attr.data-testid]="'lb-' + b.warehouse.code"
                    >
                      <td class="py-2 pr-3">{{ b.warehouse.code }}</td>
                      <td class="py-2 pr-3">{{ b.location?.pathCode ?? '—' }}</td>
                      <td class="py-2 pr-3 text-right">{{ q(b.unrestricted) }}</td>
                      <td class="py-2 pr-3 text-right">{{ q(b.blocked) }}</td>
                      <td class="py-2 pr-3 text-right">{{ q(b.quarantine) }}</td>
                      <td class="py-2 text-right">{{ q(b.inTransit) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="text-sm text-muted">Sem stock deste lote nos armazéns que consulta.</p>
          }
        </section>

        <section class="card" aria-labelledby="lot-dest" data-testid="lot-destinations">
          <h2 id="lot-dest" class="mb-1 font-semibold">Para onde foi</h2>
          <p class="mb-3 text-sm text-muted">
            Saídas definitivas (consumo, venda, abates) por origem — a lista a contactar numa
            recolha.
          </p>
          @if (x.destinations.length) {
            <ul class="divide-y divide-border text-sm">
              @for (d of x.destinations; track $index) {
                <li class="flex flex-wrap justify-between gap-2 py-1.5">
                  <span>
                    @if (link(d.source); as l) {
                      <a class="link" [routerLink]="l">{{ source(d.source) }}</a>
                    } @else {
                      {{ source(d.source) }}
                    }
                    · {{ d.warehouse }} · {{ when(d.lastAt) }}
                  </span>
                  <span class="font-medium">{{ q(d.quantity) }} {{ x.uom }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="text-sm text-muted">Nada saiu deste lote.</p>
          }
        </section>

        <section class="card" aria-labelledby="lot-mov">
          <h2 id="lot-mov" class="mb-3 font-semibold">Movimentos ({{ x.movements.length }})</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="lot-movements">
              <thead>
                <tr class="border-b border-border text-left text-muted">
                  <th class="py-2 pr-3">Data</th>
                  <th class="py-2 pr-3">Tipo</th>
                  <th class="py-2 pr-3">Origem</th>
                  <th class="py-2 pr-3">Armazém</th>
                  <th class="py-2 pr-3">Estado</th>
                  <th class="py-2 text-right">Quantidade</th>
                </tr>
              </thead>
              <tbody>
                @for (m of x.movements; track $index) {
                  <tr class="border-b border-border">
                    <td class="py-2 pr-3">{{ when(m.occurredAt) }}</td>
                    <td class="py-2 pr-3">{{ type(m.type) }}</td>
                    <td class="py-2 pr-3">
                      @if (link(m.source); as l) {
                        <a class="link" [routerLink]="l">{{ source(m.source) }}</a>
                      } @else {
                        {{ source(m.source) }}
                      }
                    </td>
                    <td class="py-2 pr-3">
                      {{ m.warehouse.code }}{{ m.location ? ' · ' + m.location.pathCode : '' }}
                    </td>
                    <td class="py-2 pr-3">{{ bucket(m.bucket) }}</td>
                    <td class="py-2 text-right">{{ sq(m.quantity) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        @if (x.serials.length) {
          <section class="card" aria-labelledby="lot-ser">
            <h2 id="lot-ser" class="mb-3 font-semibold">Séries ({{ x.serials.length }})</h2>
            <ul class="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              @for (s of x.serials; track s.id) {
                <li>
                  <a class="link" [routerLink]="['/inventario/series', s.id]">{{ s.serial }}</a>
                  <span class="text-muted">
                    ·
                    {{
                      s.status === 'IN_STOCK' ? (s.warehouse ?? 'noutro armazém') : 'fora do stock'
                    }}</span
                  >
                </li>
              }
            </ul>
          </section>
        }

        @if (x.events.length) {
          <section class="card" aria-labelledby="lot-ev" data-testid="lot-events">
            <h2 id="lot-ev" class="mb-3 font-semibold">Bloqueios e recolhas</h2>
            <ul class="divide-y divide-border text-sm">
              @for (e of x.events; track $index) {
                <li class="py-1.5">
                  {{ eventLabel(e.kind) }} · {{ when(e.at) }} · {{ e.by }} · {{ e.reason }}
                </li>
              }
            </ul>
          </section>
        }
        <section class="card" aria-labelledby="lot-hist">
          <h2 id="lot-hist" class="mb-3 font-semibold">Histórico</h2>
          <app-audit-history entityType="stock_lot" [entityId]="x.id" [refreshKey]="x.version" />
        </section>
      }
    </app-entity-form-page>

    <app-modal [title]="modalTitle()" [open]="modal() !== null" (closed)="modal.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <p class="mb-3 text-sm text-muted">{{ modalText() }}</p>
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <input
          appControl
          class="input"
          maxlength="300"
          data-testid="lot-reason"
          [(ngModel)]="reason"
          [ngModelOptions]="{ standalone: true }"
        />
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="modal.set(null)">Voltar</button>
        <button
          type="button"
          [class]="modal() === 'recall' ? 'btn-danger' : 'btn-primary'"
          data-testid="lot-save"
          [disabled]="act.busy()"
          (click)="save()"
        >
          {{ modalTitle() }}
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LotDetailPage {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly lot = signal<LotDetail | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly modal = signal<ModalKind | null>(null);
  protected reason = '';
  protected readonly q = qty;
  protected readonly sq = signedQty;
  protected readonly when = formatDateTime;
  protected readonly date = formatDate;
  protected readonly tone = lotTone;
  protected readonly statusLabel = lotStatusLabel;
  protected readonly link = sourceLink;
  protected readonly acts = computed(() =>
    this.lot() ? lotActions(this.lot()!) : { block: false, unblock: false, recall: false },
  );
  protected readonly title = computed(() => (this.lot() ? `Lote ${this.lot()!.code}` : 'Lote'));
  protected readonly subtitle = computed(() => {
    const x = this.lot();
    return x
      ? `${x.variant?.sku ?? x.product.sku} — ${x.product.name}${x.manufacturedDate ? ' · fabrico ' + formatDate(x.manufacturedDate) : ''}`
      : '';
  });
  protected readonly modalTitle = computed(
    () =>
      ({ block: 'Bloquear lote', unblock: 'Desbloquear lote', recall: 'Recolher lote' })[
        this.modal() ?? 'block'
      ],
  );
  protected readonly modalText = computed(
    () =>
      ({
        block:
          'O stock livre do lote em todos os armazéns passa a bloqueado: deixa de estar disponível e não sai por FEFO.',
        unblock: 'O que o último bloqueio moveu (e ainda está bloqueado) volta a livre.',
        recall:
          'A recolha é definitiva: o stock livre passa a bloqueado e fica a lista de para onde o lote foi.',
      })[this.modal() ?? 'block'],
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const x = await this.api.get<LotDetail>(`inventory/lots/${this.id()}`);
      this.lot.set(x);
      this.breadcrumbs.setCurrent(x.code);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected back() {
    void this.router.navigate(['/inventario/lotes']);
  }
  protected expiryText(d: string) {
    const n = daysToExpiry(d)!;
    return n < 0 ? `expirou há ${-n} dia(s)` : n === 0 ? 'expira hoje' : `faltam ${n} dia(s)`;
  }
  protected source(s: { type: string; ref: string | null }) {
    return sourceLabel(s);
  }
  protected type(t: string) {
    return POSTING_TYPE[t] ?? t;
  }
  protected bucket(b: string) {
    return BUCKET[b as keyof typeof BUCKET] ?? b;
  }
  protected eventLabel(k: string) {
    return LOT_EVENT[k] ?? k;
  }

  protected open(kind: ModalKind) {
    this.act.error.set(null);
    this.reason = '';
    this.modal.set(kind);
  }

  protected async save() {
    const x = this.lot()!;
    const kind = this.modal()!;
    if (kind === 'recall') {
      const ok = await this.confirmSvc.ask({
        title: 'Recolher lote',
        message: `A recolha do lote ${x.code} é definitiva e não se desfaz.`,
        confirmLabel: 'Recolher',
        danger: true,
      });
      if (!ok) return;
    }
    const res = await this.act.run(() =>
      this.api.post<LotDetail>(`inventory/lots/${x.id}/${kind}`, {
        expectedVersion: x.version,
        reason: this.reason.trim(),
      }),
    );
    if (!res) return;
    this.modal.set(null);
    this.lot.set(res);
    this.toasts.show(
      { block: 'Lote bloqueado.', unblock: 'Lote desbloqueado.', recall: 'Lote recolhido.' }[kind],
    );
  }
}
