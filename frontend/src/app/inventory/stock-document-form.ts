import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import type { Product } from './inventory-model';
import { newKey, qty } from './stock-model';
import {
  basePreview,
  checkDefaults,
  DOC_STATUS,
  DOC_TYPE,
  docActions,
  type DocLine,
  type DocType,
  LINE_BUCKET,
  ORIGIN,
  ORIGINS,
  parseSerials,
  type StockDocument,
  statusTone,
} from './stock-document-model';
import type { Warehouse, WarehouseLocation } from './warehouse-model';

interface LineForm {
  productId: string;
  variantId: string;
  uomId: string;
  quantity: string;
  locationId: string;
  bucket: string;
  lotCode: string;
  serials: string;
  expiryDate: string;
  unitCost: string;
}
const emptyLine = (): LineForm => ({
  productId: '',
  variantId: '',
  uomId: '',
  quantity: '',
  locationId: '',
  bucket: 'UNRESTRICTED',
  lotCode: '',
  serials: '',
  expiryDate: '',
  unitCost: '',
});
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Documento de entrada ou saída (8.4). Rascunho editável; depois conferência (quantidades contadas), confirmação
 * (lança o stock e numera), novas rondas para o que falta, fecho do saldo com motivo, anulação antes de confirmar e
 * estorno de confirmações. As permissões e o estado vêm da API.
 */
