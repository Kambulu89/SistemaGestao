import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { Input } from '../../../../shared/ui/input/input';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import {
  CustomersApi,
  type AddressDto,
  type ContactDto,
  type CustomerDto,
  type PaymentMethod,
  type TaxRegime,
} from './customers.api';
import { customerError, PAYMENT_METHOD_LABEL, TAX_REGIME_LABEL } from './customers-model';

const addressLabel = (a: AddressDto) =>
  `${a.line1}, ${a.city} (${a.type === 'BILLING' ? 'facturação' : a.type === 'DELIVERY' ? 'entrega' : 'outra'})`;

/**
 * Perfil de facturação do cliente: que morada e email da Party seguem nas facturas (instantâneo na emissão), a morada de
 * entrega, o meio de pagamento preferido e o regime fiscal. As moradas e os contactos são da Party; o servidor confirma
 * que pertencem à Party do cliente.
 */
@Component({
  selector: 'app-billing-profile-panel',
  imports: [FormsModule, Alert, Button, Card, Input, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h3 class="mb-2 mt-8 text-base font-semibold">Perfil de facturação</h3>
    <app-card data-testid="billing-profile">
      @if (error(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="grid gap-3 sm:grid-cols-2">
        <app-select
          label="Morada de facturação"
          placeholder="A de facturação principal da Party"
          [options]="addressOptions()"
          [ngModel]="billingAddressId()"
          (ngModelChange)="billingAddressId.set($event ?? '')"
        />
        <app-select
          label="Morada de entrega"
          placeholder="Sem morada de entrega"
          [options]="addressOptions()"
          [ngModel]="shippingAddressId()"
          (ngModelChange)="shippingAddressId.set($event ?? '')"
        />
        <app-select
          label="Email de facturação"
          placeholder="O email principal da Party"
          [options]="emailOptions()"
          [ngModel]="billingContactId()"
          (ngModelChange)="billingContactId.set($event ?? '')"
        />
        <app-select
          label="Meio de pagamento preferido"
          placeholder="Sem preferência"
          [options]="paymentOptions"
          [ngModel]="paymentMethod()"
          (ngModelChange)="paymentMethod.set($event ?? '')"
        />
        <app-select
          label="Regime fiscal"
          [options]="regimeOptions"
          [ngModel]="taxRegime()"
          (ngModelChange)="taxRegime.set($event ?? 'GENERAL')"
        />
        @if (taxRegime() === 'EXEMPT') {
          <app-input
            label="Motivo da isenção"
            [required]="true"
            [ngModel]="exemptionReason()"
            (ngModelChange)="exemptionReason.set($event ?? '')"
          />
        }
      </div>
      @if (addresses().length === 0 && emails().length === 0) {
        <p class="mt-3 text-sm text-fg-muted">
          A Party não tem moradas nem emails visíveis: acrescente-os em «Pessoas e entidades».
        </p>
      }
      @if (canEdit()) {
        <div class="mt-4">
          <app-button variant="secondary" [loading]="busy()" (click)="save()"
            >Guardar perfil de facturação</app-button
          >
        </div>
      }
    </app-card>
  `,
})
export class BillingProfilePanel {
  private readonly api = inject(CustomersApi);
  private readonly permissions = inject(PermissionService);

  readonly customer = input.required<CustomerDto>();
  readonly addresses = input<readonly AddressDto[]>([]);
  readonly contacts = input<readonly ContactDto[]>([]);
  readonly saved = output<CustomerDto>();

  protected readonly canEdit = computed(() => this.permissions.can('customer.update'));
  protected readonly emails = computed(() => this.contacts().filter((c) => c.type === 'EMAIL'));
  protected readonly addressOptions = computed<readonly SelectOption[]>(() =>
    this.addresses().map((a) => ({ value: a.id, label: addressLabel(a) })),
  );
  protected readonly emailOptions = computed<readonly SelectOption[]>(() =>
    this.emails().map((c) => ({ value: c.id, label: c.value })),
  );
  protected readonly paymentOptions: readonly SelectOption[] = (
    Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]
  ).map((value) => ({ value, label: PAYMENT_METHOD_LABEL[value] }));
  protected readonly regimeOptions: readonly SelectOption[] = (
    Object.keys(TAX_REGIME_LABEL) as TaxRegime[]
  ).map((value) => ({ value, label: TAX_REGIME_LABEL[value] }));

  protected readonly billingAddressId = signal('');
  protected readonly shippingAddressId = signal('');
  protected readonly billingContactId = signal('');
  protected readonly paymentMethod = signal('');
  protected readonly taxRegime = signal<TaxRegime>('GENERAL');
  protected readonly exemptionReason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Cada vez que chega um cliente (aberto ou gravado), o formulário mostra o que o servidor tem.
    effect(() => {
      const c = this.customer();
      this.billingAddressId.set(c.billingAddressId ?? '');
      this.shippingAddressId.set(c.shippingAddressId ?? '');
      this.billingContactId.set(c.billingContactId ?? '');
      this.paymentMethod.set(c.preferredPaymentMethod ?? '');
      this.taxRegime.set(c.taxRegime);
      this.exemptionReason.set(c.taxExemptionReason ?? '');
    });
  }

  protected save(): void {
    this.error.set(null);
    const exempt = this.taxRegime() === 'EXEMPT';
    const reason = this.exemptionReason().trim();
    if (exempt && !reason) return void this.error.set('Indique o motivo da isenção.');
    const c = this.customer();
    this.busy.set(true);
    this.api
      .updateCustomer(c.id, c.version, {
        billingAddressId: this.billingAddressId() || null,
        shippingAddressId: this.shippingAddressId() || null,
        billingContactId: this.billingContactId() || null,
        preferredPaymentMethod: (this.paymentMethod() || null) as PaymentMethod | null,
        taxRegime: this.taxRegime(),
        ...(exempt ? { taxExemptionReason: reason } : {}),
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (saved) => this.saved.emit(saved),
        error: (error: unknown) =>
          this.error.set(customerError(error, 'Não foi possível guardar o perfil de facturação.')),
      });
  }
}
