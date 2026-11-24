import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  emptyLine,
  emptyQuoteForm,
  formFromQuote,
  type Quote,
  type QuoteForm,
  type QuoteOptions,
  quotePayload,
  zeroRate,
} from './quote-model';

/**
 * Orçamento em rascunho: cabeçalho e linhas. Os preços vêm do motor de preços à data do orçamento (calculados pelo
 * servidor ao guardar); aqui pede-se só o desconto ou o preço manual, se houver, e o imposto de cada linha.
 */
@Component({
  selector: 'app-quote-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete, Icon],
  template: `
    <app-entity-form-page
      [title]="
        isNew()
          ? 'Novo orçamento'
          : 'Editar ' + (quote()?.number ?? 'rascunho') + ' v' + (quote()?.versionNo ?? '')
      "
      subtitle="Preços da tabela à data do orçamento; descontos acima do limite precisam de aprovação."
      formId="quote-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar orçamento' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Cliente e condições">
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            name="le"
            data-testid="qf-le"
            [disabled]="!isNew()"
            [(ngModel)]="f.legalEntityId"
          >
            <option value="">—</option>
            @for (e of opts()?.legalEntities ?? []; track e.id) {
              <option [value]="e.id">{{ e.code }} — {{ e.name }}</option>
            }
          </select>
        </app-field>
        <app-field #cf label="Cliente" [required]="true" [error]="action.field('customerId')">
          <app-autocomplete
            name="customer"
            data-testid="qf-customer"
            [inputId]="cf.controlId"
            [describedBy]="cf.describedBy()"
            [search]="searchCustomers"
            [initialLabel]="f.customerLabel || null"
            [(ngModel)]="f.customerId"
          />
        </app-field>
        <app-field label="Comercial" [error]="action.field('salespersonMembershipId')">
          <select
            appControl
            class="input"
            name="salesperson"
            [disabled]="opts()?.ownOnly ?? false"
            [(ngModel)]="f.salespersonMembershipId"
          >
            <option value="">Eu</option>
            @for (p of opts()?.salespeople ?? []; track p.membershipId) {
              <option [value]="p.membershipId">{{ p.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Referência do cliente" [error]="action.field('customerReference')">
          <input appControl class="input" name="ref" [(ngModel)]="f.customerReference" />
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('quoteDate')">
          <input
            appControl
            class="input"
            type="date"
            name="date"
            data-testid="qf-date"
            [(ngModel)]="f.quoteDate"
          />
        </app-field>
        <app-field label="Válido até" [required]="true" [error]="action.field('validUntil')">
          <input
            appControl
            class="input"
            type="date"
            name="valid"
            data-testid="qf-valid"
            [(ngModel)]="f.validUntil"
          />
        </app-field>
        <app-field label="Moeda" hint="Vazio: a do cliente." [error]="action.field('currency')">
          <input
            appControl
            class="input w-24 uppercase"
            name="currency"
            maxlength="3"
            [(ngModel)]="f.currency"
          />
        </app-field>
        <app-field
          label="Prazo de pagamento (dias)"
          hint="Vazio: o do cliente."
          [error]="action.field('paymentTermsDays')"
        >
          <input
            appControl
            class="input w-28"
            type="number"
            min="0"
            max="365"
            name="terms"
            [(ngModel)]="f.paymentTermsDays"
          />
        </app-field>
      </app-form-section>

      <section class="card space-y-4" aria-labelledby="qf-lines-title">
        <div>
          <h2 id="qf-lines-title" class="font-semibold">Linhas</h2>
          <p class="mt-0.5 text-sm text-muted">
            O imposto é indicado por linha até à configuração fiscal; a 0 % exige o motivo da
            isenção.
          </p>
        </div>
        @if (action.field('lines'); as e) {
          <p class="field-error">{{ e }}</p>
        }
        @for (l of f.lines; track l.key; let i = $index) {
          <div class="grid gap-3 border-b border-border pb-4 md:grid-cols-6" data-testid="qf-line">
            <div class="md:col-span-3">
              <app-field
                #pf
                label="Produto ou serviço"
                [required]="true"
                [error]="action.field('lines.' + i + '.productId')"
              >
                <app-autocomplete
                  [name]="'product-' + l.key"
                  data-testid="qf-product"
                  [inputId]="pf.controlId"
                  [describedBy]="pf.describedBy()"
                  [search]="searchProducts"
                  [initialLabel]="l.productLabel || null"
                  [(ngModel)]="l.productId"
                />
              </app-field>
            </div>
            <div class="md:col-span-3">
              <app-field
                label="Descrição"
                hint="Vazio: o nome do produto."
                [error]="action.field('lines.' + i + '.description')"
              >
                <input
                  appControl
                  class="input"
                  [name]="'desc-' + l.key"
                  [(ngModel)]="l.description"
                />
              </app-field>
            </div>
            <app-field
              label="Quantidade"
              [required]="true"
              [error]="action.field('lines.' + i + '.quantity')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'qty-' + l.key"
                data-testid="qf-qty"
                [(ngModel)]="l.quantity"
              />
            </app-field>
            <app-field
              label="Desconto (%)"
              [error]="action.field('lines.' + i + '.manualDiscountPct')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'disc-' + l.key"
                data-testid="qf-disc"
                [(ngModel)]="l.manualDiscountPct"
              />
            </app-field>
            <app-field
              label="Preço manual"
              [error]="action.field('lines.' + i + '.manualUnitPrice')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'mp-' + l.key"
                data-testid="qf-manual"
                [(ngModel)]="l.manualUnitPrice"
              />
            </app-field>
            <app-field
              label="Imposto (%)"
              [required]="true"
              [error]="action.field('lines.' + i + '.taxRate')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [name]="'tax-' + l.key"
                data-testid="qf-tax"
                [(ngModel)]="l.taxRate"
              />
            </app-field>
            @if (zero(l.taxRate)) {
              <div class="md:col-span-2">
                <app-field
                  label="Motivo da isenção"
                  [required]="true"
                  [error]="action.field('lines.' + i + '.taxExemptionReason')"
                >
                  <input
                    appControl
                    class="input"
                    [name]="'ex-' + l.key"
                    data-testid="qf-exempt"
                    [(ngModel)]="l.taxExemptionReason"
                  />
                </app-field>
              </div>
            }
            @if (f.lines.length > 1) {
              <div class="md:col-span-6">
                <button
                  type="button"
                  class="link text-sm"
                  [attr.aria-label]="'Remover a linha ' + (i + 1)"
                  (click)="removeLine(i)"
                >
                  Remover linha
                </button>
              </div>
            }
          </div>
        }
        <button type="button" class="btn-secondary" data-testid="qf-add" (click)="addLine()">
          <app-icon name="plus" [size]="16" />Linha
        </button>
      </section>

      <app-form-section title="Notas">
        <app-field label="Notas para o cliente" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class QuoteFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly quote = signal<Quote | null>(null);
  protected readonly opts = signal<QuoteOptions | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected readonly zero = zeroRate;
  protected f: QuoteForm = emptyQuoteForm(new Date().toISOString().slice(0, 10));
  private initial = snapshot(this.f);

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string; status: string }[]>(
        'sales/quotes/search/customers',
        { q },
      )
    )
      .filter((c) => c.status === 'ACTIVE')
      .map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));
  protected readonly searchProducts = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; sku: string; name: string }[]>(
        'sales/quotes/search/products',
        {
          q,
        },
      )
    ).map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}` }));

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected async load() {
    this.loadError.set(null);
    this.loaded.set(false);
    try {
      const o = await this.api.get<QuoteOptions>('sales/quotes/options');
      this.opts.set(o);
      if (this.isNew()) {
        this.f = emptyQuoteForm(new Date().toISOString().slice(0, 10));
        if (o.legalEntities.length === 1) this.f.legalEntityId = o.legalEntities[0].id;
      } else {
        const q = await this.api.get<Quote>(`sales/quotes/${this.id()}`);
        this.quote.set(q);
        this.f = formFromQuote(q);
        this.breadcrumbs.setCurrent(q.number ?? 'Rascunho');
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected addLine() {
    this.f.lines = [...this.f.lines, emptyLine()];
  }
  protected removeLine(i: number) {
    const gone = this.f.lines[i];
    this.f.lines = this.f.lines.filter((l) => l !== gone);
  }

  protected async save() {
    const q = this.quote();
    const body = quotePayload(this.f, !q);
    const r = await this.action.run(() =>
      q
        ? this.api.patch<Quote>(`sales/quotes/${q.id}`, { ...body, expectedVersion: q.version })
        : this.api.post<Quote>('sales/quotes', body),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show(q ? 'Orçamento guardado.' : 'Orçamento criado.');
    await this.router.navigate(['/vendas/orcamentos', r.id], { replaceUrl: !q });
  }

  protected cancel() {
    const q = this.quote();
    void this.router.navigate(q ? ['/vendas/orcamentos', q.id] : ['/vendas/orcamentos']);
  }
}
