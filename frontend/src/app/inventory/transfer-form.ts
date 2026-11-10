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
import { LINE_BUCKET, parseSerials } from './stock-document-model';
import { newKey, qty } from './stock-model';
import {
  EVENT_KIND,
  pickDefaults,
  receiveDefaults,
  type Transfer,
  TRANSFER_STATUS,
  transferActions,
  transferTone,
} from './transfer-model';
import type { Warehouse, WarehouseLocation } from './warehouse-model';

interface Dest {
  id: string;
  code: string;
  name: string;
  legalEntityId: string;
  legalEntityCode: string;
}
interface LineForm {
  productId: string;
  variantId: string;
  quantity: string;
  sourceLocationId: string;
  sourceBucket: string;
  destLocationId: string;
  lotCode: string;
  serials: string;
}
const emptyLine = (): LineForm => ({
  productId: '',
  variantId: '',
  quantity: '',
  sourceLocationId: '',
  sourceBucket: 'UNRESTRICTED',
  destLocationId: '',
  lotCode: '',
  serials: '',
});
const today = () => new Date().toISOString().slice(0, 10);
type ModalKind = 'pick' | 'dispatch' | 'receive' | 'reject' | 'close' | 'cancel';

/**
 * Transferência (8.5): rascunho editável; depois o ciclo pedido → aprovação (e aceitação do destino se intragrupo) →
 * separação → expedição → recepção (parcial) ou fecho de perdas. Cada passo é autorizado pela API no armazém respectivo.
 */
