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
  type Contract,
  type ContractOptions,
  emptyPrice,
  emptySla,
  type PriceForm,
  priceForm,
  pricePayload,
  SLA_METRIC,
  type SlaForm,
  slaForm,
  slaPayload,
} from './contract-model';

/** Soma meses (fim de mês quando o dia não existe), como no servidor. */
function addMonths(date: string, months: number) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Contrato de fornecedor: em rascunho edita-se tudo; num contrato aprovado este formulário propõe uma adenda (ou
 * renovação) com motivo — só aplicada quando outra pessoa a aprovar. Preços e SLA só seguem na adenda se mudaram.
 */
@Component({
  selector: 'app-contract-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Icon],
  template: `
    <app-entity-form-page
      [title]="title()"
      [subtitle]="
        amending()
          ? 'A adenda fica pendente até ser aprovada por outra pessoa; só então se aplica ao contrato.'
          : 'Fica em rascunho até pedir a aprovação; o número é dado quando é aprovado.'
      "
      formId="contract-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="amending() ? 'Propor adenda' : isNew() ? 'Criar rascunho' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      @if (amending()) {
        <app-form-section
          title="Adenda"
          description="Porque se altera o contrato e a partir de quando."
        >
          <app-field
            label="Motivo"
            [required]="true"
            class="sm:col-span-2"
            [error]="action.field('reason')"
          >
            <input
              appControl
              class="input"
              name="reason"
              data-testid="cf-reason"
              [(ngModel)]="reason"
            />
          </app-field>
          <app-field label="Data de efeito" [error]="action.field('effectiveDate')">
            <input
              appControl
              class="input w-44"
              type="date"
              name="eff"
              [(ngModel)]="effectiveDate"
            />
          </app-field>
        </app-form-section>
      }
      <app-form-section
        title="Contrato"
        description="Com quem, sobre o quê, por quanto tempo e até que valor."
      >
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            name="le"
            data-testid="cf-le"
            [disabled]="!isNew()"
            [(ngModel)]="f.legalEntityId"
          >
            <option value="">Escolher…</option>
            @for (l of opts()?.legalEntities ?? []; track l.id) {
              <option [value]="l.id">{{ l.code }}</option>
            }
          </select>
        </app-field>
        <app-field label="Fornecedor" [required]="true" [error]="action.field('supplierId')">
          <select
            appControl
            class="input"
            name="sup"
            data-testid="cf-supplier"
            [disabled]="amending()"
            [(ngModel)]="f.supplierId"
            (ngModelChange)="supplierChanged()"
          >
            <option value="">Escolher…</option>
            @for (s of suppliers(); track s.id) {
              <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Título" [required]="true" [error]="action.field('title')">
          <input
            appControl
            class="input"
            name="title"
            data-testid="cf-title"
            [(ngModel)]="f.title"
          />
        </app-field>
        <app-field label="Moeda" [error]="action.field('currency')">
          <input
            appControl
            class="input w-24"
            name="cur"
            maxlength="3"
            [disabled]="amending()"
            [(ngModel)]="f.currency"
          />
        </app-field>
        <app-field
          label="Objecto"
          [required]="true"
          class="sm:col-span-2"
          [error]="action.field('object')"
        >
          <textarea
            appControl
            class="input min-h-16"
            name="object"
            data-testid="cf-object"
            [(ngModel)]="f.object"
          ></textarea>
        </app-field>
        <app-field label="Início" [required]="true" [error]="action.field('startDate')">
          <input
            appControl
            class="input w-44"
            type="date"
            name="start"
            data-testid="cf-start"
            [disabled]="amending()"
            [(ngModel)]="f.startDate"
          />
        </app-field>
        <app-field label="Fim" [required]="true" [error]="action.field('endDate')">
          <input
            appControl
            class="input w-44"
            type="date"
            name="end"
            data-testid="cf-end"
            [(ngModel)]="f.endDate"
          />
        </app-field>
        <app-field
          label="Valor máximo (sem impostos)"
          [required]="true"
          [hint]="consumedHint()"
          [error]="action.field('maxAmount')"
        >
          <input
            appControl
            class="input"
            inputmode="decimal"
            name="max"
            data-testid="cf-max"
            [(ngModel)]="f.maxAmount"
          />
        </app-field>
        <app-field label="Prazo de pagamento (dias)" [error]="action.field('paymentTermsDays')">
          <input
            appControl
            class="input w-28"
            inputmode="numeric"
            name="terms"
            [(ngModel)]="f.paymentTermsDays"
          />
        </app-field>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" name="auto" data-testid="cf-auto" [(ngModel)]="f.autoRenew" />
          Renovação automática prevista
        </label>
        <app-field label="Período de renovação (meses)" [error]="action.field('renewalMonths')">
          <input
            appControl
            class="input w-28"
            inputmode="numeric"
            name="rm"
            data-testid="cf-renewal"
            [(ngModel)]="f.renewalMonths"
          />
        </app-field>
        <app-field label="Aviso de renovação (dias)" [error]="action.field('renewalNoticeDays')">
          <input
            appControl
            class="input w-28"
            inputmode="numeric"
            name="rn"
            [(ngModel)]="f.renewalNoticeDays"
          />
        </app-field>
        <app-field label="Notas" class="sm:col-span-2" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>

      <app-form-section
        title="Tabela de preços"
        description="Preço unitário líquido acordado; as ordens com este contrato não o podem passar."
      >
        <div class="space-y-3 sm:col-span-2">
          @for (p of f.prices; track $index; let i = $index) {
            <fieldset class="rounded border border-border p-3" [attr.data-testid]="'cp-' + i">
              <legend class="px-1 text-sm font-medium">Preço {{ i + 1 }}</legend>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <app-field label="Produto" [error]="action.field('prices.' + i + '.productId')">
                  <select
                    appControl
                    class="input"
                    [name]="'pp' + i"
                    data-testid="cp-product"
                    [(ngModel)]="p.productId"
                    (ngModelChange)="productChanged(p)"
                  >
                    <option value="">Descrição livre</option>
                    @for (x of opts()?.products ?? []; track x.id) {
                      <option [value]="x.id">{{ x.sku }} — {{ x.name }}</option>
                    }
                  </select>
                </app-field>
                <app-field label="Descrição" [error]="action.field('prices.' + i + '.description')">
                  <input appControl class="input" [name]="'pd' + i" [(ngModel)]="p.description" />
                </app-field>
                <app-field label="Unidade" [error]="action.field('prices.' + i + '.uomId')">
                  <select appControl class="input" [name]="'pu' + i" [(ngModel)]="p.uomId">
                    <option value="">—</option>
                    @for (u of opts()?.uoms ?? []; track u.id) {
                      <option [value]="u.id">{{ u.code }}</option>
                    }
                  </select>
                </app-field>
                <app-field
                  label="Preço unitário"
                  [required]="true"
                  [error]="action.field('prices.' + i + '.unitPrice')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'pv' + i"
                    data-testid="cp-price"
                    [(ngModel)]="p.unitPrice"
                  />
                </app-field>
              </div>
              <div class="mt-2 text-right text-sm">
                <button type="button" class="link" (click)="f.prices.splice(i, 1)">Remover</button>
              </div>
            </fieldset>
          }
          <button
            type="button"
            class="btn-secondary"
            data-testid="cf-add-price"
            (click)="f.prices.push(newPrice())"
          >
            <app-icon name="plus" [size]="16" />Acrescentar preço
          </button>
        </div>
      </app-form-section>

      <app-form-section
        title="Níveis de serviço (SLA)"
        description="O que o fornecedor se compromete a cumprir e a penalização."
      >
        <div class="space-y-3 sm:col-span-2">
          @for (s of f.slas; track $index; let i = $index) {
            <fieldset class="rounded border border-border p-3" [attr.data-testid]="'cs-' + i">
              <legend class="px-1 text-sm font-medium">Nível {{ i + 1 }}</legend>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <app-field label="Métrica" [error]="action.field('slas.' + i + '.metric')">
                  <select
                    appControl
                    class="input"
                    [name]="'sm' + i"
                    data-testid="cs-metric"
                    [(ngModel)]="s.metric"
                  >
                    @for (m of metrics; track m[0]) {
                      <option [value]="m[0]">{{ m[1] }}</option>
                    }
                  </select>
                </app-field>
                <app-field
                  label="Objectivo"
                  [required]="true"
                  [error]="action.field('slas.' + i + '.target')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'st' + i"
                    data-testid="cs-target"
                    [(ngModel)]="s.target"
                  />
                </app-field>
                <app-field label="Descrição" [error]="action.field('slas.' + i + '.description')">
                  <input appControl class="input" [name]="'sd' + i" [(ngModel)]="s.description" />
                </app-field>
                <app-field label="Penalização" [error]="action.field('slas.' + i + '.penalty')">
                  <input
                    appControl
                    class="input"
                    [name]="'sp' + i"
                    data-testid="cs-penalty"
                    [(ngModel)]="s.penalty"
                  />
                </app-field>
              </div>
              <div class="mt-2 text-right text-sm">
                <button type="button" class="link" (click)="f.slas.splice(i, 1)">Remover</button>
              </div>
            </fieldset>
          }
          <button
            type="button"
            class="btn-secondary"
            data-testid="cf-add-sla"
            (click)="f.slas.push(newSla())"
          >
            <app-icon name="plus" [size]="16" />Acrescentar nível de serviço
          </button>
        </div>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class ContractForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  /** `amend` (rota `:id/adenda`): propõe uma adenda; `kind=RENEWAL` na consulta para uma renovação. */
  readonly mode = input<'edit' | 'amend'>('edit');
  readonly kind = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly opts = signal<ContractOptions | null>(null);
  protected readonly contract = signal<Contract | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly metrics = Object.entries(SLA_METRIC) as [SlaForm['metric'], string][];
  protected readonly newPrice = emptyPrice;
  protected readonly newSla = emptySla;
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected readonly amending = computed(() => this.mode() === 'amend');
  protected readonly renewal = computed(() => this.amending() && this.kind() === 'RENEWAL');
  protected readonly title = computed(() => {
    const c = this.contract();
    if (this.renewal()) return `Renovar o contrato ${c?.number ?? ''}`;
    if (this.amending()) return `Adenda ao contrato ${c?.number ?? ''}`;
    return this.isNew()
      ? 'Novo contrato de fornecedor'
      : `Editar contrato ${c?.number ?? '(rascunho)'}`;
  });
  /** Fornecedores homologados e, ao editar, o actual (mesmo que entretanto não esteja apto). */
  protected readonly suppliers = computed(() => {
    const list = this.opts()?.suppliers ?? [];
    const c = this.contract();
    return c && !list.some((s) => s.id === c.supplier.id)
      ? [...list, { ...c.supplier, currency: c.currency, paymentTermsDays: null }]
      : list;
  });
  protected f = this.empty();
  protected reason = '';
  protected effectiveDate = new Date().toISOString().slice(0, 10);
  private initial = snapshot(this.f);
  private initialPrices = '';
  private initialSlas = '';

  constructor() {
    warnOnUnload(this);
    this.api.get<ContractOptions>('procurement/contracts/options').then(
      (o) => this.opts.set(o),
      (e) => this.loadError.set(ApiError.from(e)),
    );
    effect(() => {
      this.id();
      this.mode();
      untracked(() => void this.load());
    });
  }

  private empty() {
    return {
      legalEntityId: '',
      supplierId: '',
      title: '',
      object: '',
      currency: '',
      startDate: new Date().toISOString().slice(0, 10),
      endDate: '',
      maxAmount: '',
      paymentTermsDays: '',
      autoRenew: false,
      renewalMonths: '',
      renewalNoticeDays: '30',
      notes: '',
      prices: [] as PriceForm[],
      slas: [] as SlaForm[],
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && (snapshot(this.f) !== this.initial || !!this.reason.trim());
  }

  protected consumedHint() {
    const c = this.contract();
    return c && c.number ? `Já consumido: ${money(c.consumedAmount, c.currency)}.` : '';
  }

  protected supplierChanged() {
    const s = this.opts()?.suppliers.find((x) => x.id === this.f.supplierId);
    if (!s) return;
    this.f.currency ||= s.currency;
    if (this.f.paymentTermsDays === '' && s.paymentTermsDays !== null)
      this.f.paymentTermsDays = String(s.paymentTermsDays);
  }

  protected productChanged(p: PriceForm) {
    const x = this.opts()?.products.find((y) => y.id === p.productId);
    if (!x) return;
    p.description = x.name;
    p.uomId = x.uomId;
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
      const c = await this.api.get<Contract>(`procurement/contracts/${this.id()}`);
      this.contract.set(c);
      this.f = {
        legalEntityId: c.legalEntity.id,
        supplierId: c.supplier.id,
        title: c.title,
        object: c.object,
        currency: c.currency,
        startDate: c.startDate,
        endDate:
          this.renewal() && c.renewalMonths ? addMonths(c.endDate, c.renewalMonths) : c.endDate,
        maxAmount: c.maxAmount,
        paymentTermsDays: c.paymentTermsDays === null ? '' : String(c.paymentTermsDays),
        autoRenew: c.autoRenew,
        renewalMonths: c.renewalMonths === null ? '' : String(c.renewalMonths),
        renewalNoticeDays: String(c.renewalNoticeDays),
        notes: c.notes ?? '',
        prices: c.prices.map(priceForm),
        slas: c.slas.map(slaForm),
      };
      this.initial = snapshot(this.f);
      this.initialPrices = snapshot(this.f.prices);
      this.initialSlas = snapshot(this.f.slas);
      this.breadcrumbs.setCurrent(c.number ?? 'Rascunho');
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const c = this.contract();
    const n = (v: string) => (v.trim() === '' ? null : Number(v));
    const header = {
      title: this.f.title,
      object: this.f.object,
      endDate: this.f.endDate,
      maxAmount: this.f.maxAmount.trim().replace(',', '.'),
      paymentTermsDays: n(this.f.paymentTermsDays),
      autoRenew: this.f.autoRenew,
      renewalMonths: n(this.f.renewalMonths),
      renewalNoticeDays: n(this.f.renewalNoticeDays),
      notes: this.f.notes.trim() || null,
    };
    let saved: Contract | undefined;
    if (this.amending() && c) {
      const pricesChanged = snapshot(this.f.prices) !== this.initialPrices;
      const slasChanged = snapshot(this.f.slas) !== this.initialSlas;
      saved = await this.action.run(() =>
        this.api.post<Contract>(`procurement/contracts/${c.id}/amendments`, {
          ...header,
          kind: this.renewal() ? 'RENEWAL' : 'CHANGE',
          reason: this.reason,
          effectiveDate: this.effectiveDate,
          expectedVersion: c.version,
          ...(pricesChanged ? { prices: this.f.prices.map(pricePayload) } : {}),
          ...(slasChanged ? { slas: this.f.slas.map(slaPayload) } : {}),
        }),
      );
    } else {
      const body = {
        ...header,
        legalEntityId: this.f.legalEntityId,
        supplierId: this.f.supplierId,
        currency: this.f.currency.trim().toUpperCase() || undefined,
        startDate: this.f.startDate,
        prices: this.f.prices.map(pricePayload),
        slas: this.f.slas.map(slaPayload),
      };
      saved = await this.action.run(() =>
        c
          ? this.api.put<Contract>(`procurement/contracts/${c.id}`, {
              ...body,
              expectedVersion: c.version,
            })
          : this.api.post<Contract>('procurement/contracts', body),
      );
    }
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.reason = '';
    this.toasts.show(
      this.amending() ? 'Adenda proposta.' : c ? 'Contrato guardado.' : 'Rascunho criado.',
    );
    await this.router.navigate(['/compras/contratos', saved.id], { replaceUrl: !c });
  }

  protected cancel() {
    const c = this.contract();
    void this.router.navigate(c ? ['/compras/contratos', c.id] : ['/compras/contratos']);
  }
}
