import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  emptySupplierForm,
  formFromSupplier,
  PARTNER_TYPE,
  partnerChanges,
  PAYMENT_METHOD,
  type Supplier,
  type SupplierForm,
  supplierPayload,
  SUPPLIER_TYPE,
} from './supplier-model';

/**
 * Ficha do fornecedor: o terceiro (identificação fiscal, morada e contactos gerais) e as condições comerciais. Ao
 * criar, um NIF que já existe (ex.: o terceiro é cliente) é assinalado e pode ser reutilizado em vez de duplicado.
 */
@Component({
  selector: 'app-supplier-form',
  imports: [FormsModule, RouterLink, EntityFormPage, FormSection, FormField, FieldControl],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Novo fornecedor' : 'Editar ' + (supplier()?.partner?.code ?? '')"
      subtitle="O terceiro pode ser também cliente: a ficha é a mesma."
      formId="supplier-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar fornecedor' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      @if (existing(); as e) {
        <div class="card mb-3 border-warning-text" role="status" data-testid="sf-existing">
          <p class="text-sm">
            Já existe o terceiro <strong>{{ e.partner.code }} — {{ e.partner.name }}</strong> com
            este NIF.
          </p>
          @if (e.supplierId) {
            <a class="link text-sm" [routerLink]="['/compras/fornecedores', e.supplierId]"
              >Já é fornecedor: abrir</a
            >
          } @else {
            <button
              type="button"
              class="btn-secondary mt-2"
              data-testid="sf-reuse"
              (click)="reuse(e.partner.id)"
            >
              Tornar este terceiro fornecedor
            </button>
          }
        </div>
      }
      <app-form-section title="Terceiro" description="Identificação fiscal e contactos gerais.">
        <app-field label="Código" [required]="true" [error]="action.field('partner.code')">
          <input appControl class="input" name="code" data-testid="sf-code" [(ngModel)]="f.code" />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('partner.name')">
          <input appControl class="input" name="name" data-testid="sf-name" [(ngModel)]="f.name" />
        </app-field>
        <app-field
          label="Tipo de pessoa"
          [required]="true"
          [error]="action.field('partner.partnerType')"
        >
          <select appControl class="input" name="partnerType" [(ngModel)]="f.partnerType">
            @for (t of partnerTypes; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="País"
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
        <app-field
          label="NIF"
          [hint]="
            locked() ? 'Fornecedor homologado ou em aprovação: o NIF não muda.' : 'Único por país.'
          "
          [error]="action.field('partner.taxId')"
        >
          <input
            appControl
            class="input"
            name="taxId"
            data-testid="sf-taxid"
            [(ngModel)]="f.taxId"
            [disabled]="locked()"
            (blur)="checkTaxId()"
          />
        </app-field>
        <app-field label="E-mail" [error]="action.field('partner.email')">
          <input appControl class="input" type="email" name="email" [(ngModel)]="f.email" />
        </app-field>
        <app-field label="Telefone" [error]="action.field('partner.phone')">
          <input appControl class="input" name="phone" [(ngModel)]="f.phone" />
        </app-field>
        <app-field label="Sítio na Internet" [error]="action.field('partner.website')">
          <input appControl class="input" name="website" [(ngModel)]="f.website" />
        </app-field>
        <app-field label="Morada" [error]="action.field('partner.addressLine')">
          <input appControl class="input" name="addressLine" [(ngModel)]="f.addressLine" />
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
        title="Condições comerciais"
        description="Usadas por omissão nas cotações e ordens de compra."
      >
        <app-field
          label="Tipo de fornecedor"
          [required]="true"
          [error]="action.field('supplierType')"
        >
          <select
            appControl
            class="input"
            name="supplierType"
            data-testid="sf-type"
            [(ngModel)]="f.supplierType"
          >
            @for (t of supplierTypes; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Moeda" [required]="true" [error]="action.field('currency')">
          <input
            appControl
            class="input w-24"
            name="currency"
            maxlength="3"
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
            data-testid="sf-terms"
            [(ngModel)]="f.paymentTermsDays"
          />
        </app-field>
        <app-field label="Meio de pagamento" [error]="action.field('paymentMethod')">
          <select appControl class="input" name="paymentMethod" [(ngModel)]="f.paymentMethod">
            @for (t of paymentMethods; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Prazo de entrega (dias)" [error]="action.field('leadTimeDays')">
          <input
            appControl
            class="input w-28"
            type="number"
            min="0"
            max="730"
            name="lead"
            [(ngModel)]="f.leadTimeDays"
          />
        </app-field>
        <app-field label="Encomenda mínima" [error]="action.field('minOrderAmount')">
          <input
            appControl
            class="input w-40"
            inputmode="decimal"
            name="minOrder"
            [(ngModel)]="f.minOrderAmount"
          />
        </app-field>
        <app-field label="Incoterm" hint="Ex.: FOB, CIF." [error]="action.field('incoterm')">
          <input
            appControl
            class="input w-24"
            name="incoterm"
            maxlength="3"
            [(ngModel)]="f.incoterm"
          />
        </app-field>
        <app-field label="Notas" [error]="action.field('notes')">
          <textarea appControl class="input min-h-16" name="notes" [(ngModel)]="f.notes"></textarea>
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class SupplierFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly supplier = signal<Supplier | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly existing = signal<{
    partner: { id: string; code: string; name: string };
    supplierId: string | null;
  } | null>(null);
  protected readonly action = new Action();
  protected f: SupplierForm = emptySupplierForm();
  private initial = snapshot(this.f);
  private base: SupplierForm = emptySupplierForm();
  protected readonly partnerTypes = Object.entries(PARTNER_TYPE);
  protected readonly supplierTypes = Object.entries(SUPPLIER_TYPE);
  protected readonly paymentMethods = Object.entries(PAYMENT_METHOD);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected readonly locked = computed(() =>
    ['APPROVED', 'PENDING_APPROVAL'].includes(this.supplier()?.status ?? ''),
  );

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return (
      this.loaded() &&
      this.workspace.can('procurement.suppliers.manage') &&
      snapshot(this.f) !== this.initial
    );
  }

  protected async load() {
    this.loadError.set(null);
    if (this.isNew()) {
      this.f = emptySupplierForm();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const s = await this.api.get<Supplier>(`procurement/suppliers/${this.id()}`);
      this.supplier.set(s);
      this.f = formFromSupplier(s);
      this.base = formFromSupplier(s);
      this.initial = snapshot(this.f);
      this.breadcrumbs.setCurrent(s.partner.code);
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
        supplierId: string | null;
      }>('procurement/suppliers/lookup', {
        countryCode: this.f.countryCode.trim().toUpperCase(),
        taxId: this.f.taxId.trim(),
      });
      this.existing.set(r.partner ? { partner: r.partner, supplierId: r.supplierId } : null);
    } catch {
      this.existing.set(null);
    }
  }

  protected async reuse(partnerId: string) {
    const body = supplierPayload(this.f);
    const r = await this.action.run(() =>
      this.api.post<Supplier>('procurement/suppliers', {
        partnerId,
        supplierType: body.supplierType,
        currency: body.currency,
        paymentTermsDays: body.paymentTermsDays,
        paymentMethod: body.paymentMethod,
        leadTimeDays: body.leadTimeDays,
        minOrderAmount: body.minOrderAmount,
        incoterm: body.incoterm,
        notes: body.notes,
      }),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show('Fornecedor criado a partir do terceiro existente.');
    await this.router.navigate(['/compras/fornecedores', r.id], { replaceUrl: true });
  }

  protected async save() {
    const s = this.supplier();
    const body = supplierPayload(this.f);
    const r = await this.action.run(() => {
      if (!s) return this.api.post<Supplier>('procurement/suppliers', body);
      const changes = partnerChanges(this.base, this.f);
      const conditions = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'partner'));
      return this.api.patch<Supplier>(`procurement/suppliers/${s.id}`, {
        ...conditions,
        expectedVersion: s.version,
        ...(Object.keys(changes).length
          ? { partner: { ...changes, expectedVersion: s.partner.version } }
          : {}),
      });
    });
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show(s ? 'Fornecedor guardado.' : 'Fornecedor criado.');
    await this.router.navigate(['/compras/fornecedores', r.id], { replaceUrl: !s });
  }

  protected cancel() {
    const s = this.supplier();
    void this.router.navigate(s ? ['/compras/fornecedores', s.id] : ['/compras/fornecedores']);
  }
}