@Component({
  selector: 'app-transfer-form',
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
      formId="transfer-form"
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
      @if (t(); as x) {
        <div class="card space-y-3" data-testid="trf-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(x.status)" data-testid="trf-status">{{
              statusLabel(x.status)
            }}</span>
            @if (x.intercompany) {
              <span class="badge bg-info-soft text-info-text"
                >Intragrupo {{ x.source.legalEntity?.code }} → {{ x.dest.legalEntity?.code }}</span
              >
            }
            @if (x.rejectReason) {
              <span class="text-sm text-muted">Rejeitada: {{ x.rejectReason }}</span>
            }
            @if (x.cancelReason) {
              <span class="text-sm text-muted">Anulada: {{ x.cancelReason }}</span>
            }
            @if (x.closeReason) {
              <span class="text-sm text-muted">Perda em trânsito: {{ x.closeReason }}</span>
            }
            <span class="ml-auto flex flex-wrap gap-2">
              @if (acts().submit) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="trf-submit"
                  [disabled]="act.busy()"
                  (click)="simple('submit')"
                >
                  Pedir aprovação
                </button>
              }
              @if (acts().approve) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="trf-approve"
                  [disabled]="act.busy()"
                  (click)="simple('approve')"
                >
                  Aprovar
                </button>
              }
              @if (acts().accept) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="trf-accept"
                  [disabled]="act.busy()"
                  (click)="simple('accept')"
                >
                  Aceitar (destino)
                </button>
              }
              @if (acts().reject) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="trf-reject"
                  [disabled]="act.busy()"
                  (click)="open('reject')"
                >
                  Rejeitar
                </button>
              }
              @if (acts().pick) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="trf-pick"
                  [disabled]="act.busy()"
                  (click)="open('pick')"
                >
                  Separar
                </button>
              }
              @if (acts().dispatch) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="trf-dispatch"
                  [disabled]="act.busy()"
                  (click)="open('dispatch')"
                >
                  Expedir
                </button>
              }
              @if (acts().receive) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="trf-receive"
                  [disabled]="act.busy()"
                  (click)="open('receive')"
                >
                  Receber
                </button>
              }
              @if (acts().close) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="trf-close"
                  [disabled]="act.busy()"
                  (click)="open('close')"
                >
                  Fechar perdas
                </button>
              }
              @if (acts().cancel) {
                <button
                  type="button"
                  class="btn-danger"
                  data-testid="trf-cancel"
                  [disabled]="act.busy()"
                  (click)="open('cancel')"
                >
                  Anular
                </button>
              }
            </span>
          </div>
          <ol class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted" data-testid="trf-steps">
            @for (s of steps(); track s.label) {
              <li [class.text-success-text]="s.done">
                {{ s.done ? '✓' : '○' }} {{ s.label }}{{ s.detail ? ' · ' + s.detail : '' }}
              </li>
            }
          </ol>
        </div>
      }

      <app-form-section
        title="Transferência"
        description="Origem e destino. Entre entidades legais diferentes é intragrupo: o destino aceita e indica-se o documento comercial."
      >
        <app-field
          label="Armazém de origem"
          [required]="true"
          [error]="action.field('sourceWarehouseId')"
        >
          <select
            appControl
            class="input"
            name="src"
            data-testid="tf-source"
            [(ngModel)]="f.sourceWarehouseId"
            [disabled]="!isNew()"
            (ngModelChange)="sourceChanged()"
          >
            <option value="">—</option>
            @for (w of sources(); track w.id) {
              <option [value]="w.id">{{ w.code }} — {{ w.name }} ({{ w.legalEntity.code }})</option>
            }
          </select>
        </app-field>
        <app-field
          label="Armazém de destino"
          [required]="true"
          [error]="action.field('destWarehouseId')"
        >
          <select
            appControl
            class="input"
            name="dst"
            data-testid="tf-dest"
            [(ngModel)]="f.destWarehouseId"
            [disabled]="!isNew()"
            (ngModelChange)="destChanged()"
          >
            <option value="">—</option>
            @for (w of destinations(); track w.id) {
              @if (w.id !== f.sourceWarehouseId) {
                <option [value]="w.id">
                  {{ w.code }} — {{ w.name }} ({{ w.legalEntityCode }})
                </option>
              }
            }
          </select>
        </app-field>
        <app-field label="Data do pedido" [required]="true" [error]="action.field('requestedDate')">
          <input
            appControl
            type="date"
            class="input"
            name="rd"
            [max]="maxDate"
            [(ngModel)]="f.requestedDate"
            [disabled]="!editable()"
          />
        </app-field>
        <app-field label="Chegada prevista" [error]="action.field('expectedDate')">
          <input
            appControl
            type="date"
            class="input"
            name="ed"
            [(ngModel)]="f.expectedDate"
            [disabled]="!editable()"
          />
        </app-field>
        @if (intercompany()) {
          <app-field
            label="Documento comercial intragrupo"
            hint="Obrigatório antes da expedição (ex.: factura ou guia intragrupo)."
            [error]="action.field('intercompanyRef')"
          >
            <input
              appControl
              class="input"
              name="ic"
              maxlength="60"
              data-testid="tf-icref"
              [(ngModel)]="f.intercompanyRef"
              [disabled]="!editable()"
            />
          </app-field>
        }
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
        <section class="card" aria-labelledby="tf-lines-h">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="tf-lines-h" class="font-semibold">Linhas ({{ f.lines.length }})</h2>
            <button
              type="button"
              class="btn-secondary"
              data-testid="tf-add-line"
              (click)="addLine()"
            >
              + Linha
            </button>
          </div>
          <div class="space-y-4">
            @for (l of f.lines; track $index; let i = $index) {
              <fieldset
                class="rounded-md border border-border p-3"
                [attr.data-testid]="'tf-line-' + i"
              >
                <legend class="px-1 text-sm font-medium">Linha {{ i + 1 }}</legend>
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <app-field label="Produto" [required]="true" [error]="lineError(i, 'productId')">
                    <select
                      appControl
                      class="input"
                      [name]="'p' + i"
                      data-testid="tl-product"
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
                        <select appControl class="input" [name]="'v' + i" [(ngModel)]="l.variantId">
                          <option value="">—</option>
                          @for (v of p.variants ?? []; track v.id) {
                            <option [value]="v.id">{{ v.sku }}</option>
                          }
                        </select>
                      </app-field>
                    }
                    <app-field
                      [label]="'Quantidade (' + p.baseUom.code + ')'"
                      [required]="true"
                      [error]="lineError(i, 'quantity')"
                    >
                      <input
                        appControl
                        class="input"
                        inputmode="decimal"
                        [name]="'q' + i"
                        data-testid="tl-qty"
                        [(ngModel)]="l.quantity"
                      />
                    </app-field>
                    <app-field
                      label="Sai de (localização)"
                      [error]="lineError(i, 'sourceLocationId')"
                    >
                      <select
                        appControl
                        class="input"
                        [name]="'sl' + i"
                        data-testid="tl-src-loc"
                        [(ngModel)]="l.sourceLocationId"
                      >
                        <option value="">— (sem posição)</option>
                        @for (loc of sourceLocations(); track loc.id) {
                          <option [value]="loc.id">{{ loc.pathCode }}</option>
                        }
                      </select>
                    </app-field>
                    <app-field label="Estado do stock" [error]="lineError(i, 'sourceBucket')">
                      <select
                        appControl
                        class="input"
                        [name]="'b' + i"
                        data-testid="tl-bucket"
                        [(ngModel)]="l.sourceBucket"
                      >
                        @for (b of buckets; track b[0]) {
                          <option [value]="b[0]">{{ b[1] }}</option>
                        }
                      </select>
                    </app-field>
                    <app-field
                      label="Entra em (localização)"
                      hint="Pode ser escolhida na recepção."
                      [error]="lineError(i, 'destLocationId')"
                    >
                      <select
                        appControl
                        class="input"
                        [name]="'dl' + i"
                        data-testid="tl-dst-loc"
                        [(ngModel)]="l.destLocationId"
                      >
                        <option value="">— (decide-se na recepção)</option>
                        @for (loc of destLocations(); track loc.id) {
                          <option [value]="loc.id">{{ loc.pathCode }}</option>
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
                          [(ngModel)]="l.lotCode"
                        />
                      </app-field>
                    }
                    @if (p.trackSerials) {
                      <div class="sm:col-span-2 lg:col-span-4">
                        <app-field
                          label="Números de série"
                          [required]="true"
                          hint="Um por unidade, por linha ou separados por vírgulas."
                          [error]="lineError(i, 'serials')"
                        >
                          <textarea
                            appControl
                            class="input"
                            rows="2"
                            [name]="'s' + i"
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
      } @else if (t(); as x) {
        <section class="card" aria-labelledby="tf-ro">
          <h2 id="tf-ro" class="mb-3 font-semibold">Linhas</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="trf-lines">
              <thead>
                <tr class="border-b border-border text-left text-muted">
                  <th class="py-2 pr-3">Produto</th>
                  <th class="py-2 pr-3 text-right">Pedido</th>
                  <th class="py-2 pr-3 text-right">Separado</th>
                  <th class="py-2 pr-3 text-right">Expedido</th>
                  <th class="py-2 pr-3 text-right">Recebido</th>
                  <th class="py-2 pr-3 text-right">Em trânsito</th>
                  <th class="py-2 text-right">Perdido</th>
                </tr>
              </thead>
              <tbody>
                @for (l of x.lines ?? []; track l.id) {
                  <tr class="border-b border-border align-top">
                    <td class="py-2 pr-3">
                      <span class="font-medium">{{ l.variant?.sku ?? l.product.sku }}</span>
                      <span class="block text-xs text-muted">
                        {{ l.product.name }} · {{ bucketLabel(l.sourceBucket) }} ·
                        {{ l.sourceLocation?.pathCode ?? '—' }} →
                        {{ l.destLocation?.pathCode ?? '—'
                        }}{{ l.lotCode ? ' · lote ' + l.lotCode : '' }}
                      </span>
                    </td>
                    <td class="py-2 pr-3 text-right">{{ q(l.quantity) }} {{ l.uom }}</td>
                    <td class="py-2 pr-3 text-right">
                      {{ l.pickedQuantity === null ? '—' : q(l.pickedQuantity) }}
                    </td>
                    <td class="py-2 pr-3 text-right">{{ q(l.shippedQuantity) }}</td>
                    <td class="py-2 pr-3 text-right">{{ q(l.receivedQuantity) }}</td>
                    <td class="py-2 pr-3 text-right">{{ q(l.inTransitQuantity) }}</td>
                    <td class="py-2 text-right">{{ q(l.lostQuantity) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (t(); as x) {
        @if ((x.events ?? []).length) {
          <section class="card" aria-labelledby="tf-ev" data-testid="trf-events">
            <h2 id="tf-ev" class="mb-3 font-semibold">Movimentos de stock</h2>
            <ul class="divide-y divide-border text-sm">
              @for (e of x.events ?? []; track e.id) {
                <li class="py-1.5">
                  {{ eventLabel(e.kind) }} · {{ when(e.createdAt) }} · {{ e.createdBy }} ·
                  {{ e.lineCount }} linha(s){{ e.reason ? ' · ' + e.reason : '' }}
                </li>
              }
            </ul>
          </section>
        }
        <section class="card" aria-labelledby="tf-hist">
          <h2 id="tf-hist" class="mb-3 font-semibold">Histórico</h2>
          <app-audit-history
            entityType="stock_transfer"
            [entityId]="x.id"
            [refreshKey]="x.version"
          />
        </section>
      }
    </app-entity-form-page>

    <app-modal [title]="modalTitle()" [open]="modal() !== null" (closed)="modal.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      @switch (modal()) {
        @case ('pick') {
          <p class="mb-3 text-sm text-muted">
            Quantidades efectivamente separadas na origem (menos do que o pedido é permitido; a
            reserva do resto é libertada na expedição).
          </p>
          @for (l of t()?.lines ?? []; track l.id) {
            <app-field
              [label]="
                (l.variant?.sku ?? l.product.sku) + ' — pedido ' + q(l.quantity) + ' ' + l.uom
              "
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                data-testid="pk-qty"
                [(ngModel)]="qtys[l.id]"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
          }
        }
        @case ('dispatch') {
          <div class="space-y-3">
            <app-field label="Transportador">
              <input
                appControl
                class="input"
                maxlength="120"
                data-testid="dp-carrier"
                [(ngModel)]="extra.carrier"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
            <app-field label="Guia / seguimento">
              <input
                appControl
                class="input"
                maxlength="60"
                data-testid="dp-tracking"
                [(ngModel)]="extra.trackingRef"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
            @if (t()?.intercompany) {
              <app-field
                label="Documento comercial intragrupo"
                [required]="true"
                [error]="act.field('intercompanyRef')"
              >
                <input
                  appControl
                  class="input"
                  maxlength="60"
                  data-testid="dp-icref"
                  [(ngModel)]="extra.intercompanyRef"
                  [ngModelOptions]="{ standalone: true }"
                />
              </app-field>
            }
          </div>
        }
        @case ('receive') {
          <p class="mb-3 text-sm text-muted">
            O que chegou. Menos do que está em trânsito fica para outra recepção (ou fecha-se como
            perda).
          </p>
          @for (l of inTransit(); track l.id) {
            <div class="grid gap-2 sm:grid-cols-2" [attr.data-testid]="'rc-' + l.product.sku">
              <app-field
                [label]="
                  (l.variant?.sku ?? l.product.sku) +
                  ' — em trânsito ' +
                  q(l.inTransitQuantity) +
                  ' ' +
                  l.uom
                "
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  data-testid="rc-qty"
                  [(ngModel)]="qtys[l.id]"
                  [ngModelOptions]="{ standalone: true }"
                />
              </app-field>
              <app-field label="Localização">
                <select
                  appControl
                  class="input"
                  data-testid="rc-loc"
                  [(ngModel)]="locs[l.id]"
                  [ngModelOptions]="{ standalone: true }"
                >
                  <option value="">{{ l.destLocation?.pathCode ?? '— (sem posição)' }}</option>
                  @for (loc of destLocations(); track loc.id) {
                    <option [value]="loc.id">{{ loc.pathCode }}</option>
                  }
                </select>
              </app-field>
            </div>
          }
        }
        @default {
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <input
              appControl
              class="input"
              maxlength="300"
              data-testid="tr-reason"
              [(ngModel)]="extra.reason"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
      }
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="modal.set(null)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tr-save"
          [disabled]="act.busy()"
          (click)="saveModal()"
        >
          {{ modalTitle() }}
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class TransferFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly t = signal<Transfer | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly warehouses = signal<Warehouse[]>([]);
  protected readonly destinations = signal<Dest[]>([]);
  protected readonly sourceLocations = signal<WarehouseLocation[]>([]);
  protected readonly destLocations = signal<WarehouseLocation[]>([]);
  protected readonly products = signal<{ id: string; sku: string; name: string }[]>([]);
  private readonly details = signal<Record<string, Product>>({});
  protected readonly action = new Action();
  protected readonly act = new Action();
  protected readonly modal = signal<ModalKind | null>(null);
  protected qtys: Record<string, string> = {};
  protected locs: Record<string, string> = {};
  protected extra = { carrier: '', trackingRef: '', intercompanyRef: '', reason: '' };
  private stepKey = '';
  protected readonly maxDate = today();
  protected readonly buckets = Object.entries(LINE_BUCKET);
  protected f = this.emptyForm();
  private initial = snapshot(this.f);
  protected readonly q = qty;
  protected readonly when = formatDateTime;
  protected readonly tone = transferTone;
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly editable = computed(
    () => this.isNew() || (this.t()?.status === 'DRAFT' && !!this.t()?.can?.manageSource),
  );
  protected readonly acts = computed(() =>
    this.t()
      ? transferActions(this.t()!)
      : transferActions({ status: 'CANCELLED', intercompany: false }),
  );
  protected readonly sources = computed(() =>
    this.warehouses().filter((w) => w.access?.operate && w.status === 'ACTIVE'),
  );
  private readonly formTick = signal(0);
  protected readonly intercompany = computed(() => {
    this.formTick();
    const x = this.t();
    if (x) return x.intercompany;
    const src = this.warehouses().find((w) => w.id === this.f.sourceWarehouseId);
    const dst = this.destinations().find((w) => w.id === this.f.destWarehouseId);
    return !!src && !!dst && src.legalEntity.id !== dst.legalEntityId;
  });
  protected readonly inTransit = computed(() =>
    (this.t()?.lines ?? []).filter((l) => l.inTransitQuantity !== '0.000000'),
  );
  protected readonly title = computed(() => {
    const x = this.t();
    return x ? `Transferência ${x.number ?? '(por aprovar)'}` : 'Nova transferência';
  });
  protected readonly subtitle = computed(() => {
    const x = this.t();
    return x
      ? `${x.source.warehouse.code} → ${x.dest.warehouse.code} · ${formatDate(x.requestedDate)}`
      : 'Nada sai do stock até à expedição; a aprovação reserva na origem.';
  });
  protected readonly steps = computed(() => {
    const x = this.t();
    if (!x) return [];
    const by = (s?: { by: string | null; at: string } | null) =>
      s ? `${s.by ?? ''} ${formatDate(s.at)}` : null;
    const list = [
      { label: 'Pedida', done: !!x.submitted, detail: by(x.submitted) },
      { label: 'Aprovada (origem)', done: !!x.approved, detail: by(x.approved) },
    ];
    if (x.intercompany)
      list.push({ label: 'Aceite (destino)', done: !!x.accepted, detail: by(x.accepted) });
    list.push(
      { label: 'Separada', done: !!x.picked, detail: by(x.picked) },
      { label: 'Expedida', done: !!x.dispatched, detail: by(x.dispatched) },
      { label: 'Recebida', done: x.status === 'RECEIVED', detail: null },
    );
    return list;
  });
  protected readonly modalTitle = computed(
    () =>
      ({
        pick: 'Registar separação',
        dispatch: 'Expedir',
        receive: 'Registar recepção',
        reject: 'Rejeitar',
        close: 'Fechar como perda',
        cancel: 'Anular transferência',
      })[this.modal() ?? 'cancel'],
  );

  constructor() {
    warnOnUnload(this);
    this.api.get<Warehouse[]>('inventory/warehouses', { limit: 200 }).then(
      (w) => this.warehouses.set(w),
      () => undefined,
    );
    this.api.get<Dest[]>('inventory/transfers/destinations').then(
      (d) => this.destinations.set(d),
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
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.editable() && snapshot(this.f) !== this.initial;
  }

  private emptyForm() {
    return {
      sourceWarehouseId: '',
      destWarehouseId: '',
      requestedDate: today(),
      expectedDate: '',
      intercompanyRef: '',
      notes: '',
      lines: [emptyLine()] as LineForm[],
    };
  }

  protected statusLabel(s: Transfer['status']) {
    return TRANSFER_STATUS[s];
  }
  protected bucketLabel(b: string) {
    return LINE_BUCKET[b] ?? b;
  }
  protected eventLabel(k: string) {
    return EVENT_KIND[k] ?? k;
  }
  protected detail(id: string): Product | null {
    return id ? (this.details()[id] ?? null) : null;
  }
  protected lineError(i: number, field: string) {
    return this.action.field(`lines.${i}.${field}`);
  }

  private async locationsOf(id: string) {
    if (!id) return [];
    try {
      const w = await this.api.get<Warehouse>(`inventory/warehouses/${id}`);
      return (w.locations ?? []).filter((l) => l.holdsStock && l.status === 'ACTIVE');
    } catch {
      return []; // Armazém de destino de outra entidade sem acesso de consulta: escolhe-se na recepção.
    }
  }

  protected async sourceChanged() {
    this.formTick.update((n) => n + 1);
    this.f.lines.forEach((l) => (l.sourceLocationId = ''));
    this.sourceLocations.set(await this.locationsOf(this.f.sourceWarehouseId));
  }

  protected async destChanged() {
    this.formTick.update((n) => n + 1);
    this.f.lines.forEach((l) => (l.destLocationId = ''));
    this.destLocations.set(await this.locationsOf(this.f.destWarehouseId));
  }

  protected async productChanged(l: LineForm) {
    l.variantId = '';
    if (!l.productId || this.details()[l.productId]) return;
    try {
      const p = await this.api.get<Product>(`inventory/products/${l.productId}`);
      this.details.update((m) => ({ ...m, [l.productId]: p }));
    } catch {
      /* validado no servidor */
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
      this.t.set(null);
      this.f = this.emptyForm();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const x = await this.api.get<Transfer>(`inventory/transfers/${this.id()}`);
      await this.apply(x);
      this.breadcrumbs.setCurrent(x.number ?? 'Por aprovar');
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async apply(x: Transfer) {
    this.t.set(x);
    this.f = {
      sourceWarehouseId: x.source.warehouse.id,
      destWarehouseId: x.dest.warehouse.id,
      requestedDate: x.requestedDate,
      expectedDate: x.expectedDate ?? '',
      intercompanyRef: x.intercompanyRef ?? '',
      notes: x.notes ?? '',
      lines: (x.lines ?? []).map((l) => ({
        productId: l.product.id,
        variantId: l.variant?.id ?? '',
        quantity: l.quantity.replace(/\.?0+$/, ''),
        sourceLocationId: l.sourceLocation?.id ?? '',
        sourceBucket: l.sourceBucket,
        destLocationId: l.destLocation?.id ?? '',
        lotCode: l.lotCode ?? '',
        serials: l.serials.join('\n'),
      })),
    };
    this.initial = snapshot(this.f);
    const [s, d] = await Promise.all([
      x.status === 'DRAFT' ? this.locationsOf(x.source.warehouse.id) : Promise.resolve([]),
      this.locationsOf(x.dest.warehouse.id),
    ]);
    this.sourceLocations.set(s);
    this.destLocations.set(d);
    if (x.status === 'DRAFT')
      for (const l of this.f.lines) if (l.productId) await this.productChanged({ ...l });
  }

  private body() {
    const f = this.f;
    return {
      requestedDate: f.requestedDate,
      expectedDate: f.expectedDate || null,
      intercompanyRef: f.intercompanyRef.trim() || null,
      notes: f.notes.trim() || null,
      lines: f.lines.map((l) => ({
        productId: l.productId || null,
        variantId: l.variantId || null,
        quantity: l.quantity.trim().replace(',', '.'),
        sourceLocationId: l.sourceLocationId || null,
        sourceBucket: l.sourceBucket,
        destLocationId: l.destLocationId || null,
        lotCode: l.lotCode.trim() || null,
        serials: parseSerials(l.serials),
      })),
    };
  }

  protected async save() {
    const x = this.t();
    const r = await this.action.run(() =>
      x
        ? this.api.put<Transfer>(`inventory/transfers/${x.id}`, {
            ...this.body(),
            expectedVersion: x.version,
          })
        : this.api.post<Transfer>('inventory/transfers', {
            ...this.body(),
            sourceWarehouseId: this.f.sourceWarehouseId || null,
            destWarehouseId: this.f.destWarehouseId || null,
          }),
    );
    if (!r) return;
    await this.apply(r);
    this.toasts.show(x ? 'Rascunho guardado.' : 'Rascunho criado: peça a aprovação.');
    if (!x) await this.router.navigate(['/inventario/transferencias', r.id], { replaceUrl: true });
  }

  protected back() {
    void this.router.navigate(['/inventario/transferencias']);
  }

  protected async simple(kind: 'submit' | 'approve' | 'accept') {
    const x = this.t()!;
    if (kind !== 'submit') {
      const ok = await this.confirmSvc.ask({
        title: kind === 'approve' ? 'Aprovar transferência' : 'Aceitar no destino',
        message:
          kind === 'approve' && !x.intercompany
            ? `As quantidades ficam reservadas em ${x.source.warehouse.code} e a transferência é numerada.`
            : 'Com a aprovação da origem e a aceitação do destino, as quantidades ficam reservadas na origem.',
        confirmLabel: kind === 'approve' ? 'Aprovar' : 'Aceitar',
      });
      if (!ok) return;
    }
    const r = await this.act.run(() =>
      this.api.post<Transfer>(`inventory/transfers/${x.id}/${kind}`, {
        expectedVersion: x.version,
      }),
    );
    if (!r) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    await this.apply(r);
    this.breadcrumbs.setCurrent(r.number ?? 'Por aprovar');
    this.toasts.show(
      { submit: 'Pedido enviado para aprovação.', approve: 'Aprovada.', accept: 'Aceite.' }[kind],
    );
  }

  protected open(kind: ModalKind) {
    const x = this.t()!;
    this.act.error.set(null);
    this.extra = {
      carrier: x.carrier ?? '',
      trackingRef: x.trackingRef ?? '',
      intercompanyRef: x.intercompanyRef ?? '',
      reason: '',
    };
    this.qtys =
      kind === 'pick'
        ? pickDefaults(x.lines ?? [])
        : kind === 'receive'
          ? receiveDefaults(x.lines ?? [])
          : {};
    this.locs = {};
    // Uma chave por abertura: repetir o envio (ex.: rede) não lança duas vezes.
    this.stepKey = newKey(kind);
    this.modal.set(kind);
  }

  protected async saveModal() {
    const x = this.t()!;
    const kind = this.modal()!;
    const v = { expectedVersion: x.version };
    const n = (s: string | undefined) => (s ?? '0').trim().replace(',', '.') || '0';
    const body: Record<string, unknown> =
      kind === 'pick'
        ? {
            ...v,
            lines: (x.lines ?? []).map((l) => ({
              lineId: l.id,
              pickedQuantity: n(this.qtys[l.id]),
            })),
          }
        : kind === 'dispatch'
          ? {
              ...v,
              idempotencyKey: this.stepKey,
              carrier: this.extra.carrier.trim() || null,
              trackingRef: this.extra.trackingRef.trim() || null,
              intercompanyRef: this.extra.intercompanyRef.trim() || null,
            }
          : kind === 'receive'
            ? {
                ...v,
                idempotencyKey: this.stepKey,
                lines: this.inTransit().map((l) => ({
                  lineId: l.id,
                  quantity: n(this.qtys[l.id]),
                  destLocationId: this.locs[l.id] || null,
                })),
              }
            : {
                ...v,
                reason: this.extra.reason.trim(),
                ...(kind === 'close' ? { idempotencyKey: this.stepKey } : {}),
              };
    const r = await this.act.run(() =>
      this.api.post<Transfer>(`inventory/transfers/${x.id}/${kind}`, body),
    );
    if (!r) return;
    this.modal.set(null);
    await this.apply(r);
    this.toasts.show(
      {
        pick: 'Separação registada.',
        dispatch: 'Expedida: em trânsito.',
        receive: r.status === 'RECEIVED' ? 'Recebida.' : 'Recepção registada: falta parte.',
        reject: 'Rejeitada.',
        close: 'Perda registada.',
        cancel: 'Anulada.',
      }[kind],
    );
  }
}
