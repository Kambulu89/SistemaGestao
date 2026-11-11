import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Workspace } from '../core/workspace';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { sourceLink } from './lot-model';
import { newKey, POSTING_TYPE, qty, signedQty, sourceLabel } from './stock-model';
import { ENTRY_SOURCE, METHOD, money, type ProductValuation } from './valuation-model';

/**
 * Valorização de um produto numa entidade (8.9): saldo de custo, camadas (FIFO/lote) e o livro de custo, só de
 * acréscimo. O ajuste de custo soma ao stock que existe (no médio, ao saldo; no FIFO/lote, à camada escolhida).
 */
@Component({
  selector: 'app-valuation-detail',
  imports: [FormsModule, RouterLink, EntityFormPage, FormField, FieldControl, Modal, ErrorAlert],
  template: `
    <app-entity-form-page
      [title]="v() ? 'Valorização ' + v()!.product.sku : 'Valorização'"
      [subtitle]="v() ? v()!.product.name + ' · ' + method(v()!.method) : ''"
      formId="valuation-detail"
      [loading]="!v()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (v(); as x) {
        <div class="card flex flex-wrap items-center gap-4" data-testid="vd-pools">
          @for (p of x.pools; track $index) {
            <div>
              <span class="block text-xs text-muted"
                >{{ p.legalEntity.code }}{{ p.variant ? ' · ' + p.variant.sku : '' }}</span
              >
              <span class="font-semibold" data-testid="vd-value">{{ m(p.value, p.currency) }}</span>
              <span class="block text-xs text-muted"
                >{{ q(p.quantity) }} {{ x.uom }} a {{ q(p.unitCost) }}</span
              >
            </div>
          } @empty {
            <span class="text-sm text-muted">Sem stock valorizado nesta entidade.</span>
          }
          @if (canManage() && x.pools.length) {
            <button
              type="button"
              class="btn-secondary ml-auto"
              data-testid="vd-adjust"
              (click)="open()"
            >
              Ajustar custo
            </button>
          }
        </div>

        @if (x.method !== 'AVERAGE') {
          <section class="card" aria-labelledby="vd-layers-h">
            <h2 id="vd-layers-h" class="mb-3 font-semibold">Camadas</h2>
            <div class="overflow-x-auto">
              <table class="w-full text-sm" data-testid="vd-layers">
                <thead>
                  <tr class="border-b border-border text-left text-muted">
                    <th class="py-2 pr-3">Entrada</th>
                    <th class="py-2 pr-3">Origem</th>
                    <th class="py-2 pr-3">Lote</th>
                    <th class="py-2 pr-3 text-right">Entrou</th>
                    <th class="py-2 pr-3 text-right">Custo unitário</th>
                    <th class="py-2 pr-3 text-right">Resta</th>
                    <th class="py-2 text-right">Valor restante</th>
                  </tr>
                </thead>
                <tbody>
                  @for (l of x.layers; track l.id) {
                    <tr
                      class="border-b border-border"
                      [class.text-muted]="+l.remainingQuantity === 0"
                    >
                      <td class="py-2 pr-3">{{ when(l.receivedAt) }}</td>
                      <td class="py-2 pr-3">{{ l.source.ref ?? '—' }}</td>
                      <td class="py-2 pr-3">{{ l.lot?.code ?? '—' }}</td>
                      <td class="py-2 pr-3 text-right">{{ q(l.quantityIn) }}</td>
                      <td class="py-2 pr-3 text-right">{{ q(l.unitCost) }}</td>
                      <td class="py-2 pr-3 text-right">{{ q(l.remainingQuantity) }}</td>
                      <td class="py-2 text-right">{{ m(l.remainingValue) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <section class="card" aria-labelledby="vd-ledger-h">
          <h2 id="vd-ledger-h" class="mb-1 font-semibold">Livro de custo</h2>
          <p class="mb-3 text-sm text-muted">
            Só de acréscimo: cada entrada e saída de valor, com a origem.
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="vd-ledger">
              <thead>
                <tr class="border-b border-border text-left text-muted">
                  <th class="py-2 pr-3">Data</th>
                  <th class="py-2 pr-3">Movimento</th>
                  <th class="py-2 pr-3">Origem</th>
                  <th class="py-2 pr-3">Como se valorizou</th>
                  <th class="py-2 pr-3 text-right">Quantidade</th>
                  <th class="py-2 text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                @for (e of x.ledger; track e.id) {
                  <tr class="border-b border-border">
                    <td class="py-2 pr-3">{{ when(e.occurredAt) }}</td>
                    <td class="py-2 pr-3">
                      {{ e.postingType ? type(e.postingType) : 'Ajuste de custo' }}
                    </td>
                    <td class="py-2 pr-3">
                      @if (e.origin) {
                        @if (link(e.origin); as l) {
                          <a class="link" [routerLink]="l">{{ source(e.origin) }}</a>
                        } @else {
                          {{ source(e.origin) }}
                        }
                      } @else {
                        {{ e.reason ?? '—' }}
                      }
                    </td>
                    <td class="py-2 pr-3">
                      {{ entrySource(e.source) }}{{ e.lot ? ' · lote ' + e.lot : '' }}
                    </td>
                    <td class="py-2 pr-3 text-right">
                      {{ e.quantity === '0.000000' ? '—' : sq(e.quantity) }}
                    </td>
                    <td class="py-2 text-right" [class.text-danger-text]="e.value.startsWith('-')">
                      {{ m(e.value) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </app-entity-form-page>

    <app-modal title="Ajustar custo" [open]="modal()" (closed)="modal.set(false)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <p class="mb-3 text-sm text-muted">
        Soma (ou subtrai) ao valor do stock que ainda existe — o que já saiu não muda.
      </p>
      @if ((v()?.pools ?? []).length > 1) {
        <app-field label="Variante" [required]="true">
          <select
            appControl
            class="input"
            [(ngModel)]="adj.variantId"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (p of v()?.pools ?? []; track $index) {
              <option [value]="p.variant?.id ?? ''">
                {{ p.variant?.sku ?? v()!.product.sku }}
              </option>
            }
          </select>
        </app-field>
      }
      @if (v()?.method !== 'AVERAGE') {
        <app-field label="Camada" [required]="true" [error]="act.field('layerId')">
          <select
            appControl
            class="input"
            data-testid="adj-layer"
            [(ngModel)]="adj.layerId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option value="">—</option>
            @for (l of openLayers(); track l.id) {
              <option [value]="l.id">
                {{ when(l.receivedAt) }} · {{ l.lot?.code ?? l.source.ref ?? '' }} · resta
                {{ q(l.remainingQuantity) }}
              </option>
            }
          </select>
        </app-field>
      }
      <app-field label="Valor (+/−)" [required]="true" [error]="act.field('amount')">
        <input
          appControl
          class="input"
          inputmode="decimal"
          data-testid="adj-amount"
          [(ngModel)]="adj.amount"
          [ngModelOptions]="{ standalone: true }"
        />
      </app-field>
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <input
          appControl
          class="input"
          maxlength="300"
          data-testid="adj-reason"
          [(ngModel)]="adj.reason"
          [ngModelOptions]="{ standalone: true }"
        />
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="modal.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="adj-save"
          [disabled]="act.busy()"
          (click)="save()"
        >
          Ajustar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class ValuationDetailPage {
  readonly legalEntityId = input<string | null>(null);
  readonly productId = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly v = signal<ProductValuation | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly modal = signal(false);
  protected adj = { variantId: '', layerId: '', amount: '', reason: '' };
  private key = '';
  protected readonly m = money;
  protected readonly q = qty;
  protected readonly sq = signedQty;
  protected readonly when = formatDateTime;
  protected readonly link = sourceLink;
  protected readonly canManage = computed(() =>
    this.workspace.canAny('inventory.valuation.manage'),
  );
  protected readonly openLayers = computed(() =>
    (this.v()?.layers ?? []).filter((l) => +l.remainingQuantity > 0),
  );

  constructor() {
    effect(() => {
      this.legalEntityId();
      this.productId();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const x = await this.api.get<ProductValuation>(
        `inventory/valuation/products/${this.productId()}`,
        { legalEntityId: this.legalEntityId() ?? '' },
      );
      this.v.set(x);
      this.breadcrumbs.setCurrent(x.product.sku);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected back() {
    void this.router.navigate(['/inventario/valorizacao']);
  }
  protected method(m: ProductValuation['method']) {
    return METHOD[m];
  }
  protected type(t: string) {
    return POSTING_TYPE[t] ?? t;
  }
  protected source(s: { type: string; ref: string | null }) {
    return sourceLabel(s);
  }
  protected entrySource(s: string) {
    return ENTRY_SOURCE[s] ?? s;
  }

  protected open() {
    this.act.error.set(null);
    this.adj = {
      variantId: this.v()?.pools[0]?.variant?.id ?? '',
      layerId: '',
      amount: '',
      reason: '',
    };
    this.key = newKey('cost');
    this.modal.set(true);
  }

  protected async save() {
    const x = this.v()!;
    const res = await this.act.run(() =>
      this.api.post<ProductValuation>('inventory/valuation/adjustments', {
        legalEntityId: this.legalEntityId(),
        productId: x.product.id,
        variantId: this.adj.variantId || null,
        layerId: this.adj.layerId || null,
        amount: this.adj.amount.trim().replace(',', '.'),
        reason: this.adj.reason.trim(),
        idempotencyKey: this.key,
      }),
    );
    if (!res) return;
    this.modal.set(false);
    this.v.set(res);
    this.toasts.show('Custo ajustado.');
  }
}
