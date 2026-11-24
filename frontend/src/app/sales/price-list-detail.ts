import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  percent,
  period,
  price,
  type PriceLine,
  type PriceList,
  PRICING_EVENT,
  PRICING_STATUS,
  type PricingStatus,
  pricingTone,
  type ProductHit,
  qty,
  targetLabel,
} from './pricing-model';

type Dialog = 'line' | 'reject' | 'deactivate' | 'copy' | null;

/**
 * Tabela de preços: cabeçalho, preços por produto/variante e escalão (editáveis só em rascunho), submissão, aprovação
 * por outra pessoa, devolução e inactivação com motivo, cópia para mudar preços, cronologia e auditoria.
 */
@Component({
  selector: 'app-price-list-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    DataTable,
    CellDef,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    Autocomplete,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? x()!.code + ' — ' + x()!.name : 'Tabela de preços'"
      [subtitle]="
        x()
          ? target(x()!) + ' · ' + x()!.currency + ' · ' + period(x()!.validFrom, x()!.validTo)
          : ''
      "
      formId="price-list-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as l) {
        <section class="card space-y-3" aria-label="Estado" data-testid="pd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(l.status)" data-testid="pd-status">{{
              status(l.status)
            }}</span>
            @if (l.inactiveReason) {
              <span class="text-sm text-muted">{{ l.inactiveReason }}</span>
            }
          </div>
          <dl class="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">Entidade</dt>
              <dd>{{ l.legalEntity?.code ?? 'Todas' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Prioridade</dt>
              <dd>{{ l.priority }}</dd>
            </div>
            <div>
              <dt class="text-muted">Submetida</dt>
              <dd>{{ l.submittedAt ? when(l.submittedAt) : '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Aprovada</dt>
              <dd>{{ l.approvedAt ? when(l.approvedAt) : '—' }}</dd>
            </div>
          </dl>
          @if (l.copiedFrom) {
            <p class="text-sm">
              Copiada de
              <a class="link" [routerLink]="['/vendas/precos', l.copiedFrom.id]">{{
                l.copiedFrom.code
              }}</a>
            </p>
          }
          @if (l.notes) {
            <p class="whitespace-pre-line text-sm">{{ l.notes }}</p>
          }
          @if (l.status === 'PENDING' && !l.can.approve && l.can.reject) {
            <p class="text-sm text-muted">Foi submetida por si: outra pessoa tem de a aprovar.</p>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (l.can.edit) {
              <a
                class="btn-secondary"
                data-testid="pd-edit"
                [routerLink]="['/vendas/precos', l.id, 'editar']"
                >Editar cabeçalho</a
              >
            }
            @if (l.can.submit) {
              <button type="button" class="btn-primary" data-testid="pd-submit" (click)="submit()">
                Submeter para aprovação
              </button>
            }
            @if (l.can.approve) {
              <button
                type="button"
                class="btn-primary"
                data-testid="pd-approve"
                (click)="approve()"
              >
                Aprovar
              </button>
            }
            @if (l.can.reject) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="pd-reject"
                (click)="open('reject')"
              >
                Devolver
              </button>
            }
            @if (l.can.deactivate) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="pd-deactivate"
                (click)="open('deactivate')"
              >
                Inactivar
              </button>
            }
            @if (l.can.copy) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="pd-copy"
                (click)="openCopy(l)"
              >
                Copiar para nova tabela
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="pd-lines-title">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h2 id="pd-lines-title" class="font-semibold">Preços</h2>
            @if (l.can.edit) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="pd-line-new"
                (click)="openLine(null)"
              >
                Novo preço
              </button>
            }
          </div>
          <p class="mb-2 text-xs text-muted">
            Preço unitário na unidade base, sem impostos. Com escalões, vale o maior mínimo que a
            quantidade atinge; o preço de uma variante prevalece sobre o do produto.
          </p>
          <app-data-table
            label="Preços da tabela"
            [columns]="columns"
            [rows]="l.lines"
            [total]="l.lines.length"
            [limit]="1000"
            emptyText="Sem preços."
          >
            <ng-template appCell="actions" let-row>
              @if (l.can.edit) {
                <button
                  type="button"
                  class="link"
                  [attr.aria-label]="'Editar ' + row.product.sku"
                  (click)="openLine(row)"
                >
                  Editar
                </button>
                <button
                  type="button"
                  class="link ml-2"
                  [attr.aria-label]="'Remover ' + row.product.sku"
                  (click)="removeLine(row)"
                >
                  Remover
                </button>
              }
            </ng-template>
          </app-data-table>
        </section>

        <section class="card" aria-labelledby="pd-h-title">
          <h2 id="pd-h-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="pd-history">
            @for (h of l.history; track $index) {
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

        <app-audit-history entityType="price_list" [entityId]="l.id" [refreshKey]="l.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @switch (dialog()) {
        @case ('line') {
          <div class="space-y-3">
            @if (!line.id) {
              <app-field #pf label="Produto" [required]="true" [error]="act.field('productId')">
                <app-autocomplete
                  name="product"
                  data-testid="pd-l-product"
                  [inputId]="pf.controlId"
                  [describedBy]="pf.describedBy()"
                  [search]="searchProducts"
                  [(ngModel)]="line.productId"
                  (ngModelChange)="productChosen($event)"
                />
              </app-field>
              @if (variants().length) {
                <app-field
                  label="Variante"
                  hint="Vazio: o preço vale para todas as variantes sem preço próprio."
                  [error]="act.field('variantId')"
                >
                  <select appControl class="input" name="variant" [(ngModel)]="line.variantId">
                    <option value="">Todas</option>
                    @for (v of variants(); track v.id) {
                      <option [value]="v.id">{{ v.sku }}</option>
                    }
                  </select>
                </app-field>
              }
            } @else {
              <p class="text-sm">
                <strong>{{ line.label }}</strong>
              </p>
            }
            <app-field
              label="Quantidade mínima"
              hint="Escalão: 1 para o preço base."
              [error]="act.field('minQuantity')"
            >
              <input
                appControl
                class="input w-36"
                inputmode="decimal"
                name="min"
                data-testid="pd-l-min"
                [(ngModel)]="line.minQuantity"
              />
            </app-field>
            <app-field label="Preço unitário" [required]="true" [error]="act.field('unitPrice')">
              <input
                appControl
                class="input w-48"
                inputmode="decimal"
                name="price"
                data-testid="pd-l-price"
                [(ngModel)]="line.unitPrice"
              />
            </app-field>
            <app-field
              label="Desconto manual máximo (%)"
              hint="Vazio: o limite do cliente, segmento ou geral. Só reduz esse limite."
              [error]="act.field('maxDiscountPct')"
            >
              <input
                appControl
                class="input w-28"
                inputmode="decimal"
                name="maxd"
                data-testid="pd-l-maxd"
                [(ngModel)]="line.maxDiscountPct"
              />
            </app-field>
          </div>
        }
        @case ('copy') {
          <div class="space-y-3">
            <p class="text-sm">
              A nova tabela fica em rascunho com os mesmos preços; a actual não muda.
            </p>
            <app-field label="Código" [required]="true" [error]="act.field('code')">
              <input
                appControl
                class="input uppercase"
                name="ccode"
                data-testid="pd-c-code"
                [(ngModel)]="copy.code"
              />
            </app-field>
            <app-field label="Nome" [error]="act.field('name')">
              <input appControl class="input" name="cname" [(ngModel)]="copy.name" />
            </app-field>
            <app-field label="De" [required]="true" [error]="act.field('validFrom')">
              <input
                appControl
                class="input"
                type="date"
                name="cfrom"
                data-testid="pd-c-from"
                [(ngModel)]="copy.validFrom"
              />
            </app-field>
            <app-field label="Até" [error]="act.field('validTo')">
              <input appControl class="input" type="date" name="cto" [(ngModel)]="copy.validTo" />
            </app-field>
          </div>
        }
        @default {
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <textarea
              appControl
              class="input min-h-16"
              name="reason"
              data-testid="pd-reason"
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
          data-testid="pd-ok"
          [disabled]="act.busy()"
          (click)="confirmDialog()"
        >
          {{ dialog() === 'copy' ? 'Copiar' : 'Guardar' }}
        </button>
      </div>
    </app-modal>
  `,
})
export class PriceListDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<PriceList | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly variants = signal<{ id: string; sku: string }[]>([]);
  protected readonly act = new Action();
  protected readonly when = formatDateTime;
  protected readonly period = period;
  protected readonly tone = pricingTone;
  protected readonly target = targetLabel;
  protected readonly status = (s: PricingStatus) => PRICING_STATUS[s] ?? s;
  protected readonly event = (k: string) => PRICING_EVENT[k] ?? k;
  protected reason = '';
  protected line = this.blankLine();
  protected copy = { code: '', name: '', validFrom: '', validTo: '' };
  private hits: ProductHit[] = [];
  protected readonly columns: Column<PriceLine>[] = [
    {
      key: 'sku',
      label: 'Produto',
      required: true,
      value: (l) => `${l.product.sku} — ${l.product.name}`,
    },
    {
      key: 'variant',
      label: 'Variante',
      hideOnMobile: true,
      value: (l) => l.variant?.sku ?? 'Todas',
    },
    { key: 'minQuantity', label: 'A partir de', align: 'end', value: (l) => qty(l.minQuantity) },
    {
      key: 'unitPrice',
      label: 'Preço unitário',
      align: 'end',
      value: (l) => price(l.unitPrice, this.x()?.currency),
    },
    {
      key: 'maxDiscountPct',
      label: 'Desconto máx.',
      align: 'end',
      hideOnMobile: true,
      value: (l) => percent(l.maxDiscountPct),
    },
    { key: 'actions', label: 'Acções', required: true },
  ];

  protected readonly searchProducts = async (q: string): Promise<Option[]> => {
    this.hits = await this.api.get<ProductHit[]>('sales/pricing/search/products', { q });
    return this.hits.map((p) => ({
      id: p.id,
      label: `${p.sku} — ${p.name}`,
      hint: p.salePrice ? `Catálogo: ${price(p.salePrice, p.currency)}` : null,
    }));
  };

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private blankLine() {
    return {
      id: '',
      version: 0,
      label: '',
      productId: '',
      variantId: '',
      minQuantity: '1',
      unitPrice: '',
      maxDiscountPct: '',
    };
  }

  protected dialogTitle() {
    switch (this.dialog()) {
      case 'line':
        return this.line.id ? 'Editar preço' : 'Novo preço';
      case 'reject':
        return 'Devolver a tabela';
      case 'deactivate':
        return 'Inactivar a tabela';
      case 'copy':
        return 'Copiar para nova tabela';
      default:
        return '';
    }
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<PriceList>(`sales/price-lists/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(l: PriceList) {
    this.x.set(l);
    this.breadcrumbs.setCurrent(l.code);
  }
  protected back() {
    void this.router.navigate(['/vendas/precos']);
  }

  protected open(d: Dialog) {
    this.act.error.set(null);
    this.reason = '';
    this.dialog.set(d);
  }
  protected openLine(l: PriceLine | null) {
    this.variants.set([]);
    this.line = l
      ? {
          id: l.id,
          version: l.version,
          label: `${l.product.sku} — ${l.product.name}${l.variant ? ' · ' + l.variant.sku : ''}`,
          productId: l.product.id,
          variantId: l.variant?.id ?? '',
          minQuantity: qty(l.minQuantity).replace(',', '.'),
          unitPrice: l.unitPrice,
          maxDiscountPct: l.maxDiscountPct ?? '',
        }
      : this.blankLine();
    this.open('line');
  }
  protected productChosen(id: string) {
    this.line.variantId = '';
    this.variants.set(this.hits.find((p) => p.id === id)?.variants ?? []);
  }
  protected openCopy(l: PriceList) {
    this.copy = { code: '', name: l.name, validFrom: '', validTo: '' };
    this.open('copy');
  }

  private async run(req: () => Promise<PriceList>, done: string) {
    const r = await this.act.run(req);
    if (!r) return null;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show(done);
    return r;
  }
  private base() {
    return `sales/price-lists/${this.x()!.id}`;
  }

  protected submit() {
    void this.run(
      () =>
        this.api.post<PriceList>(`${this.base()}/submit`, { expectedVersion: this.x()!.version }),
      'Tabela submetida para aprovação.',
    );
  }
  protected async approve() {
    const ok = await this.confirm.ask({
      title: 'Aprovar a tabela',
      message: 'A tabela fica activa e os preços deixam de poder ser alterados.',
      confirmLabel: 'Aprovar',
    });
    if (!ok) return;
    await this.run(
      () =>
        this.api.post<PriceList>(`${this.base()}/approve`, { expectedVersion: this.x()!.version }),
      'Tabela aprovada e activa.',
    );
  }
  protected async removeLine(l: PriceLine) {
    const ok = await this.confirm.ask({
      title: 'Remover o preço',
      message: `Remover o preço de ${l.product.sku} a partir de ${qty(l.minQuantity)}?`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      await this.api.delete(`${this.base()}/lines/${l.id}`);
      return this.api.get<PriceList>(this.base());
    }, 'Preço removido.');
  }

  protected async confirmDialog() {
    const l = this.x()!;
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    switch (this.dialog()) {
      case 'line': {
        const b = {
          minQuantity: nz(this.line.minQuantity) ?? '1',
          unitPrice: this.line.unitPrice.trim(),
          maxDiscountPct: nz(this.line.maxDiscountPct),
        };
        await this.run(
          () =>
            this.line.id
              ? this.api.patch<PriceList>(`${this.base()}/lines/${this.line.id}`, {
                  ...b,
                  expectedVersion: this.line.version,
                })
              : this.api.post<PriceList>(`${this.base()}/lines`, {
                  ...b,
                  productId: this.line.productId,
                  variantId: nz(this.line.variantId),
                }),
          'Preço guardado.',
        );
        return;
      }
      case 'reject':
      case 'deactivate': {
        const kind = this.dialog()!;
        await this.run(
          () =>
            this.api.post<PriceList>(`${this.base()}/${kind}`, {
              expectedVersion: l.version,
              reason: this.reason,
            }),
          kind === 'reject' ? 'Tabela devolvida.' : 'Tabela inactivada.',
        );
        return;
      }
      case 'copy': {
        const r = await this.act.run(() =>
          this.api.post<PriceList>(`${this.base()}/copy`, {
            code: this.copy.code,
            name: nz(this.copy.name),
            validFrom: this.copy.validFrom,
            validTo: nz(this.copy.validTo),
          }),
        );
        if (!r) return;
        this.dialog.set(null);
        this.toasts.show('Nova tabela criada em rascunho.');
        await this.router.navigate(['/vendas/precos', r.id]);
        return;
      }
    }
  }
}
