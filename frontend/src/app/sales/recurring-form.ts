import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { FREQUENCY, type Recurring, type RecurringOptions, TIMING } from './recurring-model';

/** Contrato recorrente: dados do contrato (as linhas e preços são versões, aprovadas à parte). */
@Component({
  selector: 'app-recurring-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Autocomplete],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Novo contrato recorrente' : 'Editar contrato'"
      subtitle="As linhas e os preços entram em versões, aprovadas por outra pessoa."
      formId="recurring-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar contrato' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Contrato">
        <app-field label="Referência" [required]="true" [error]="action.field('reference')">
          <input
            appControl
            class="input"
            name="ref"
            data-testid="rf-reference"
            [disabled]="locked()"
            [(ngModel)]="f.reference"
          />
        </app-field>
        <app-field label="Descrição" [required]="true" [error]="action.field('description')">
          <input
            appControl
            class="input"
            name="desc"
            data-testid="rf-description"
            [(ngModel)]="f.description"
          />
        </app-field>
        @if (isNew()) {
          <app-field label="Entidade" [required]="true" [error]="action.field('legalEntityId')">
            <select
              appControl
              class="input"
              name="le"
              data-testid="rf-le"
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
              data-testid="rf-customer"
              [inputId]="cf.controlId"
              [describedBy]="cf.describedBy()"
              [search]="searchCustomers"
              [(ngModel)]="f.customerId"
            />
          </app-field>
        }
        <app-field label="Periodicidade" [required]="true" [error]="action.field('frequency')">
          <select
            appControl
            class="input"
            name="freq"
            data-testid="rf-frequency"
            [disabled]="locked()"
            [(ngModel)]="f.frequency"
          >
            @for (x of frequencies; track x[0]) {
              <option [value]="x[0]">{{ x[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Facturar" [required]="true" [error]="action.field('billingTiming')">
          <select
            appControl
            class="input"
            name="timing"
            data-testid="rf-timing"
            [disabled]="locked()"
            [(ngModel)]="f.billingTiming"
          >
            @for (x of timings; track x[0]) {
              <option [value]="x[0]">{{ x[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Início" [required]="true" [error]="action.field('startDate')">
          <input
            appControl
            class="input"
            type="date"
            name="start"
            data-testid="rf-start"
            [disabled]="locked()"
            [(ngModel)]="f.startDate"
          />
        </app-field>
        <app-field label="Fim" hint="Vazio: sem fim." [error]="action.field('endDate')">
          <input
            appControl
            class="input"
            type="date"
            name="end"
            data-testid="rf-end"
            [(ngModel)]="f.endDate"
          />
        </app-field>
        <app-field label="Prazo de pagamento (dias)" [error]="action.field('paymentTermsDays')">
          <input
            appControl
            class="input w-24"
            type="number"
            min="0"
            max="365"
            name="terms"
            [(ngModel)]="f.paymentTermsDays"
          />
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class RecurringFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly opts = signal<RecurringOptions | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly current = signal<Recurring | null>(null);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected readonly locked = computed(
    () => !!this.current() && this.current()!.status !== 'DRAFT',
  );
  protected readonly frequencies = Object.entries(FREQUENCY);
  protected readonly timings = Object.entries(TIMING);
  protected f = {
    reference: '',
    description: '',
    legalEntityId: '',
    customerId: '',
    frequency: 'MONTHLY',
    billingTiming: 'ADVANCE',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
    paymentTermsDays: 30 as number | string,
  };
  private initial = '';
  protected readonly searchCustomers = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; code: string; name: string }[]>(
        'sales/recurring/search/customers',
        { q },
      )
    ).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));

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
      const o = await this.api.get<RecurringOptions>('sales/recurring/options');
      this.opts.set(o);
      if (this.isNew()) {
        if (o.legalEntities.length === 1) this.f.legalEntityId = o.legalEntities[0].id;
      } else {
        const c = await this.api.get<Recurring>(`sales/recurring/${this.id()}`);
        this.current.set(c);
        this.f = {
          reference: c.reference,
          description: c.description,
          legalEntityId: c.legalEntity.id,
          customerId: c.customer.id,
          frequency: c.frequency,
          billingTiming: c.billingTiming,
          startDate: c.startDate,
          endDate: c.endDate ?? '',
          paymentTermsDays: c.paymentTermsDays,
        };
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const f = this.f;
    const common = {
      description: f.description,
      endDate: f.endDate || null,
      paymentTermsDays: Number(f.paymentTermsDays),
    };
    const structural = {
      reference: f.reference,
      frequency: f.frequency,
      billingTiming: f.billingTiming,
      startDate: f.startDate,
    };
    const r = await this.action.run(() =>
      this.isNew()
        ? this.api.post<Recurring>('sales/recurring', {
            ...common,
            ...structural,
            legalEntityId: f.legalEntityId,
            customerId: f.customerId,
          })
        : this.api.patch<Recurring>(`sales/recurring/${this.id()}`, {
            ...common,
            ...(this.locked() ? {} : structural),
            expectedVersion: this.current()!.version,
          }),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show(
      this.isNew() ? 'Contrato criado: acrescente a primeira versão.' : 'Contrato guardado.',
    );
    await this.router.navigate(['/vendas/recorrentes', r.id], { replaceUrl: true });
  }
  protected cancel() {
    void this.router.navigate(
      this.current() ? ['/vendas/recorrentes', this.current()!.id] : ['/vendas/recorrentes'],
    );
  }
}