@Component({
  selector: 'app-stock-document-form',
  imports: [
    FormsModule,
    EntityFormPage,
    FormSection,
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
      formId="stock-document-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [readOnly]="!editable()"
      [saveLabel]="isNew() ? 'Criar rascunho' : 'Guardar rascunho'"
      (save)="save()"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (d(); as x) {
        <div class="card flex flex-wrap items-center gap-3" data-testid="doc-state">
          <span class="badge" [class]="tone(x.status)" data-testid="doc-status">{{
            statusLabel(x.status)
          }}</span>
          @if (x.closedShort) {
            <span class="text-sm text-muted">Saldo fechado: {{ x.closeReason }}</span>
          }
          @if (x.cancelReason) {
            <span class="text-sm text-muted">Anulado: {{ x.cancelReason }}</span>
          }
          @if (x.checkedBy && x.status === 'CHECKED') {
            <span class="text-sm text-muted"
              >Conferido por {{ x.checkedBy }} · {{ when(x.checkedAt) }}</span
            >
          }
          <span class="ml-auto flex flex-wrap gap-2">
            @if (acts().check) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="doc-check"
                (click)="openCheck()"
              >
                Conferir
              </button>
            }
            @if (acts().reopen) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="doc-reopen"
                (click)="reopen()"
              >
                Reabrir conferência
              </button>
            }
            @if (acts().confirm) {
              <button
                type="button"
                class="btn-primary"
                data-testid="doc-confirm"
                (click)="confirm()"
              >
                Confirmar e movimentar stock
              </button>
            }
            @if (acts().close) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="doc-close"
                (click)="openReason('close')"
              >
                Fechar saldo
              </button>
            }
            @if (acts().cancel) {
              <button
                type="button"
                class="btn-danger"
                data-testid="doc-cancel"
                (click)="openReason('cancel')"
              >
                Anular
              </button>
            }
          </span>
        </div>
      }

      <app-form-section
        title="Documento"
        description="Armazém, data e origem. O número é atribuído na primeira confirmação, pela série documental da entidade legal."
      >
        <app-field label="Armazém" [required]="true" [error]="action.field('warehouseId')">
          <select
            appControl
            class="input"
            name="warehouseId"
            data-testid="df-warehouse"
            [(ngModel)]="f.warehouseId"
            [disabled]="!isNew()"
            (ngModelChange)="warehouseChanged()"
          >
            <option value="">—</option>
            @for (w of operable(); track w.id) {
              <option [value]="w.id">{{ w.code }} — {{ w.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('documentDate')">
          <input
            appControl
            type="date"
            class="input"
            name="documentDate"
            data-testid="df-date"
            [max]="maxDate"
            [(ngModel)]="f.documentDate"
            [disabled]="!editable()"
          />
        </app-field>
        <app-field label="Origem" [required]="true" [error]="action.field('origin')">
          <select
            appControl
            class="input"
            name="origin"
            data-testid="df-origin"
            [(ngModel)]="f.origin"
            [disabled]="!editable()"
          >
            @for (o of origins(); track o) {
              <option [value]="o">{{ originLabel(o) }}</option>
            }
          </select>
        </app-field>
        <app-field label="Referência" hint="Ex.: factura do fornecedor, guia, requisição.">
          <input
            appControl
            class="input"
            name="originRef"
            maxlength="60"
            data-testid="df-ref"
            [(ngModel)]="f.originRef"
            [disabled]="!editable()"
          />
        </app-field>
        <app-field [label]="type() === 'RECEIPT' ? 'Fornecedor / origem' : 'Destinatário'">
          <input
            appControl
            class="input"
            name="counterparty"
            maxlength="160"
            [(ngModel)]="f.counterparty"
            [disabled]="!editable()"
          />
        </app-field>
        <app-field label="Notas">
          <input
            appControl
            class="input"
            name="notes"
            maxlength="500"
            [(ngModel)]="f.notes"
            [disabled]="!editable()"
          />
        </app-field>
      </app-form-section>

      @if (editable()) {
        <section class="card" aria-labelledby="df-lines-h">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="df-lines-h" class="font-semibold">Linhas ({{ f.lines.length }})</h2>
            <button
              type="button"
              class="btn-secondary"
              data-testid="df-add-line"
              (click)="addLine()"
            >
              + Linha
            </button>
          </div>
          @if (!f.warehouseId) {
            <p class="text-sm text-muted">Escolha primeiro o armazém.</p>
          }
          <div class="space-y-4">
            @for (l of f.lines; track $index; let i = $index) {
              <fieldset
                class="rounded-md border border-border p-3"
                [attr.data-testid]="'df-line-' + i"
              >
                <legend class="px-1 text-sm font-medium">Linha {{ i + 1 }}</legend>
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <app-field label="Produto" [required]="true" [error]="lineError(i, 'productId')">
                    <select
                      appControl
                      class="input"
                      [name]="'p' + i"
                      data-testid="dl-product"
                      [(ngModel)]="l.productId"
                      (ngModelChange)="productChanged(l)"
                    >
                      <option value="">—</option>
                      @for (p of products(); track p.id) {
                        <option [value]="p.id">{{ p.sku }} — {{ p.name }}</option>
                      }
                    </select>
                  </app-field>
                  @if (detail(l.productId); as p) {
                    @if (p.hasVariants) {
                      <app-field
                        label="Variante"
                        [required]="true"
                        [error]="lineError(i, 'variantId')"
                      >
                        <select
                          appControl
                          class="input"
                          [name]="'v' + i"
                          data-testid="dl-variant"
                          [(ngModel)]="l.variantId"
                        >
                          <option value="">—</option>
                          @for (v of p.variants ?? []; track v.id) {
                            <option [value]="v.id">{{ v.sku }}</option>
                          }
                        </select>
                      </app-field>
                    }
                    <app-field label="Unidade" [required]="true" [error]="lineError(i, 'uomId')">
                      <select
                        appControl
                        class="input"
                        [name]="'u' + i"
                        data-testid="dl-uom"
                        [(ngModel)]="l.uomId"
                      >
                        @for (u of uomsOf(p); track u.id) {
                          <option [value]="u.id">{{ u.label }}</option>
                        }
                      </select>
                    </app-field>
                    <app-field
                      label="Quantidade"
                      [required]="true"
                      [hint]="baseHint(l, p)"
                      [error]="lineError(i, 'quantity')"
                    >
                      <input
                        appControl
                        class="input"
                        inputmode="decimal"
                        [name]="'q' + i"
                        data-testid="dl-qty"
                        [(ngModel)]="l.quantity"
                      />
                    </app-field>
                    <app-field label="Localização" [error]="lineError(i, 'locationId')">
                      <select
                        appControl
                        class="input"
                        [name]="'l' + i"
                        data-testid="dl-location"
                        [(ngModel)]="l.locationId"
                      >
                        <option value="">— (sem posição)</option>
                        @for (loc of locations(); track loc.id) {
                          <option [value]="loc.id">{{ loc.pathCode }}</option>
                        }
                      </select>
                    </app-field>
                    <app-field
                      [label]="type() === 'RECEIPT' ? 'Entra como' : 'Sai de'"
                      [error]="lineError(i, 'bucket')"
                    >
                      <select
                        appControl
                        class="input"
                        [name]="'b' + i"
                        data-testid="dl-bucket"
                        [(ngModel)]="l.bucket"
                      >
                        @for (b of buckets; track b[0]) {
                          <option [value]="b[0]">{{ b[1] }}</option>
                        }
                      </select>
                    </app-field>
                    @if (p.trackLots) {
                      <app-field label="Lote" [required]="true" [error]="lineError(i, 'lotCode')">
                        <input
                          appControl
                          class="input"
                          maxlength="40"
                          [name]="'lot' + i"
                          data-testid="dl-lot"
                          [(ngModel)]="l.lotCode"
                        />
                      </app-field>
                    }
                    @if (p.trackExpiry) {
                      <app-field
                        label="Validade"
                        [required]="type() === 'RECEIPT'"
                        [error]="lineError(i, 'expiryDate')"
                      >
                        <input
                          appControl
                          type="date"
                          class="input"
                          [name]="'exp' + i"
                          data-testid="dl-expiry"
                          [(ngModel)]="l.expiryDate"
                        />
                      </app-field>
                    }
                    @if (type() === 'RECEIPT') {
                      <app-field
                        [label]="'Custo unitário' + (currency() ? ' (' + currency() + ')' : '')"
                        hint="Por unidade do documento; usado na valorização."
                        [error]="lineError(i, 'unitCost')"
                      >
                        <input
                          appControl
                          class="input"
                          inputmode="decimal"
                          [name]="'c' + i"
                          data-testid="dl-cost"
                          [(ngModel)]="l.unitCost"
                        />
                      </app-field>
                    }
                    @if (p.trackSerials) {
                      <div class="sm:col-span-2 lg:col-span-4">
                        <app-field
                          label="Números de série"
                          [required]="true"
                          hint="Um por linha ou separados por vírgulas; um por unidade base."
                          [error]="lineError(i, 'serials')"
                        >
                          <textarea
                            appControl
                            class="input"
                            rows="2"
                            [name]="'s' + i"
                            data-testid="dl-serials"
                            [(ngModel)]="l.serials"
                          ></textarea>
                        </app-field>
                      </div>
                    }
                  }
                </div>
                <div class="mt-2 flex justify-end">
                  <button
                    type="button"
                    class="link"
                    [attr.aria-label]="'Retirar a linha ' + (i + 1)"
                    (click)="removeLine(i)"
                  >
                    Retirar
                  </button>
                </div>
              </fieldset>
            }
          </div>
        </section>
      } @else if (d(); as x) {
        <section class="card" aria-labelledby="df-lines-ro">
          <h2 id="df-lines-ro" class="mb-3 font-semibold">Linhas</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="doc-lines">
              <thead>
                <tr class="border-b border-border text-left text-muted">
                  <th class="py-2 pr-3">Produto</th>
                  <th class="py-2 pr-3 text-right">Quantidade</th>
                  <th class="py-2 pr-3">Localização</th>
                  <th class="py-2 pr-3">Rastreio</th>
                  <th class="py-2 pr-3 text-right">Confirmado</th>
                  <th class="py-2 pr-3 text-right">Por confirmar</th>
                  <th class="py-2 text-right">Conferido</th>
                </tr>
              </thead>
              <tbody>
                @for (l of x.lines ?? []; track l.id) {
                  <tr class="border-b border-border align-top">
                    <td class="py-2 pr-3">
                      <span class="font-medium">{{ l.variant?.sku ?? l.product.sku }}</span>
                      <span class="block text-xs text-muted"
                        >{{ l.product.name }} · {{ bucketLabel(l.bucket) }}</span
                      >
                    </td>
                    <td class="py-2 pr-3 text-right">
                      {{ q(l.quantity) }} {{ l.uom.code }}
                      @if (l.uom.code !== l.baseUom) {
                        <span class="block text-xs text-muted"
                          >= {{ q(l.baseQuantity) }} {{ l.baseUom }}</span
                        >
                      }
                    </td>
                    <td class="py-2 pr-3">{{ l.location?.pathCode ?? '—' }}</td>
                    <td class="py-2 pr-3 text-xs">
                      {{ l.lotCode ? 'Lote ' + l.lotCode : '' }}
                      {{ l.expiryDate ? ' · val. ' + date(l.expiryDate) : '' }}
                      {{ l.serials.length ? ' · ' + l.serials.join(', ') : '' }}
                    </td>
                    <td class="py-2 pr-3 text-right">{{ q(l.confirmedQuantity) }}</td>
                    <td class="py-2 pr-3 text-right">{{ q(l.remainingQuantity) }}</td>
                    <td class="py-2 text-right">
                      {{ l.checkedQuantity === null ? '—' : q(l.checkedQuantity) }}
                      @if (l.differenceReason) {
                        <span class="block text-xs text-muted">{{ l.differenceReason }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (d(); as x) {
        @if ((x.confirmations ?? []).length) {
          <section class="card" aria-labelledby="df-conf" data-testid="doc-confirmations">
            <h2 id="df-conf" class="mb-3 font-semibold">Confirmações</h2>
            <ul class="divide-y divide-border text-sm">
              @for (c of x.confirmations ?? []; track c.id) {
                <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span [class.text-muted]="c.reversalPostingId">
                    #{{ c.seq }} · {{ when(c.createdAt) }} · {{ c.createdBy }} ·
                    {{ c.lines.length }} linha(s)
                    @if (c.reversalPostingId) {
                      <span class="block text-xs"
                        >Estornada por {{ c.reversedBy }} em {{ when(c.reversedAt) }}:
                        {{ c.reverseReason }}</span
                      >
                    }
                  </span>
                  @if (!c.reversalPostingId && acts().reverse) {
                    <button
                      type="button"
                      class="link"
                      [attr.aria-label]="'Estornar a confirmação ' + c.seq"
                      (click)="openReason('reverse', c.id)"
                    >
                      Estornar
                    </button>
                  }
                </li>
              }
            </ul>
          </section>
        }
        <section class="card" aria-labelledby="df-hist">
          <h2 id="df-hist" class="mb-3 font-semibold">Histórico</h2>
          <app-audit-history
            entityType="stock_document"
            [entityId]="x.id"
            [refreshKey]="x.version"
          />
        </section>
      }
    </app-entity-form-page>

    <app-modal title="Conferência" [open]="checkOpen()" (closed)="checkOpen.set(false)">
      <p class="mb-3 text-sm text-muted">
        Indique o que foi contado. Menos do que falta fica para outra ronda (ou fecha-se o saldo).
      </p>
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <div class="space-y-3">
        @for (l of pending(); track l.id) {
          <div class="grid gap-2 sm:grid-cols-2" [attr.data-testid]="'ck-' + l.product.sku">
            <app-field
              [label]="
                (l.variant?.sku ?? l.product.sku) +
                ' — falta ' +
                q(l.remainingQuantity) +
                ' ' +
                l.uom.code
              "
              [hint]="l.trackSerials ? 'Com séries: 0 ou tudo.' : null"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                data-testid="ck-qty"
                [(ngModel)]="checked[l.id]"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
            <app-field label="Motivo da diferença">
              <input
                appControl
                class="input"
                maxlength="200"
                data-testid="ck-reason"
                [(ngModel)]="reasons[l.id]"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
          </div>
        }
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="checkOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ck-save"
          [disabled]="act.busy()"
          (click)="saveCheck()"
        >
          Registar conferência
        </button>
      </ng-container>
    </app-modal>

    <app-modal [title]="reasonTitle()" [open]="reasonOpen()" (closed)="reasonOpen.set(false)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <input
          appControl
          class="input"
          maxlength="300"
          data-testid="rs-reason"
          [(ngModel)]="reasonText"
          [ngModelOptions]="{ standalone: true }"
        />
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="reasonOpen.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rs-save"
          [disabled]="act.busy()"
          (click)="saveReason()"
        >
          {{ reasonTitle() }}
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class StockDocumentFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  readonly tipo = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly d = signal<StockDocument | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly warehouses = signal<Warehouse[]>([]);
  protected readonly locations = signal<WarehouseLocation[]>([]);
  protected readonly products = signal<{ id: string; sku: string; name: string }[]>([]);
  private readonly details = signal<Record<string, Product>>({});
  protected readonly action = new Action();
  protected readonly act = new Action();
  protected readonly checkOpen = signal(false);
  protected readonly reasonOpen = signal(false);
  private readonly reasonKind = signal<'close' | 'cancel' | 'reverse'>('close');
  private reasonTarget = '';
  private confirmKey = '';
  protected reasonText = '';
  protected checked: Record<string, string> = {};
  protected reasons: Record<string, string> = {};
  protected readonly maxDate = today();
  protected readonly buckets = Object.entries(LINE_BUCKET);
  protected f = this.emptyForm('RECEIPT');
  private initial = snapshot(this.f);
  protected readonly q = qty;
  protected readonly when = formatDateTime;
  protected readonly date = formatDate;
  protected readonly tone = statusTone;
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected readonly type = computed<DocType>(
    () => this.d()?.docType ?? (this.tipo() === 'ISSUE' ? 'ISSUE' : 'RECEIPT'),
  );
  protected readonly editable = computed(
    () => this.isNew() || (this.d()?.status === 'DRAFT' && !!this.d()?.can?.manage),
  );
  protected readonly acts = computed(() =>
    this.d() ? docActions(this.d()!) : docActions({ status: 'CANCELLED' }),
  );
  protected readonly origins = computed(() => ORIGINS[this.type()]);
  protected readonly operable = computed(() =>
    this.warehouses().filter((w) => w.access?.operate || w.id === this.f.warehouseId),
  );
  protected readonly currency = computed(() => this.d()?.currency ?? null);
  protected readonly pending = computed(() =>
    (this.d()?.lines ?? []).filter((l) => l.remainingQuantity !== '0.000000'),
  );
  protected readonly title = computed(() => {
    const x = this.d();
    if (!x) return `Nova ${DOC_TYPE[this.type()].toLowerCase()}`;
    return `${DOC_TYPE[x.docType]} ${x.number ?? '(rascunho)'}`;
  });
  protected readonly subtitle = computed(() => {
    const x = this.d();
    return x
      ? `${x.warehouse.code} · ${formatDate(x.documentDate)} · ${ORIGIN[x.origin] ?? x.origin}`
      : 'O stock só muda quando o documento é conferido e confirmado.';
  });
  protected readonly reasonTitle = computed(
    () =>
      ({ close: 'Fechar saldo', cancel: 'Anular documento', reverse: 'Estornar confirmação' })[
        this.reasonKind()
      ],
  );

  constructor() {
    warnOnUnload(this);
    this.api.get<Warehouse[]>('inventory/warehouses', { limit: 200, status: 'ACTIVE' }).then(
      (w) => this.warehouses.set(w),
      () => undefined,
    );
    this.api
      .get<{ id: string; sku: string; name: string }[]>('inventory/products', {
        limit: 200,
        productType: 'STOCKABLE',
      })
      .then(
        (p) => this.products.set(p),
        () => undefined,
      );
    effect(() => {
      this.id();
      this.tipo();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.editable() && snapshot(this.f) !== this.initial;
  }

  private emptyForm(type: DocType) {
    return {
      warehouseId: '',
      documentDate: today(),
      origin: ORIGINS[type][0],
      originRef: '',
      counterparty: '',
      notes: '',
      lines: [emptyLine()] as LineForm[],
    };
  }

  protected statusLabel(s: StockDocument['status']) {
    return DOC_STATUS[s];
  }
  protected originLabel(o: string) {
    return ORIGIN[o] ?? o;
  }
  protected bucketLabel(b: string) {
    return LINE_BUCKET[b] ?? b;
  }

  protected detail(productId: string): Product | null {
    return productId ? (this.details()[productId] ?? null) : null;
  }

  protected uomsOf(p: Product) {
    return [
      { id: p.baseUom.id, label: `${p.baseUom.code} (base)`, factor: '1' },
      ...(p.conversions ?? []).map((c) => ({
        id: c.uomId,
        label: `${c.uomCode} (= ${qty(c.factor)} ${p.baseUom.code})`,
        factor: c.factor,
      })),
    ];
  }

  protected baseHint(l: LineForm, p: Product) {
    const u = this.uomsOf(p).find((x) => x.id === l.uomId);
    if (!u || u.factor === '1') return null;
    const b = basePreview(l.quantity, u.factor);
    return b ? `= ${b} ${p.baseUom.code}` : null;
  }

  protected lineError(i: number, field: string) {
    return this.action.field(`lines.${i}.${field}`);
  }

  private async ensureDetail(productId: string) {
    if (!productId || this.details()[productId]) return;
    try {
      const p = await this.api.get<Product>(`inventory/products/${productId}`);
      this.details.update((m) => ({ ...m, [productId]: p }));
    } catch {
      /* o servidor valida a linha ao gravar */
    }
  }

  protected async productChanged(l: LineForm) {
    l.variantId = '';
    l.uomId = '';
    await this.ensureDetail(l.productId);
    const p = this.detail(l.productId);
    if (p) {
      const preferred = this.type() === 'RECEIPT' ? p.purchaseUom : p.saleUom;
      l.uomId = preferred?.id ?? p.baseUom.id;
    }
  }

  protected async warehouseChanged() {
    this.f.lines.forEach((l) => (l.locationId = ''));
    await this.loadLocations(this.f.warehouseId);
  }

  private async loadLocations(warehouseId: string) {
    if (!warehouseId) return this.locations.set([]);
    try {
      const w = await this.api.get<Warehouse>(`inventory/warehouses/${warehouseId}`);
      this.locations.set((w.locations ?? []).filter((l) => l.holdsStock && l.status === 'ACTIVE'));
    } catch {
      this.locations.set([]);
    }
  }

  protected addLine() {
    this.f.lines = [...this.f.lines, emptyLine()];
  }

  protected removeLine(i: number) {
    this.f.lines = this.f.lines.filter((_, j) => j !== i);
  }

  protected async load() {
    this.loadError.set(null);
    this.action.error.set(null);
    if (this.isNew()) {
      this.d.set(null);
      this.f = this.emptyForm(this.type());
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const x = await this.api.get<StockDocument>(`inventory/documents/${this.id()}`);
      await this.apply(x);
      this.breadcrumbs.setCurrent(x.number ?? 'Rascunho');
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async apply(x: StockDocument) {
    this.d.set(x);
    this.f = {
      warehouseId: x.warehouse.id,
      documentDate: x.documentDate,
      origin: x.origin,
      originRef: x.originRef ?? '',
      counterparty: x.counterparty ?? '',
      notes: x.notes ?? '',
      lines: (x.lines ?? []).map((l: DocLine) => ({
        productId: l.product.id,
        variantId: l.variant?.id ?? '',
        uomId: l.uom.id,
        quantity: l.quantity.replace(/\.?0+$/, ''),
        locationId: l.location?.id ?? '',
        bucket: l.bucket,
        lotCode: l.lotCode ?? '',
        serials: l.serials.join('\n'),
        expiryDate: l.expiryDate ?? '',
        unitCost: l.unitCost ? l.unitCost.replace(/\.?0+$/, '') : '',
      })),
    };
    this.initial = snapshot(this.f);
    if (x.status === 'DRAFT') {
      await Promise.all([
        this.loadLocations(x.warehouse.id),
        ...[...new Set(this.f.lines.map((l) => l.productId))].map((p) => this.ensureDetail(p)),
      ]);
    }
  }

  private body() {
    const f = this.f;
    return {
      documentDate: f.documentDate,
      origin: f.origin,
      originRef: f.originRef.trim() || null,
      counterparty: f.counterparty.trim() || null,
      notes: f.notes.trim() || null,
      lines: f.lines.map((l) => ({
        productId: l.productId || null,
        variantId: l.variantId || null,
        uomId: l.uomId || null,
        quantity: l.quantity.trim().replace(',', '.'),
        locationId: l.locationId || null,
        bucket: l.bucket,
        lotCode: l.lotCode.trim() || null,
        serials: parseSerials(l.serials),
        expiryDate: l.expiryDate || null,
        unitCost: l.unitCost.trim() ? l.unitCost.trim().replace(',', '.') : null,
      })),
    };
  }

  protected async save() {
    const x = this.d();
    const r = await this.action.run(() =>
      x
        ? this.api.put<StockDocument>(`inventory/documents/${x.id}`, {
            ...this.body(),
            expectedVersion: x.version,
          })
        : this.api.post<StockDocument>('inventory/documents', {
            ...this.body(),
            docType: this.type(),
            warehouseId: this.f.warehouseId || null,
          }),
    );
    if (!r) return;
    await this.apply(r);
    this.toasts.show(
      x ? 'Rascunho guardado.' : 'Rascunho criado: confira e confirme para movimentar.',
    );
    if (!x) await this.router.navigate(['/inventario/documentos', r.id], { replaceUrl: true });
  }

  protected back() {
    void this.router.navigate(['/inventario/documentos']);
  }

  protected openCheck() {
    this.act.error.set(null);
    this.checked = checkDefaults(this.pending());
    this.reasons = {};
    this.checkOpen.set(true);
  }

  protected async saveCheck() {
    const x = this.d()!;
    const r = await this.act.run(() =>
      this.api.post<StockDocument>(`inventory/documents/${x.id}/check`, {
        expectedVersion: x.version,
        lines: this.pending().map((l) => ({
          lineId: l.id,
          checkedQuantity: (this.checked[l.id] ?? '0').trim().replace(',', '.') || '0',
          differenceReason: this.reasons[l.id]?.trim() || null,
        })),
      }),
    );
    if (!r) return;
    this.checkOpen.set(false);
    this.confirmKey = newKey('confirm');
    await this.apply(r);
    this.toasts.show('Conferência registada.');
  }

  protected async reopen() {
    const x = this.d()!;
    const r = await this.act.run(() =>
      this.api.post<StockDocument>(`inventory/documents/${x.id}/reopen`, {
        expectedVersion: x.version,
      }),
    );
    if (r) await this.apply(r);
    else this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
  }

  protected async confirm() {
    const x = this.d()!;
    const ok = await this.confirmSvc.ask({
      title: 'Confirmar e movimentar stock',
      message: `As quantidades conferidas ${x.docType === 'RECEIPT' ? 'entram' : 'saem'} do stock de ${x.warehouse.code}. Um engano corrige-se depois com um estorno.`,
      confirmLabel: 'Confirmar',
    });
    if (!ok) return;
    // A mesma chave enquanto a ronda conferida não muda: repetir (ex.: rede) não lança duas vezes.
    if (!this.confirmKey) this.confirmKey = newKey('confirm');
    const r = await this.act.run(() =>
      this.api.post<StockDocument>(`inventory/documents/${x.id}/confirm`, {
        expectedVersion: x.version,
        idempotencyKey: this.confirmKey,
      }),
    );
    if (!r) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível confirmar.', 'error');
      return;
    }
    this.confirmKey = '';
    await this.apply(r);
    this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
    this.toasts.show(
      r.status === 'COMPLETED' ? 'Confirmado: documento concluído.' : 'Confirmado: falta parte.',
    );
  }

  protected openReason(kind: 'close' | 'cancel' | 'reverse', target = '') {
    this.act.error.set(null);
    this.reasonKind.set(kind);
    this.reasonTarget = target;
    this.reasonText = '';
    this.confirmKey = kind === 'reverse' ? newKey('reverse') : this.confirmKey;
    this.reasonOpen.set(true);
  }

  protected async saveReason() {
    const x = this.d()!;
    const reason = this.reasonText.trim();
    const kind = this.reasonKind();
    const r = await this.act.run(() =>
      kind === 'reverse'
        ? this.api.post<StockDocument>(
            `inventory/document-confirmations/${this.reasonTarget}/reverse`,
            {
              reason,
              idempotencyKey: this.confirmKey,
            },
          )
        : this.api.post<StockDocument>(`inventory/documents/${x.id}/${kind}`, {
            reason,
            expectedVersion: x.version,
          }),
    );
    if (!r) return;
    this.reasonOpen.set(false);
    if (kind === 'reverse') this.confirmKey = '';
    await this.apply(r);
    this.toasts.show(
      { close: 'Saldo fechado.', cancel: 'Documento anulado.', reverse: 'Confirmação estornada.' }[
        kind
      ],
    );
  }
}
