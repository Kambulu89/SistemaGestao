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
import {
  issueDefaults,
  pickDefaults,
  type Requisition,
  REQUISITION_EVENT,
  REQUISITION_STATUS,
  requisitionActions,
  requisitionTone,
} from './requisition-model';
import { newKey, qty } from './stock-model';
import type { Warehouse, WarehouseLocation } from './warehouse-model';

interface Opt {
  id: string;
  code: string;
  name: string;
  legalEntityId: string;
}
interface Options {
  warehouses: (Opt & { legalEntityCode: string })[];
  departments: Opt[];
  costCenters: Opt[];
}
interface LineForm {
  productId: string;
  variantId: string;
  quantity: string;
  sourceLocationId: string;
}
const emptyLine = (): LineForm => ({
  productId: '',
  variantId: '',
  quantity: '',
  sourceLocationId: '',
});
type ModalKind = 'pick' | 'issue' | 'release' | 'reject' | 'cancel';

/**
 * Requisição interna (8.6): rascunho do departamento; depois pedido → aprovação (reserva) → separação → entrega
 * (consumo, em uma ou mais vezes, da localização escolhida por quem atende) ou libertação do resto. A API autoriza cada
 * passo; quem pede não aprova.
 */
@Component({
  selector: 'app-requisition-form',
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
      formId="requisition-form"
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
      @if (r(); as x) {
        <div class="card space-y-3" data-testid="rq-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(x.status)" data-testid="rq-status">{{
              statusLabel(x.status)
            }}</span>
            <span class="text-sm text-muted">Pedida por {{ x.requestedBy.name }}</span>
            @if (x.approved) {
              <span class="text-sm text-muted"
                >· aprovada por {{ x.approved.by }} {{ date(x.approved.at) }}</span
              >
            }
            @if (x.rejectReason) {
              <span class="text-sm text-muted">Rejeitada: {{ x.rejectReason }}</span>
            }
            @if (x.cancelReason) {
              <span class="text-sm text-muted">Anulada: {{ x.cancelReason }}</span>
            }
            @if (x.closeReason) {
              <span class="text-sm text-muted">Resto libertado: {{ x.closeReason }}</span>
            }
            <span class="ml-auto flex flex-wrap gap-2">
              @if (acts().submit) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="rq-submit"
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
                  data-testid="rq-approve"
                  [disabled]="act.busy()"
                  (click)="simple('approve')"
                >
                  Aprovar
                </button>
              }
              @if (acts().reject) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="rq-reject"
                  [disabled]="act.busy()"
                  (click)="start('reject')"
                >
                  Rejeitar
                </button>
              }
              @if (acts().pick) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="rq-pick"
                  [disabled]="act.busy()"
                  (click)="start('pick')"
                >
                  Separar
                </button>
              }
              @if (acts().issue) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="rq-issue"
                  [disabled]="act.busy()"
                  (click)="start('issue')"
                >
                  Entregar
                </button>
              }
              @if (acts().release) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="rq-release"
                  [disabled]="act.busy()"
                  (click)="start('release')"
                >
                  Libertar resto
                </button>
              }
              @if (acts().cancel) {
                <button
                  type="button"
                  class="btn-danger"
                  data-testid="rq-cancel"
                  [disabled]="act.busy()"
                  (click)="start('cancel')"
                >
                  Anular
                </button>
              }
            </span>
          </div>
        </div>
      }

      <app-form-section
        title="Requisição"
        description="Departamento que consome, armazém de onde sai e para que é preciso. O centro de custo leva o consumo à analítica."
      >
        <app-field label="Armazém" [required]="true" [error]="action.field('warehouseId')">
          <select
            appControl
            class="input"
            name="wh"
            data-testid="rf-warehouse"
            [(ngModel)]="f.warehouseId"
            [disabled]="!isNew()"
            (ngModelChange)="warehouseChanged()"
          >
            <option value="">—</option>
            @for (w of options().warehouses; track w.id) {
              <option [value]="w.id">{{ w.code }} — {{ w.name }} ({{ w.legalEntityCode }})</option>
            }
          </select>
        </app-field>
        <app-field label="Departamento" [required]="true" [error]="action.field('departmentId')">
          <select
            appControl
            class="input"
            name="dept"
            data-testid="rf-department"
            [(ngModel)]="f.departmentId"
            [disabled]="!editable()"
          >
            <option value="">—</option>
            @for (d of departments(); track d.id) {
              <option [value]="d.id">{{ d.code }} — {{ d.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Centro de custo" [error]="action.field('costCenterId')">
          <select
            appControl
            class="input"
            name="cc"
            data-testid="rf-cost-center"
            [(ngModel)]="f.costCenterId"
            [disabled]="!editable()"
          >
            <option value="">—</option>
            @for (c of costCenters(); track c.id) {
              <option [value]="c.id">{{ c.code }} — {{ c.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Precisa em" [error]="action.field('neededBy')">
          <input
            appControl
            type="date"
            class="input"
            name="nb"
            [(ngModel)]="f.neededBy"
            [disabled]="!editable()"
          />
        </app-field>
        <app-field label="Finalidade" [required]="true" [error]="action.field('purpose')">
          <input
            appControl
            class="input"
            name="purpose"
            maxlength="300"
            data-testid="rf-purpose"
            [(ngModel)]="f.purpose"
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
        <section class="card" aria-labelledby="rf-lines-h">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="rf-lines-h" class="font-semibold">Linhas ({{ f.lines.length }})</h2>
            <button
              type="button"
              class="btn-secondary"
              data-testid="rf-add-line"
              (click)="addLine()"
            >
              + Linha
            </button>
          </div>
          <div class="space-y-4">
            @for (l of f.lines; track $index; let i = $index) {
              <fieldset
                class="rounded-md border border-border p-3"
                [attr.data-testid]="'rf-line-' + i"
              >
                <legend class="px-1 text-sm font-medium">Linha {{ i + 1 }}</legend>
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <app-field label="Produto" [required]="true" [error]="lineError(i, 'productId')">
                    <select
                      appControl
                      class="input"
                      [name]="'p' + i"
                      data-testid="rl-product"
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
                        data-testid="rl-qty"
                        [(ngModel)]="l.quantity"
                      />
                    </app-field>
                    <app-field
                      label="Localização (opcional)"
                      hint="Quem atende pode escolher outra na entrega."
                      [error]="lineError(i, 'sourceLocationId')"
                    >
                      <select
                        appControl
                        class="input"
                        [name]="'l' + i"
                        data-testid="rl-location"
                        [(ngModel)]="l.sourceLocationId"
                      >
                        <option value="">— (decide quem atende)</option>
                        @for (loc of locations(); track loc.id) {
                          <option [value]="loc.id">{{ loc.pathCode }}</option>
                        }
                      </select>
                    </app-field>
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
      } @else if (r(); as x) {
        <section class="card" aria-labelledby="rf-ro">
          <h2 id="rf-ro" class="mb-3 font-semibold">Linhas</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="rq-lines">
              <thead>
                <tr class="border-b border-border text-left text-muted">
                  <th class="py-2 pr-3">Produto</th>
                  <th class="py-2 pr-3 text-right">Pedido</th>
                  <th class="py-2 pr-3 text-right">Separado</th>
                  <th class="py-2 pr-3 text-right">Entregue</th>
                  <th class="py-2 pr-3 text-right">Libertado</th>
                  <th class="py-2 text-right">Em aberto (reservado)</th>
                </tr>
              </thead>
              <tbody>
                @for (l of x.lines ?? []; track l.id) {
                  <tr class="border-b border-border align-top">
                    <td class="py-2 pr-3">
                      <span class="font-medium">{{ l.variant?.sku ?? l.product.sku }}</span>
                      <span class="block text-xs text-muted"
                        >{{ l.product.name }} ·
                        {{ l.sourceLocation?.pathCode ?? 'sem posição definida' }}</span
                      >
                    </td>
                    <td class="py-2 pr-3 text-right">{{ q(l.quantity) }} {{ l.uom }}</td>
                    <td class="py-2 pr-3 text-right">
                      {{ l.pickedQuantity === null ? '—' : q(l.pickedQuantity) }}
                    </td>
                    <td class="py-2 pr-3 text-right">{{ q(l.issuedQuantity) }}</td>
                    <td class="py-2 pr-3 text-right">{{ q(l.releasedQuantity) }}</td>
                    <td class="py-2 text-right">{{ q(l.openQuantity) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (r(); as x) {
        @if ((x.events ?? []).length) {
          <section class="card" aria-labelledby="rf-ev" data-testid="rq-events">
            <h2 id="rf-ev" class="mb-3 font-semibold">Movimentos de stock</h2>
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
        <section class="card" aria-labelledby="rf-hist">
          <h2 id="rf-hist" class="mb-3 font-semibold">Histórico</h2>
          <app-audit-history
            entityType="stock_requisition"
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
          <p class="mb-3 text-sm text-muted">Quantidades separadas no armazém.</p>
          @for (l of r()?.lines ?? []; track l.id) {
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
        @case ('issue') {
          <p class="mb-3 text-sm text-muted">
            O que foi entregue ao departamento (sai do stock e consome a reserva). Escolha a
            localização de onde saiu.
          </p>
          @for (l of open(); track l.id) {
            <div class="grid gap-2 sm:grid-cols-2" [attr.data-testid]="'is-' + l.product.sku">
              <app-field
                [label]="
                  (l.variant?.sku ?? l.product.sku) +
                  ' — em aberto ' +
                  q(l.openQuantity) +
                  ' ' +
                  l.uom
                "
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  data-testid="is-qty"
                  [(ngModel)]="qtys[l.id]"
                  [ngModelOptions]="{ standalone: true }"
                />
              </app-field>
              <app-field label="Sai de">
                <select
                  appControl
                  class="input"
                  data-testid="is-loc"
                  [(ngModel)]="locs[l.id]"
                  [ngModelOptions]="{ standalone: true }"
                >
                  <option value="">{{ l.sourceLocation?.pathCode ?? '— (sem posição)' }}</option>
                  @for (loc of locations(); track loc.id) {
                    <option [value]="loc.id">{{ loc.pathCode }}</option>
                  }
                </select>
              </app-field>
            </div>
          }
        }
        @default {
          @if (modal() === 'release') {
            <p class="mb-3 text-sm text-muted">
              O que está em aberto deixa de estar reservado; a requisição fica concluída com o que
              foi entregue.
            </p>
          }
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <input
              appControl
              class="input"
              maxlength="300"
              data-testid="rq-reason"
              [(ngModel)]="reason"
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
          data-testid="rq-save"
          [disabled]="act.busy()"
          (click)="saveModal()"
        >
          {{ modalTitle() }}
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class RequisitionFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly r = signal<Requisition | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly options = signal<Options>({
    warehouses: [],
    departments: [],
    costCenters: [],
  });
  protected readonly locations = signal<WarehouseLocation[]>([]);
  protected readonly products = signal<{ id: string; sku: string; name: string }[]>([]);
  private readonly details = signal<Record<string, Product>>({});
  protected readonly action = new Action();
  protected readonly act = new Action();
  protected readonly modal = signal<ModalKind | null>(null);
  protected qtys: Record<string, string> = {};
  protected locs: Record<string, string> = {};
  protected reason = '';
  private stepKey = '';
  protected f = this.emptyForm();
  private initial = snapshot(this.f);
  private readonly formTick = signal(0);
  protected readonly q = qty;
  protected readonly when = formatDateTime;
  protected readonly date = formatDate;
  protected readonly tone = requisitionTone;
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly editable = computed(
    () => this.isNew() || (this.r()?.status === 'DRAFT' && !!this.r()?.can?.request),
  );
  protected readonly acts = computed(() =>
    this.r() ? requisitionActions(this.r()!) : requisitionActions({ status: 'CANCELLED' }),
  );
  /** Entidade legal do armazém escolhido (departamento e centro de custo têm de ser da mesma). */
  private readonly legalEntityId = computed(() => {
    this.formTick();
    return (
      this.r()?.legalEntity?.id ??
      this.options().warehouses.find((w) => w.id === this.f.warehouseId)?.legalEntityId
    );
  });
  protected readonly departments = computed(() =>
    this.options().departments.filter(
      (d) => !this.legalEntityId() || d.legalEntityId === this.legalEntityId(),
    ),
  );
  protected readonly costCenters = computed(() =>
    this.options().costCenters.filter(
      (c) => !this.legalEntityId() || c.legalEntityId === this.legalEntityId(),
    ),
  );
  protected readonly open = computed(() =>
    (this.r()?.lines ?? []).filter((l) => l.openQuantity !== '0.000000'),
  );
  protected readonly title = computed(() => {
    const x = this.r();
    return x ? `Requisição ${x.number ?? '(por aprovar)'}` : 'Nova requisição interna';
  });
  protected readonly subtitle = computed(() => {
    const x = this.r();
    return x
      ? `${x.department.code} · ${x.warehouse.code}${x.costCenter ? ' · CC ' + x.costCenter.code : ''}${x.neededBy ? ' · precisa em ' + formatDate(x.neededBy) : ''}`
      : 'Nada sai do stock até à entrega; a aprovação reserva (baixa o disponível, não o físico).';
  });
  protected readonly modalTitle = computed(
    () =>
      ({
        pick: 'Registar separação',
        issue: 'Registar entrega',
        release: 'Libertar resto',
        reject: 'Rejeitar',
        cancel: 'Anular requisição',
      })[this.modal() ?? 'cancel'],
  );

  constructor() {
    warnOnUnload(this);
    this.api.get<Options>('inventory/requisitions/options').then(
      (o) => this.options.set(o),
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
      warehouseId: '',
      departmentId: '',
      costCenterId: '',
      purpose: '',
      neededBy: '',
      notes: '',
      lines: [emptyLine()] as LineForm[],
    };
  }

  protected statusLabel(s: Requisition['status']) {
    return REQUISITION_STATUS[s];
  }
  protected eventLabel(k: string) {
    return REQUISITION_EVENT[k] ?? k;
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
      return []; // Quem só pede pode não consultar o armazém: a localização decide-a quem atende.
    }
  }

  protected async warehouseChanged() {
    this.formTick.update((n) => n + 1);
    this.f.departmentId = '';
    this.f.costCenterId = '';
    this.f.lines.forEach((l) => (l.sourceLocationId = ''));
    this.locations.set(await this.locationsOf(this.f.warehouseId));
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
      this.r.set(null);
      this.f = this.emptyForm();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const x = await this.api.get<Requisition>(`inventory/requisitions/${this.id()}`);
      await this.apply(x);
      this.breadcrumbs.setCurrent(x.number ?? 'Por aprovar');
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async apply(x: Requisition) {
    this.r.set(x);
    this.f = {
      warehouseId: x.warehouse.id,
      departmentId: x.department.id,
      costCenterId: x.costCenter?.id ?? '',
      purpose: x.purpose,
      neededBy: x.neededBy ?? '',
      notes: x.notes ?? '',
      lines: (x.lines ?? []).map((l) => ({
        productId: l.product.id,
        variantId: l.variant?.id ?? '',
        quantity: l.quantity.replace(/\.?0+$/, ''),
        sourceLocationId: l.sourceLocation?.id ?? '',
      })),
    };
    this.initial = snapshot(this.f);
    this.formTick.update((n) => n + 1);
    this.locations.set(await this.locationsOf(x.warehouse.id));
    if (x.status === 'DRAFT')
      for (const l of this.f.lines) if (l.productId) await this.productChanged({ ...l });
  }

  private body() {
    const f = this.f;
    return {
      departmentId: f.departmentId || null,
      costCenterId: f.costCenterId || null,
      purpose: f.purpose.trim(),
      neededBy: f.neededBy || null,
      notes: f.notes.trim() || null,
      lines: f.lines.map((l) => ({
        productId: l.productId || null,
        variantId: l.variantId || null,
        quantity: l.quantity.trim().replace(',', '.'),
        sourceLocationId: l.sourceLocationId || null,
      })),
    };
  }

  protected async save() {
    const x = this.r();
    const res = await this.action.run(() =>
      x
        ? this.api.put<Requisition>(`inventory/requisitions/${x.id}`, {
            ...this.body(),
            expectedVersion: x.version,
          })
        : this.api.post<Requisition>('inventory/requisitions', {
            ...this.body(),
            warehouseId: this.f.warehouseId || null,
          }),
    );
    if (!res) return;
    await this.apply(res);
    this.toasts.show(x ? 'Rascunho guardado.' : 'Rascunho criado: peça a aprovação.');
    if (!x) await this.router.navigate(['/inventario/requisicoes', res.id], { replaceUrl: true });
  }

  protected back() {
    void this.router.navigate(['/inventario/requisicoes']);
  }

  protected async simple(kind: 'submit' | 'approve') {
    const x = this.r()!;
    if (kind === 'approve') {
      const ok = await this.confirmSvc.ask({
        title: 'Aprovar requisição',
        message: `As quantidades ficam reservadas em ${x.warehouse.code} (o disponível baixa; o físico só muda na entrega).`,
        confirmLabel: 'Aprovar',
      });
      if (!ok) return;
    }
    const res = await this.act.run(() =>
      this.api.post<Requisition>(`inventory/requisitions/${x.id}/${kind}`, {
        expectedVersion: x.version,
      }),
    );
    if (!res) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    await this.apply(res);
    this.breadcrumbs.setCurrent(res.number ?? 'Por aprovar');
    this.toasts.show(
      kind === 'submit' ? 'Pedido enviado para aprovação.' : 'Aprovada: stock reservado.',
    );
  }

  protected start(kind: ModalKind) {
    const x = this.r()!;
    this.act.error.set(null);
    this.reason = '';
    this.qtys =
      kind === 'pick'
        ? pickDefaults(x.lines ?? [])
        : kind === 'issue'
          ? issueDefaults(x.lines ?? [])
          : {};
    this.locs = {};
    // Uma chave por abertura: repetir o envio não lança duas vezes.
    this.stepKey = newKey(kind);
    this.modal.set(kind);
  }

  protected async saveModal() {
    const x = this.r()!;
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
        : kind === 'issue'
          ? {
              ...v,
              idempotencyKey: this.stepKey,
              lines: this.open().map((l) => ({
                lineId: l.id,
                quantity: n(this.qtys[l.id]),
                sourceLocationId: this.locs[l.id] || null,
              })),
            }
          : {
              ...v,
              reason: this.reason.trim(),
              ...(kind === 'release' ? { idempotencyKey: this.stepKey } : {}),
            };
    const res = await this.act.run(() =>
      this.api.post<Requisition>(`inventory/requisitions/${x.id}/${kind}`, body),
    );
    if (!res) return;
    this.modal.set(null);
    await this.apply(res);
    this.toasts.show(
      {
        pick: 'Separação registada.',
        issue:
          res.status === 'COMPLETED'
            ? 'Entregue: requisição concluída.'
            : 'Entrega registada: falta parte.',
        release: 'Resto libertado.',
        reject: 'Rejeitada.',
        cancel: 'Anulada.',
      }[kind],
    );
  }
}
