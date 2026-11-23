import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type Customer,
  type CustomerForm,
  customerPayload,
  emptyCustomerForm,
  formFromCustomer,
  PARTNER_TYPE,
  partnerChanges,
  type Segment,
} from './customer-model';

/**
 * Ficha do cliente: o terceiro (identificação fiscal, morada e contactos gerais) e as condições de venda. Um NIF que já
 * existe (ex.: o terceiro é fornecedor) é assinalado e pode ser reutilizado em vez de duplicado. O limite de crédito
 * define-se na ficha, por quem gere o crédito.
 */
@Component({
  selector: 'app-customer-form',
  imports: [FormsModule, RouterLink, EntityFormPage, FormSection, FormField, FieldControl],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Novo cliente' : 'Editar ' + (customer()?.partner?.code ?? '')"
      subtitle="O terceiro pode ser também fornecedor: a ficha é a mesma."
      formId="customer-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar cliente' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      @if (existing(); as e) {
        <div class="card mb-3" role="status" data-testid="cf-existing">
          <p class="text-sm">
            Já existe o terceiro <strong>{{ e.partner.code }} — {{ e.partner.name }}</strong> com
            este NIF.
          </p>
          @if (e.customerId) {
            <a class="link text-sm" [routerLink]="['/vendas/clientes', e.customerId]"
              >Já é cliente: abrir</a
            >
          } @else {
            <button
              type="button"
              class="btn-secondary mt-2"
              data-testid="cf-reuse"
              (click)="reuse(e.partner.id)"
            >
              Tornar este terceiro cliente
            </button>
          }
        </div>
      }
      <app-form-section title="Terceiro" description="Identificação fiscal e contactos gerais.">
        <app-field label="Código" [required]="true" [error]="action.field('partner.code')">
          <input appControl class="input" name="code" data-testid="cf-code" [(ngModel)]="f.code" />
        </app-field>
        <app-field
          label="Nome ou razão social"
          [required]="true"
          [error]="action.field('partner.name')"
        >
          <input appControl class="input" name="name" data-testid="cf-name" [(ngModel)]="f.name" />
        </app-field>
        <app-field
          label="Tipo de pessoa"
          [required]="true"
          [error]="action.field('partner.partnerType')"
        >
          <select
            appControl
            class="input"
            name="partnerType"
            data-testid="cf-type"
            [(ngModel)]="f.partnerType"
          >
            @for (t of partnerTypes; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="País fiscal"
          [required]="true"
          hint="Código ISO de 2 letras."
          [error]="action.field('partner.countryCode')"
        >
          <input
            appControl
            class="input w-24"
            name="countryCode"
            maxlength="2"
            [(ngModel)]="f.countryCode"
          />
        </app-field>
        <app-field label="NIF" hint="Único por país." [error]="action.field('partner.taxId')">
          <input
            appControl
            class="input"
            name="taxId"
            data-testid="cf-taxid"
            [(ngModel)]="f.taxId"
            (blur)="checkTaxId()"
          />
        </app-field>
        <app-field label="E-mail" [error]="action.field('partner.email')">
          <input appControl class="input" type="email" name="email" [(ngModel)]="f.email" />
        </app-field>
        <app-field label="Telefone" [error]="action.field('partner.phone')">
          <input appControl class="input" name="phone" [(ngModel)]="f.phone" />
        </app-field>
        <app-field label="Morada" [error]="action.field('partner.addressLine')">
          <input
            appControl
            class="input"
            name="addressLine"
            data-testid="cf-address"
            [(ngModel)]="f.addressLine"
          />
        </app-field>
        <app-field label="Cidade" [error]="action.field('partner.city')">
          <input appControl class="input" name="city" [(ngModel)]="f.city" />
        </app-field>
        <app-field label="Província" [error]="action.field('partner.province')">
          <input appControl class="input" name="province" [(ngModel)]="f.province" />
        </app-field>
        <app-field label="Código postal" [error]="action.field('partner.postalCode')">
          <input appControl class="input" name="postalCode" [(ngModel)]="f.postalCode" />
        </app-field>
      </app-form-section>

      <app-form-section
        title="Condições de venda"
        description="Usadas por omissão nas propostas, encomendas e facturas."
      >
        <app-field label="Moeda" [required]="true" [error]="action.field('currency')">
          <input
            appControl
            class="input w-24"
            name="currency"
            maxlength="3"
            data-testid="cf-currency"
            [(ngModel)]="f.currency"
          />
        </app-field>
        <app-field label="Prazo de pagamento (dias)" [error]="action.field('paymentTermsDays')">
          <input
            appControl
            class="input w-28"
            type="number"
            min="0"
            max="365"
            name="terms"
            data-testid="cf-terms"
            [(ngModel)]="f.paymentTermsDays"
          />
        </app-field>
        <app-field label="Segmento" [error]="action.field('segmentId')">
          <select
            appControl
            class="input"
            name="segment"
            data-testid="cf-segment"
            [(ngModel)]="f.segmentId"
          >
            <option value="">Nenhum</option>
            @for (s of segments(); track s.id) {
              <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Notas" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class CustomerFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly customer = signal<Customer | null>(null);
  protected readonly segments = signal<Segment[]>([]);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly existing = signal<{
    partner: { id: string; code: string; name: string };
    customerId: string | null;
  } | null>(null);
  protected readonly action = new Action();
  protected f: CustomerForm = emptyCustomerForm();
  private initial = snapshot(this.f);
  private base: CustomerForm = emptyCustomerForm();
  protected readonly partnerTypes = Object.entries(PARTNER_TYPE);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');

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
      const segs = await this.api.get<Segment[]>('sales/segments').catch(() => [] as Segment[]);
      this.segments.set(segs.filter((s) => s.status === 'ACTIVE'));
      if (this.isNew()) {
        this.f = emptyCustomerForm();
      } else {
        const c = await this.api.get<Customer>(`sales/customers/${this.id()}`);
        this.customer.set(c);
        this.f = formFromCustomer(c);
        this.base = formFromCustomer(c);
        if (c.segment && !this.segments().some((s) => s.id === c.segment!.id))
          this.segments.update((l) => [
            ...l,
            { ...c.segment!, version: 0, description: null, status: 'INACTIVE', customers: 0 },
          ]);
        this.breadcrumbs.setCurrent(c.partner.code);
      }
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected async checkTaxId() {
    if (!this.isNew() || this.f.taxId.trim().length < 5 || this.f.countryCode.trim().length !== 2) {
      this.existing.set(null);
      return;
    }
    try {
      const r = await this.api.get<{
        partner: { id: string; code: string; name: string } | null;
        customerId: string | null;
      }>('sales/customers/lookup', {
        countryCode: this.f.countryCode.trim().toUpperCase(),
        taxId: this.f.taxId.trim(),
      });
      this.existing.set(r.partner ? { partner: r.partner, customerId: r.customerId } : null);
    } catch {
      this.existing.set(null);
    }
  }

  protected async reuse(partnerId: string) {
    const b = customerPayload(this.f);
    const r = await this.action.run(() =>
      this.api.post<Customer>('sales/customers', {
        partnerId,
        currency: b.currency,
        paymentTermsDays: b.paymentTermsDays,
        segmentId: b.segmentId,
        notes: b.notes,
      }),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show('Cliente criado a partir do terceiro existente.');
    await this.router.navigate(['/vendas/clientes', r.id], { replaceUrl: true });
  }

  protected async save() {
    const c = this.customer();
    const body = customerPayload(this.f);
    const r = await this.action.run(() => {
      if (!c) return this.api.post<Customer>('sales/customers', body);
      const changes = partnerChanges(this.base, this.f);
      const conditions = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'partner'));
      return this.api.patch<Customer>(`sales/customers/${c.id}`, {
        ...conditions,
        expectedVersion: c.version,
        ...(Object.keys(changes).length
          ? { partner: { ...changes, expectedVersion: c.partner.version } }
          : {}),
      });
    });
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show(c ? 'Cliente guardado.' : 'Cliente criado.');
    await this.router.navigate(['/vendas/clientes', r.id], { replaceUrl: !c });
  }

  protected cancel() {
    const c = this.customer();
    void this.router.navigate(c ? ['/vendas/clientes', c.id] : ['/vendas/clientes']);
  }
}
