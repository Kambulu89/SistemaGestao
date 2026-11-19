import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import {
  emptyLine,
  type LineForm,
  linePayload,
  lineTotal,
  PRIORITY,
  type Requisition,
  type RequisitionOptions,
  scaled,
} from './requisition-model';

/**
 * Requisição de compra em rascunho: departamento (dá a entidade e o centro de custo por omissão), prioridade,
 * necessidade, finalidade, referência de orçamento, moeda e linhas (produto do catálogo ou descrição livre, quantidade,
 * preço estimado, imposto, entrega, fornecedor sugerido). O total é recalculado no servidor.
 */
@Component({
  selector: 'app-purchase-requisition-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Icon],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Nova requisição de compra' : 'Editar requisição'"
      subtitle="Fica em rascunho até pedir a aprovação; o valor total decide as etapas de aprovação."
      formId="purchase-requisition-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar rascunho' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Pedido" description="Para que departamento, para quando e porquê.">
        <app-field label="Departamento" [required]="true" [error]="action.field('departmentId')">
          <select
            appControl
            class="input"
            name="dept"
            data-testid="rf-dept"
            [(ngModel)]="f.departmentId"
            (ngModelChange)="deptChanged()"
          >
            <option value="">Escolher…</option>
            @for (d of opts()?.departments ?? []; track d.id) {
              <option [value]="d.id">{{ d.legalEntityCode }} · {{ d.code }} — {{ d.name }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Centro de custo"
          hint="Por omissão, o do departamento."
          [error]="action.field('costCenterId')"
        >
          <select
            appControl
            class="input"
            name="cc"
            data-testid="rf-cc"
            [(ngModel)]="f.costCenterId"
          >
            <option value="">—</option>
            @for (c of costCenters(); track c.id) {
              <option [value]="c.id">{{ c.code }} — {{ c.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Prioridade" [error]="action.field('priority')">
          <select
            appControl
            class="input"
            name="prio"
            data-testid="rf-priority"
            [(ngModel)]="f.priority"
          >
            @for (p of priorities; track p[0]) {
              <option [value]="p[0]">{{ p[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Necessária a" [required]="true" [error]="action.field('neededBy')">
          <input
            appControl
            class="input w-44"
            type="date"
            name="needed"
            data-testid="rf-needed"
            [(ngModel)]="f.neededBy"
          />
        </app-field>
        <app-field label="Finalidade" [required]="true" [error]="action.field('purpose')">
          <input
            appControl
            class="input"
            name="purpose"
            data-testid="rf-purpose"
            [(ngModel)]="f.purpose"
          />
        </app-field>
        <app-field label="Referência de orçamento" [error]="action.field('budgetReference')">
          <input appControl class="input" name="budget" [(ngModel)]="f.budgetReference" />
        </app-field>
        <app-field
          label="Moeda"
          hint="Por omissão, a da entidade."
          [error]="action.field('currency')"
        >
          <input
            appControl
            class="input w-24"
            name="currency"
            maxlength="3"
            [(ngModel)]="f.currency"
          />
        </app-field>
      </app-form-section>

      <app-form-section
        title="Linhas"
        description="Produto do catálogo ou descrição livre (serviços, bens não catalogados)."
      >
        <div class="space-y-3 sm:col-span-2">
          @for (l of f.lines; track $index; let i = $index) {
            <fieldset class="rounded border border-border p-3" [attr.data-testid]="'rl-' + i">
              <legend class="px-1 text-sm font-medium">Linha {{ i + 1 }}</legend>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <app-field label="Produto" [error]="action.field('lines.' + i + '.productId')">
                  <select
                    appControl
                    class="input"
                    [name]="'prod' + i"
                    data-testid="rl-product"
                    [(ngModel)]="l.productId"
                    (ngModelChange)="productChanged(l)"
                  >
                    <option value="">Descrição livre</option>
                    @for (p of opts()?.products ?? []; track p.id) {
                      <option [value]="p.id">{{ p.sku }} — {{ p.name }}</option>
                    }
                  </select>
                </app-field>
                <app-field label="Descrição" [error]="action.field('lines.' + i + '.description')">
                  <input
                    appControl
                    class="input"
                    [name]="'desc' + i"
                    data-testid="rl-desc"
                    [(ngModel)]="l.description"
                  />
                </app-field>
                <app-field
                  label="Quantidade"
                  [required]="true"
                  [error]="action.field('lines.' + i + '.quantity')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'qty' + i"
                    data-testid="rl-qty"
                    [(ngModel)]="l.quantity"
                  />
                </app-field>
                <app-field label="Unidade" [error]="action.field('lines.' + i + '.uomId')">
                  <select appControl class="input" [name]="'uom' + i" [(ngModel)]="l.uomId">
                    <option value="">—</option>
                    @for (u of opts()?.uoms ?? []; track u.id) {
                      <option [value]="u.id">{{ u.code }}</option>
                    }
                  </select>
                </app-field>
                <app-field
                  label="Preço estimado"
                  [error]="action.field('lines.' + i + '.estimatedUnitPrice')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'price' + i"
                    data-testid="rl-price"
                    [(ngModel)]="l.estimatedUnitPrice"
                  />
                </app-field>
                <app-field label="Imposto (%)" [error]="action.field('lines.' + i + '.taxRate')">
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'tax' + i"
                    data-testid="rl-tax"
                    [(ngModel)]="l.taxRate"
                  />
                </app-field>
                <app-field label="Entrega" [error]="action.field('lines.' + i + '.neededBy')">
                  <input
                    appControl
                    class="input"
                    type="date"
                    [name]="'lneed' + i"
                    [(ngModel)]="l.neededBy"
                  />
                </app-field>
                <app-field
                  label="Fornecedor sugerido"
                  [error]="action.field('lines.' + i + '.suggestedSupplierId')"
                >
                  <select
                    appControl
                    class="input"
                    [name]="'sup' + i"
                    [(ngModel)]="l.suggestedSupplierId"
                  >
                    <option value="">—</option>
                    @for (s of opts()?.suppliers ?? []; track s.id) {
                      <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
                    }
                  </select>
                </app-field>
              </div>
              <div class="mt-2 flex items-center justify-between text-sm">
                <span class="text-muted" data-testid="rl-total">Total: {{ total(l) }}</span>
                @if (f.lines.length > 1) {
                  <button type="button" class="link" (click)="removeLine(i)">Remover linha</button>
                }
              </div>
            </fieldset>
          }
          <div class="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              class="btn-secondary"
              data-testid="rf-add-line"
              (click)="addLine()"
            >
              <app-icon name="plus" [size]="16" />Acrescentar linha
            </button>
            <strong data-testid="rf-total">Total estimado: {{ grandTotal() }}</strong>
          </div>
        </div>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class PurchaseRequisitionForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly opts = signal<RequisitionOptions | null>(null);
  protected readonly req = signal<Requisition | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly priorities = Object.entries(PRIORITY);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected f = this.empty();
  private initial = snapshot(this.f);
  protected costCenters() {
    const d = this.opts()?.departments.find((x) => x.id === this.f.departmentId);
    return (this.opts()?.costCenters ?? []).filter(
      (c) => !d || c.legalEntityId === d.legalEntityId,
    );
  }

  protected grandTotal() {
    let sum = 0n;
    for (const l of this.f.lines) {
      const t = lineTotal(l.quantity, l.estimatedUnitPrice, l.taxRate);
      if (t === null) return '—';
      sum += scaled(t, 2)!;
    }
    return money(
      `${sum / 100n}.${(sum % 100n).toString().padStart(2, '0')}`,
      this.f.currency || null,
    );
  }

  constructor() {
    warnOnUnload(this);
    this.api.get<RequisitionOptions>('procurement/requisitions/options').then(
      (o) => this.opts.set(o),
      (e) => this.loadError.set(ApiError.from(e)),
    );
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private empty() {
    return {
      departmentId: '',
      costCenterId: '',
      priority: 'NORMAL',
      neededBy: '',
      purpose: '',
      budgetReference: '',
      currency: '',
      lines: [emptyLine()] as LineForm[],
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected total(l: LineForm) {
    const t = lineTotal(l.quantity, l.estimatedUnitPrice, l.taxRate);
    return t === null ? '—' : money(t, this.f.currency || null);
  }

  protected deptChanged() {
    const d = this.opts()?.departments.find((x) => x.id === this.f.departmentId);
    if (!d) return;
    this.f.currency ||= d.currency;
    if (!this.f.costCenterId && d.costCenterId) this.f.costCenterId = d.costCenterId;
  }

  protected productChanged(l: LineForm) {
    const p = this.opts()?.products.find((x) => x.id === l.productId);
    if (!p) return;
    l.description = p.name;
    l.uomId = p.uomId;
  }

  protected addLine() {
    this.f.lines.push(emptyLine());
  }

  protected removeLine(i: number) {
    this.f.lines.splice(i, 1);
  }

  protected async load() {
    this.loadError.set(null);
    if (this.isNew()) {
      this.f = this.empty();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const r = await this.api.get<Requisition>(`procurement/requisitions/${this.id()}`);
      this.req.set(r);
      this.f = {
        departmentId: r.department.id,
        costCenterId: r.costCenter?.id ?? '',
        priority: r.priority,
        neededBy: r.neededBy,
        purpose: r.purpose,
        budgetReference: r.budgetReference ?? '',
        currency: r.currency,
        lines: r.lines.map((l) => ({
          productId: l.product?.id ?? '',
          description: l.description,
          uomId: l.uom?.id ?? '',
          quantity: l.quantity.replace(/\.?0+$/, ''),
          estimatedUnitPrice: l.estimatedUnitPrice.replace(/\.?0+$/, ''),
          taxRate: l.taxRate.replace(/\.?0+$/, ''),
          neededBy: l.neededBy ?? '',
          suggestedSupplierId: l.suggestedSupplier?.id ?? '',
        })),
      };
      this.initial = snapshot(this.f);
      this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected async save() {
    const r = this.req();
    const body = {
      departmentId: this.f.departmentId,
      costCenterId: this.f.costCenterId || null,
      priority: this.f.priority,
      neededBy: this.f.neededBy,
      purpose: this.f.purpose,
      budgetReference: this.f.budgetReference.trim() || null,
      currency: this.f.currency.trim().toUpperCase() || undefined,
      lines: this.f.lines.map(linePayload),
    };
    const saved = await this.action.run(() =>
      r
        ? this.api.put<Requisition>(`procurement/requisitions/${r.id}`, {
            ...body,
            expectedVersion: r.version,
          })
        : this.api.post<Requisition>('procurement/requisitions', body),
    );
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.toasts.show(r ? 'Requisição guardada.' : 'Rascunho criado.');
    await this.router.navigate(['/compras/requisicoes', saved.id], { replaceUrl: !r });
  }

  protected cancel() {
    const r = this.req();
    void this.router.navigate(r ? ['/compras/requisicoes', r.id] : ['/compras/requisicoes']);
  }
}
