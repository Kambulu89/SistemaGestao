import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  emptyListForm,
  formFromList,
  LIST_TARGET,
  type ListForm,
  listPayload,
  type PriceList,
  type PricingOptions,
} from './pricing-model';

/** Cabeçalho de uma tabela de preços (só em rascunho): destino, moeda, entidade, período e prioridade. */
@Component({
  selector: 'app-price-list-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Nova tabela de preços' : 'Editar ' + (list()?.code ?? '')"
      subtitle="Os preços acrescentam-se na ficha; a tabela só conta depois de aprovada por outra pessoa."
      formId="price-list-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar tabela' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Identificação">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input uppercase"
            name="code"
            data-testid="plf-code"
            [disabled]="!isNew()"
            [(ngModel)]="f.code"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input appControl class="input" name="name" data-testid="plf-name" [(ngModel)]="f.name" />
        </app-field>
        <app-field label="Moeda" [required]="true" [error]="action.field('currency')">
          <input
            appControl
            class="input w-24 uppercase"
            name="currency"
            maxlength="3"
            data-testid="plf-currency"
            [(ngModel)]="f.currency"
          />
        </app-field>
        <app-field
          label="Entidade legal"
          hint="Vazio: vale para todas."
          [error]="action.field('legalEntityId')"
        >
          <select appControl class="input" name="le" [(ngModel)]="f.legalEntityId">
            <option value="">Todas</option>
            @for (e of opts()?.legalEntities ?? []; track e.id) {
              <option [value]="e.id">{{ e.code }} — {{ e.name }}</option>
            }
          </select>
        </app-field>
      </app-form-section>
      <app-form-section
        title="Destino"
        description="Cliente antes de segmento antes de geral; no mesmo destino ganha a maior prioridade."
      >
        <app-field label="Para" [required]="true" [error]="action.field('targetType')">
          <select
            appControl
            class="input"
            name="target"
            data-testid="plf-target"
            [(ngModel)]="f.targetType"
          >
            @for (t of targets; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        @if (f.targetType === 'SEGMENT') {
          <app-field label="Segmento" [required]="true" [error]="action.field('segmentId')">
            <select
              appControl
              class="input"
              name="segment"
              data-testid="plf-segment"
              [(ngModel)]="f.segmentId"
            >
              <option value="">—</option>
              @for (s of opts()?.segments ?? []; track s.id) {
                <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
              }
            </select>
          </app-field>
        }
        @if (f.targetType === 'CUSTOMER') {
          <app-field #cf label="Cliente" [required]="true" [error]="action.field('customerId')">
            <app-autocomplete
              name="customer"
              data-testid="plf-customer"
              [inputId]="cf.controlId"
              [describedBy]="cf.describedBy()"
              [search]="searchCustomers"
              [initialLabel]="f.customerLabel || null"
              [(ngModel)]="f.customerId"
            />
          </app-field>
        }
        <app-field
          label="Prioridade"
          hint="0 a 1000; maior ganha."
          [error]="action.field('priority')"
        >
          <input
            appControl
            class="input w-28"
            type="number"
            min="0"
            max="1000"
            name="priority"
            data-testid="plf-priority"
            [(ngModel)]="f.priority"
          />
        </app-field>
      </app-form-section>
      <app-form-section title="Período">
        <app-field label="De" [required]="true" [error]="action.field('validFrom')">
          <input
            appControl
            class="input"
            type="date"
            name="from"
            data-testid="plf-from"
            [(ngModel)]="f.validFrom"
          />
        </app-field>
        <app-field label="Até" hint="Vazio: sem fim." [error]="action.field('validTo')">
          <input appControl class="input" type="date" name="to" [(ngModel)]="f.validTo" />
        </app-field>
        <app-field label="Notas" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class PriceListFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly list = signal<PriceList | null>(null);
  protected readonly opts = signal<PricingOptions | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly targets = Object.entries(LIST_TARGET);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected f: ListForm = emptyListForm(new Date().toISOString().slice(0, 10));
  private initial = snapshot(this.f);

  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string; status: string }[]>(
        'sales/pricing/search/customers',
        { q },
      )
    ).map((c) => ({
      id: c.id,
      label: `${c.code} — ${c.name}`,
      hint: c.status === 'ACTIVE' ? null : c.status,
    }));

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
      this.opts.set(await this.api.get<PricingOptions>('sales/pricing/options'));
      if (this.isNew()) this.f = emptyListForm(new Date().toISOString().slice(0, 10));
      else {
        const l = await this.api.get<PriceList>(`sales/price-lists/${this.id()}`);
        this.list.set(l);
        this.f = formFromList(l);
        this.breadcrumbs.setCurrent(l.code);
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const l = this.list();
    const body = listPayload(this.f, !l);
    const r = await this.action.run(() =>
      l
        ? this.api.patch<PriceList>(`sales/price-lists/${l.id}`, {
            ...body,
            expectedVersion: l.version,
          })
        : this.api.post<PriceList>('sales/price-lists', body),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show(l ? 'Tabela guardada.' : 'Tabela criada.');
    await this.router.navigate(['/vendas/precos', r.id], { replaceUrl: !l });
  }

  protected cancel() {
    const l = this.list();
    void this.router.navigate(l ? ['/vendas/precos', l.id] : ['/vendas/precos']);
  }
}
