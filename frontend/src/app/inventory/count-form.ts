import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
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
import {
  COUNT_REASON,
  COUNT_STATUS,
  countActions,
  countedChanges,
  countTone,
  linesWithDifference,
  type StockCount,
} from './count-model';
import type { Product } from './inventory-model';
import { type LotRow, lotLabel } from './lot-model';
import { qty } from './stock-model';

interface Options {
  warehouses: {
    id: string;
    code: string;
    name: string;
    locations: { id: string; pathCode: string; name: string }[];
  }[];
  categories: { id: string; code: string; name: string }[];
  reasons: string[];
}
type ModalKind = 'add' | 'justify' | 'recount' | 'cancel';

/**
 * Contagem física (8.7): plano (armazém, zona, categoria, cega) → início com snapshot → contagem por linha (pode ser por
 * partes; artigos encontrados entram com o sistema actual) → revisão: diferenças com motivo e justificação, recontagem
 * de linhas → aprovação, que lança o ajuste (contado − snapshot). A API autoriza cada passo; quem contou não aprova.
 */
@Component({
  selector: 'app-count-form',
  imports: [
    FormsModule,
    RouterLink,
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
      formId="count-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="planDirty()"
      [readOnly]="!editable()"
      [saveLabel]="isNew() ? 'Criar plano' : 'Guardar plano'"
      (save)="save()"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (c(); as x) {
        <div class="card space-y-3" data-testid="ct-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(x.status)" data-testid="ct-status">{{
              statusLabel(x.status)
            }}</span>
            @if (x.blind) {
              <span class="badge bg-surface-2 text-muted">Cega</span>
            }
            @if (x.summary; as s) {
              <span class="text-sm text-muted" data-testid="ct-progress"
                >{{ s.counted }}/{{ s.lines }} linhas contadas{{
                  s.withDifference !== null ? ' · ' + s.withDifference + ' com diferença' : ''
                }}</span
              >
            }
            @if (x.approved) {
              <span class="text-sm text-muted"
                >· ajuste aprovado por {{ x.approved.by }} {{ when(x.approved.at) }}</span
              >
            }
            @if (x.cancelReason) {
              <span class="text-sm text-muted">Anulada: {{ x.cancelReason }}</span>
            }
            <span class="ml-auto flex flex-wrap gap-2">
              @if (acts().start) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="ct-start"
                  [disabled]="act.busy()"
                  (click)="simple('start')"
                >
                  Iniciar contagem
                </button>
              }
              @if (acts().addLine) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="ct-add"
                  [disabled]="act.busy()"
                  (click)="open('add')"
                >
                  Artigo encontrado
                </button>
              }
              @if (acts().submit) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="ct-submit"
                  [disabled]="act.busy()"
                  (click)="simple('submit')"
                >
                  Terminar contagem
                </button>
              }
              @if (acts().justify && diffs().length) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="ct-justify"
                  [disabled]="act.busy()"
                  (click)="open('justify')"
                >
                  Justificar diferenças
                </button>
              }
              @if (acts().recount) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="ct-recount"
                  [disabled]="act.busy()"
                  (click)="open('recount')"
                >
                  Pedir recontagem
                </button>
              }
              @if (acts().approve) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="ct-approve"
                  [disabled]="act.busy()"
                  (click)="simple('approve')"
                >
                  Aprovar ajuste
                </button>
              }
              @if (acts().cancel) {
                <button
                  type="button"
                  class="btn-danger"
                  data-testid="ct-cancel"
                  [disabled]="act.busy()"
                  (click)="open('cancel')"
                >
                  Anular
                </button>
              }
            </span>
          </div>
          @if (x.status === 'REVIEW' && x.can?.review && x.can?.counted) {
            <p class="text-sm text-muted" data-testid="ct-segregation">
              Registou quantidades nesta contagem: pode rever e justificar, mas outra pessoa aprova
              o ajuste.
            </p>
          }
          @if (x.status === 'COUNTING' && !x.can?.seeBook) {
            <p class="text-sm text-muted">
              Contagem cega: conte o que está fisicamente em cada localização; a quantidade do
              sistema só é vista na revisão.
            </p>
          }
        </div>
      }

      <app-form-section
        title="Plano"
        description="O snapshot fica com o físico de cada saldo no âmbito (armazém, zona e categoria) no momento do início. O que entrar ou sair depois não é anulado pelo ajuste."
      >
        <app-field label="Armazém" [required]="true" [error]="action.field('warehouseId')">
          <select
            appControl
            class="input"
            name="wh"
            data-testid="cf-warehouse"
            [(ngModel)]="f.warehouseId"
            [disabled]="!isNew()"
            (ngModelChange)="f.locationId = ''"
          >
            @if (c(); as x) {
              <!-- Contagem existente: o armazém fica fixo (quem só aprova não o tem nas opções). -->
              <option [value]="x.warehouse.id">
                {{ x.warehouse.code }} — {{ x.warehouse.name }}
              </option>
            } @else {
              <option value="">—</option>
              @for (w of options().warehouses; track w.id) {
                <option [value]="w.id">{{ w.code }} — {{ w.name }}</option>
              }
            }
          </select>
        </app-field>
        <app-field
          label="Zona"
          hint="Inclui as posições abaixo."
          [error]="action.field('locationId')"
        >
          <select
            appControl
            class="input"
            name="zone"
            data-testid="cf-zone"
            [(ngModel)]="f.locationId"
            [disabled]="!editable()"
          >
            <option value="">Todo o armazém</option>
            @for (l of zones(); track l.id) {
              <option [value]="l.id">{{ l.pathCode }} — {{ l.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Categoria" [error]="action.field('categoryId')">
          <select
            appControl
            class="input"
            name="cat"
            data-testid="cf-category"
            [(ngModel)]="f.categoryId"
            [disabled]="!editable()"
          >
            <option value="">Todas</option>
            @for (k of options().categories; track k.id) {
              <option [value]="k.id">{{ k.code }} — {{ k.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data prevista" [error]="action.field('plannedDate')">
          <input
            appControl
            type="date"
            class="input"
            name="pd"
            [(ngModel)]="f.plannedDate"
            [disabled]="!editable()"
          />
        </app-field>
        <app-field label="Descrição" [required]="true" [error]="action.field('description')">
          <input
            appControl
            class="input"
            name="desc"
            maxlength="200"
            data-testid="cf-description"
            [(ngModel)]="f.description"
            [disabled]="!editable()"
          />
        </app-field>
        <app-field
          label="Contagem cega"
          hint="Quem só conta não vê a quantidade do sistema; as diferenças são justificadas por quem aprova."
        >
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="blind"
              data-testid="cf-blind"
              [(ngModel)]="f.blind"
              [disabled]="!editable()"
            />
            Esconder o sistema a quem conta
          </label>
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

      @if (c(); as x) {
        @if ((x.lines ?? []).length || x.status !== 'DRAFT') {
          <section class="card" aria-labelledby="ct-lines-h">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="ct-lines-h" class="font-semibold">Linhas ({{ (x.lines ?? []).length }})</h2>
              @if (acts().count) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="ct-save-counts"
                  [disabled]="act.busy() || !pending().length"
                  (click)="saveCounts()"
                >
                  Guardar contagem ({{ pending().length }})
                </button>
              }
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm" data-testid="ct-lines">
                <thead>
                  <tr class="border-b border-border text-left text-muted">
                    <th class="py-2 pr-3">#</th>
                    <th class="py-2 pr-3">Localização</th>
                    <th class="py-2 pr-3">Produto</th>
                    <th class="py-2 pr-3 text-right">Contado</th>
                    @if (x.can?.seeBook) {
                      <th class="py-2 pr-3 text-right">Sistema (snapshot)</th>
                      <th class="py-2 pr-3 text-right">Diferença</th>
                      @if (x.status === 'COUNTING' || x.status === 'REVIEW') {
                        <th class="py-2 pr-3 text-right">Movido depois</th>
                      }
                    }
                    <th class="py-2">Justificação</th>
                  </tr>
                </thead>
                <tbody>
                  @for (l of x.lines ?? []; track l.id) {
                    <tr
                      class="border-b border-border align-top"
                      [attr.data-testid]="'ct-line-' + (l.variant?.sku ?? l.product.sku)"
                    >
                      <td class="py-2 pr-3 text-muted">{{ l.lineNo }}</td>
                      <td class="py-2 pr-3">{{ l.location?.pathCode ?? 'sem posição' }}</td>
                      <td class="py-2 pr-3">
                        <span class="font-medium">{{ l.variant?.sku ?? l.product.sku }}</span>
                        @if (l.lot) {
                          <span class="block text-xs" data-testid="ct-lot"
                            >Lote {{ lot(l.lot) }}</span
                          >
                        }
                        <span class="block text-xs text-muted"
                          >{{ l.product.name }}{{ l.addedDuringCount ? ' · encontrado' : ''
                          }}{{ l.round > 1 ? ' · volta ' + l.round : '' }}</span
                        >
                        @if (l.recountRequested) {
                          <span class="block text-xs text-warning-text"
                            >Recontar: {{ l.recountReason }}</span
                          >
                        }
                      </td>
                      <td class="py-2 pr-3 text-right">
                        @if (acts().count) {
                          <input
                            class="input w-28 text-right"
                            inputmode="decimal"
                            data-testid="ct-qty"
                            [attr.aria-label]="
                              'Contado de ' +
                              (l.variant?.sku ?? l.product.sku) +
                              ' em ' +
                              (l.location?.pathCode ?? 'sem posição')
                            "
                            [placeholder]="l.uom"
                            [(ngModel)]="typed[l.id]"
                            (ngModelChange)="tick()"
                          />
                        } @else {
                          {{
                            l.countedQuantity === null ? '—' : q(l.countedQuantity) + ' ' + l.uom
                          }}
                        }
                      </td>
                      @if (x.can?.seeBook) {
                        <td class="py-2 pr-3 text-right">{{ q(l.snapshotQuantity) }}</td>
                        <td
                          class="py-2 pr-3 text-right"
                          [class.text-danger-text]="l.difference !== null && +l.difference < 0"
                          data-testid="ct-diff"
                        >
                          {{ l.difference === null ? '—' : signed(l.difference) }}
                        </td>
                        @if (x.status === 'COUNTING' || x.status === 'REVIEW') {
                          <td class="py-2 pr-3 text-right">
                            {{ l.movedSinceSnapshot === null ? '—' : signed(l.movedSinceSnapshot) }}
                          </td>
                        }
                      }
                      <td class="py-2">
                        @if (l.reasonCode) {
                          <span class="font-medium">{{ reason(l.reasonCode) }}</span>
                          <span class="block text-xs text-muted">{{ l.justification }}</span>
                        } @else {
                          <span class="text-muted">—</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
        @if ((x.postings ?? []).length) {
          <section class="card" aria-labelledby="ct-posts" data-testid="ct-postings">
            <h2 id="ct-posts" class="mb-3 font-semibold">Ajuste de stock</h2>
            <p class="text-sm">
              {{ (x.postings ?? []).length }} lançamento(s) de ajuste com a origem {{ x.number }}.
              <a
                class="link"
                routerLink="/inventario/movimentos"
                [queryParams]="{ type: 'ADJUSTMENT' }"
                >Ver movimentos</a
              >
            </p>
          </section>
        }
        <section class="card" aria-labelledby="ct-hist">
          <h2 id="ct-hist" class="mb-3 font-semibold">Histórico</h2>
          <app-audit-history entityType="stock_count" [entityId]="x.id" [refreshKey]="x.version" />
        </section>
      }
    </app-entity-form-page>

    <app-modal [title]="modalTitle()" [open]="modal() !== null" (closed)="modal.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      @switch (modal()) {
        @case ('add') {
          <p class="mb-3 text-sm text-muted">
            Artigo que está fisicamente aqui mas não veio no snapshot. Entra com a quantidade actual
            do sistema nessa localização.
          </p>
          <app-field label="Produto" [required]="true" [error]="act.field('productId')">
            <select
              appControl
              class="input"
              data-testid="ad-product"
              [(ngModel)]="add.productId"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="productChanged()"
            >
              <option value="">—</option>
              @for (p of products(); track p.id) {
                <option [value]="p.id">{{ p.sku }} — {{ p.name }}</option>
              }
            </select>
          </app-field>
          @if (addProduct()?.hasVariants) {
            <app-field label="Variante" [required]="true" [error]="act.field('variantId')">
              <select
                appControl
                class="input"
                [(ngModel)]="add.variantId"
                [ngModelOptions]="{ standalone: true }"
              >
                <option value="">—</option>
                @for (v of addProduct()?.variants ?? []; track v.id) {
                  <option [value]="v.id">{{ v.sku }}</option>
                }
              </select>
            </app-field>
          }
          @if (addProduct()?.trackLots) {
            <app-field
              label="Lote"
              [required]="true"
              hint="Um lote novo regista-se por uma entrada (documento)."
              [error]="act.field('lotId')"
            >
              <select
                appControl
                class="input"
                data-testid="ad-lot"
                [(ngModel)]="add.lotId"
                [ngModelOptions]="{ standalone: true }"
              >
                <option value="">—</option>
                @for (x of addLots(); track x.id) {
                  <option [value]="x.id">{{ lot(x) }}</option>
                }
              </select>
            </app-field>
          }
          <app-field label="Localização" [error]="act.field('locationId')">
            <select
              appControl
              class="input"
              data-testid="ad-location"
              [(ngModel)]="add.locationId"
              [ngModelOptions]="{ standalone: true }"
            >
              <option value="">— (sem posição)</option>
              @for (l of zones(); track l.id) {
                <option [value]="l.id">{{ l.pathCode }}</option>
              }
            </select>
          </app-field>
        }
        @case ('justify') {
          <p class="mb-3 text-sm text-muted">
            Cada diferença precisa de motivo e explicação antes da aprovação.
          </p>
          @for (l of diffs(); track l.id) {
            <fieldset class="mb-3 rounded-md border border-border p-3" data-testid="js-line">
              <legend class="px-1 text-sm font-medium">
                {{ l.variant?.sku ?? l.product.sku }} ·
                {{ l.location?.pathCode ?? 'sem posição' }} · {{ signed(l.difference!) }}
                {{ l.uom }}
              </legend>
              <div class="grid gap-2 sm:grid-cols-2">
                <app-field label="Motivo" [required]="true">
                  <select
                    appControl
                    class="input"
                    data-testid="js-reason"
                    [(ngModel)]="just[l.id].reasonCode"
                    [ngModelOptions]="{ standalone: true }"
                  >
                    <option value="">—</option>
                    @for (r of reasons(); track r) {
                      <option [value]="r">{{ reason(r) }}</option>
                    }
                  </select>
                </app-field>
                <app-field label="Explicação" [required]="true">
                  <input
                    appControl
                    class="input"
                    maxlength="300"
                    data-testid="js-text"
                    [(ngModel)]="just[l.id].justification"
                    [ngModelOptions]="{ standalone: true }"
                  />
                </app-field>
              </div>
            </fieldset>
          }
        }
        @case ('recount') {
          <p class="mb-3 text-sm text-muted">
            As linhas escolhidas voltam a ser contadas; o snapshot delas passa a ser o sistema de
            agora.
          </p>
          <fieldset class="mb-3 space-y-1">
            <legend class="mb-1 text-sm font-medium">Linhas a recontar</legend>
            @for (l of c()?.lines ?? []; track l.id) {
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="rc-line"
                  [(ngModel)]="recountIds[l.id]"
                  [ngModelOptions]="{ standalone: true }"
                />
                {{ l.lineNo }} · {{ l.variant?.sku ?? l.product.sku }} ·
                {{ l.location?.pathCode ?? 'sem posição'
                }}{{ l.difference !== null ? ' · ' + signed(l.difference) : '' }}
              </label>
            }
          </fieldset>
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <input
              appControl
              class="input"
              maxlength="300"
              data-testid="ct-reason"
              [(ngModel)]="why"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        @default {
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <input
              appControl
              class="input"
              maxlength="300"
              data-testid="ct-reason"
              [(ngModel)]="why"
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
          data-testid="ct-save"
          [disabled]="act.busy()"
          (click)="saveModal()"
        >
          {{ modalTitle() }}
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class CountFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly c = signal<StockCount | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly options = signal<Options>({ warehouses: [], categories: [], reasons: [] });
  protected readonly products = signal<{ id: string; sku: string; name: string }[]>([]);
  protected readonly addProduct = signal<Product | null>(null);
  protected readonly action = new Action();
  protected readonly act = new Action();
  protected readonly modal = signal<ModalKind | null>(null);
  protected typed: Record<string, string> = {};
  protected just: Record<string, { reasonCode: string; justification: string }> = {};
  protected recountIds: Record<string, boolean> = {};
  protected add = { productId: '', variantId: '', locationId: '', lotId: '' };
  protected readonly addLots = signal<LotRow[]>([]);
  protected readonly lot = lotLabel;
  protected why = '';
  protected f = this.emptyForm();
  private initial = snapshot(this.f);
  private readonly typedTick = signal(0);
  private readonly formTick = signal(0);
  protected readonly q = qty;
  protected readonly when = formatDateTime;
  protected readonly tone = countTone;
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly editable = computed(
    () => this.isNew() || (this.c()?.status === 'DRAFT' && !!this.c()?.can?.manage),
  );
  protected readonly acts = computed(() =>
    this.c() ? countActions(this.c()!) : countActions({ status: 'CANCELLED', blind: true }),
  );
  protected readonly zones = computed(() => {
    this.formTick();
    const wid = this.c()?.warehouse.id ?? this.f.warehouseId;
    const list = this.options().warehouses.find((w) => w.id === wid)?.locations ?? [];
    // A zona da contagem aparece sempre (quem só aprova não tem o armazém nas opções).
    const z = this.c()?.location;
    return z && !list.some((l) => l.id === z.id)
      ? [{ id: z.id, pathCode: z.pathCode, name: '' }, ...list]
      : list;
  });
  protected readonly reasons = computed(() =>
    this.options().reasons.length ? this.options().reasons : Object.keys(COUNT_REASON),
  );
  protected readonly diffs = computed(() => linesWithDifference(this.c()?.lines ?? []));
  protected readonly pending = computed(() => {
    this.typedTick();
    return countedChanges(this.c()?.lines ?? [], this.typed);
  });
  protected readonly title = computed(() => {
    const x = this.c();
    return x ? `Contagem ${x.number ?? '(plano)'}` : 'Nova contagem';
  });
  protected readonly subtitle = computed(() => {
    const x = this.c();
    return x
      ? `${x.warehouse.code} · ${x.location?.pathCode ?? 'todo o armazém'}${x.category ? ' · ' + x.category.code : ''} · ${x.description}${x.plannedDate ? ' · prevista ' + formatDate(x.plannedDate) : ''}`
      : 'Nada muda no stock até à aprovação do ajuste.';
  });
  protected readonly modalTitle = computed(
    () =>
      ({
        add: 'Acrescentar artigo',
        justify: 'Justificar diferenças',
        recount: 'Pedir recontagem',
        cancel: 'Anular contagem',
      })[this.modal() ?? 'cancel'],
  );

  constructor() {
    warnOnUnload(this);
    this.api.get<Options>('inventory/counts/options').then(
      (o) => {
        this.options.set(o);
        this.formTick.update((n) => n + 1);
      },
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

  protected planDirty() {
    return this.loaded() && this.editable() && snapshot(this.f) !== this.initial;
  }
  hasUnsavedChanges() {
    return this.planDirty() || this.pending().length > 0;
  }

  private emptyForm() {
    return {
      warehouseId: '',
      locationId: '',
      categoryId: '',
      plannedDate: '',
      description: '',
      blind: true,
      notes: '',
    };
  }

  protected statusLabel(s: StockCount['status']) {
    return COUNT_STATUS[s];
  }
  protected reason(code: string) {
    return COUNT_REASON[code] ?? code;
  }
  protected signed(v: string) {
    const n = Number(v);
    return (n > 0 ? '+' : '') + qty(v);
  }
  /** Mensagem do erro: o primeiro detalhe (ex.: a linha por justificar) diz mais do que o resumo. */
  private failure() {
    const e = this.act.error();
    const d = e?.details ?? [];
    return d.length
      ? d
          .map((x) => x.message)
          .slice(0, 3)
          .join(' ')
      : (e?.message ?? 'Não foi possível.');
  }
  protected tick() {
    this.typedTick.update((n) => n + 1);
  }

  protected async load() {
    this.loadError.set(null);
    this.action.error.set(null);
    if (this.isNew()) {
      this.c.set(null);
      this.f = this.emptyForm();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const x = await this.api.get<StockCount>(`inventory/counts/${this.id()}`);
      this.apply(x);
      this.breadcrumbs.setCurrent(x.number ?? 'Plano');
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(x: StockCount) {
    this.c.set(x);
    this.f = {
      warehouseId: x.warehouse.id,
      locationId: x.location?.id ?? '',
      categoryId: x.category?.id ?? '',
      plannedDate: x.plannedDate ?? '',
      description: x.description,
      blind: x.blind,
      notes: x.notes ?? '',
    };
    this.initial = snapshot(this.f);
    this.typed = Object.fromEntries(
      (x.lines ?? []).map((l) => [
        l.id,
        l.countedQuantity === null ? '' : l.countedQuantity.replace(/\.?0+$/, ''),
      ]),
    );
    this.formTick.update((n) => n + 1);
    this.tick();
  }

  private body() {
    const f = this.f;
    return {
      locationId: f.locationId || null,
      categoryId: f.categoryId || null,
      plannedDate: f.plannedDate || null,
      description: f.description.trim(),
      blind: f.blind,
      notes: f.notes.trim() || null,
    };
  }

  protected async save() {
    const x = this.c();
    const res = await this.action.run(() =>
      x
        ? this.api.put<StockCount>(`inventory/counts/${x.id}`, {
            ...this.body(),
            expectedVersion: x.version,
          })
        : this.api.post<StockCount>('inventory/counts', {
            ...this.body(),
            warehouseId: this.f.warehouseId || null,
          }),
    );
    if (!res) return;
    this.apply(res);
    this.toasts.show(x ? 'Plano guardado.' : 'Plano criado: inicie a contagem quando for contar.');
    if (!x) await this.router.navigate(['/inventario/contagens', res.id], { replaceUrl: true });
  }

  protected back() {
    void this.router.navigate(['/inventario/contagens']);
  }

  protected async simple(kind: 'start' | 'submit' | 'approve') {
    const x = this.c()!;
    const ask = {
      start: {
        title: 'Iniciar contagem',
        message: `Fica registado o sistema (snapshot) de cada saldo do plano em ${x.warehouse.code} e é atribuído o número.`,
        confirmLabel: 'Iniciar',
      },
      submit: {
        title: 'Terminar contagem',
        message: 'Todas as linhas têm de estar contadas. A contagem passa à revisão.',
        confirmLabel: 'Terminar',
      },
      approve: {
        title: 'Aprovar ajuste',
        message: `O stock de ${x.warehouse.code} é ajustado pelas diferenças (contado − snapshot). Os movimentos ficam registados e não se alteram.`,
        confirmLabel: 'Aprovar e ajustar',
      },
    }[kind];
    if (kind === 'submit' && this.pending().length) {
      this.toasts.show('Guarde primeiro as quantidades escritas.', 'error');
      return;
    }
    if (!(await this.confirmSvc.ask(ask))) return;
    const res = await this.act.run(() =>
      this.api.post<StockCount>(`inventory/counts/${x.id}/${kind}`, {
        expectedVersion: x.version,
      }),
    );
    if (!res) {
      this.toasts.show(this.failure(), 'error');
      return;
    }
    this.apply(res);
    this.breadcrumbs.setCurrent(res.number ?? 'Plano');
    this.toasts.show(
      {
        start: 'Contagem iniciada: registe as quantidades.',
        submit: 'Contagem terminada: em revisão.',
        approve: 'Ajuste aprovado e lançado no stock.',
      }[kind],
    );
  }

  protected async saveCounts() {
    const x = this.c()!;
    const lines = this.pending();
    const res = await this.act.run(() =>
      this.api.post<StockCount>(`inventory/counts/${x.id}/count`, {
        expectedVersion: x.version,
        lines,
      }),
    );
    if (!res) {
      this.toasts.show(this.failure(), 'error');
      return;
    }
    this.apply(res);
    this.toasts.show(`${lines.length} linha(s) registada(s).`);
  }

  protected async productChanged() {
    this.add.variantId = '';
    this.addProduct.set(null);
    if (!this.add.productId) return;
    try {
      const p = await this.api.get<Product>(`inventory/products/${this.add.productId}`);
      this.addProduct.set(p);
      this.add.lotId = '';
      this.addLots.set(
        p.trackLots
          ? await this.api.get<LotRow[]>('inventory/lots', { productId: p.id, limit: 200 })
          : [],
      );
    } catch {
      /* validado no servidor */
    }
  }

  protected open(kind: ModalKind) {
    this.act.error.set(null);
    this.why = '';
    this.add = { productId: '', variantId: '', locationId: '', lotId: '' };
    this.addLots.set([]);
    this.addProduct.set(null);
    this.recountIds = {};
    this.just = Object.fromEntries(
      this.diffs().map((l) => [
        l.id,
        { reasonCode: l.reasonCode ?? '', justification: l.justification ?? '' },
      ]),
    );
    this.modal.set(kind);
  }

  protected async saveModal() {
    const x = this.c()!;
    const kind = this.modal()!;
    const v = { expectedVersion: x.version };
    const [path, body]: [string, Record<string, unknown>] =
      kind === 'add'
        ? [
            'lines',
            {
              ...v,
              productId: this.add.productId || null,
              variantId: this.add.variantId || null,
              locationId: this.add.locationId || null,
              lotId: this.add.lotId || null,
            },
          ]
        : kind === 'justify'
          ? [
              'justify',
              {
                ...v,
                lines: this.diffs().map((l) => ({
                  lineId: l.id,
                  reasonCode: this.just[l.id]?.reasonCode || null,
                  justification: this.just[l.id]?.justification.trim() || null,
                })),
              },
            ]
          : kind === 'recount'
            ? [
                'recount',
                {
                  ...v,
                  reason: this.why.trim(),
                  lineIds: Object.keys(this.recountIds).filter((k) => this.recountIds[k]),
                },
              ]
            : ['cancel', { ...v, reason: this.why.trim() }];
    const res = await this.act.run(() =>
      this.api.post<StockCount>(`inventory/counts/${x.id}/${path}`, body),
    );
    if (!res) return;
    this.modal.set(null);
    this.apply(res);
    this.toasts.show(
      {
        add: 'Artigo acrescentado: registe a quantidade.',
        justify: 'Justificações guardadas.',
        recount: 'Recontagem pedida.',
        cancel: 'Contagem anulada.',
      }[kind],
    );
  }
}
