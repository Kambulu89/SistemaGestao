import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import {
  ADDRESS_KIND,
  type AddressKind,
  addressLine,
  type Customer,
  type CustomerAddress,
  CUSTOMER_EVENT,
  CUSTOMER_STATUS,
  type CustomerStatus,
  customerTone,
  PARTNER_TYPE,
} from './customer-model';
import { plain } from '../procurement/rfq-model';

type Dialog = 'status' | 'credit' | 'address' | 'contact' | null;

/**
 * Cliente (10.1): estado, condições de venda, limite de crédito (quem gere o crédito, com motivo), moradas de
 * facturação e entrega, contactos, versões imutáveis dos dados fiscais usados nos documentos, anexos, cronologia e
 * auditoria.
 */
@Component({
  selector: 'app-customer-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    AuditHistory,
    Attachments,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? x()!.partner.code + ' — ' + x()!.partner.name : 'Cliente'"
      [subtitle]="
        x() ? partnerType(x()!) + (x()!.partner.taxId ? ' · NIF ' + x()!.partner.taxId : '') : ''
      "
      formId="customer-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as c) {
        <section class="card space-y-3" aria-label="Estado" data-testid="cd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(c.status)" data-testid="cd-status">{{
              status(c.status)
            }}</span>
            @if (c.alsoSupplier) {
              <span class="badge bg-surface-2 text-muted">Também fornecedor</span>
            }
            @if (c.statusReason) {
              <span class="text-sm text-muted">{{ c.statusReason }}</span>
            }
          </div>
          <dl class="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">Moeda</dt>
              <dd>{{ c.currency }}</dd>
            </div>
            <div>
              <dt class="text-muted">Prazo de pagamento</dt>
              <dd>{{ c.paymentTermsDays }} dias</dd>
            </div>
            <div>
              <dt class="text-muted">Limite de crédito</dt>
              <dd data-testid="cd-credit">
                {{ c.creditLimit === null ? 'Sem limite' : money(c.creditLimit, c.currency) }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Segmento</dt>
              <dd>{{ c.segment ? c.segment.code + ' — ' + c.segment.name : '—' }}</dd>
            </div>
          </dl>
          @if (c.notes) {
            <p class="whitespace-pre-line text-sm">{{ c.notes }}</p>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (c.can.manage) {
              <a
                class="btn-secondary"
                data-testid="cd-edit"
                [routerLink]="['/vendas/clientes', c.id, 'editar']"
                >Editar</a
              >
              @if (c.status !== 'BLOCKED') {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="cd-block"
                  (click)="openStatus('BLOCKED')"
                >
                  Bloquear
                </button>
              }
              @if (c.status !== 'ACTIVE') {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="cd-activate"
                  (click)="openStatus('ACTIVE')"
                >
                  Reactivar
                </button>
              }
              @if (c.status !== 'INACTIVE') {
                <button type="button" class="btn-secondary" (click)="openStatus('INACTIVE')">
                  Inactivar
                </button>
              }
            }
            @if (c.can.credit) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-credit-edit"
                (click)="openCredit(c)"
              >
                Limite de crédito
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="cd-ad-title">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h2 id="cd-ad-title" class="font-semibold">Moradas</h2>
            @if (c.can.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-address-new"
                (click)="openAddress(null)"
              >
                Nova morada
              </button>
            }
          </div>
          <ul class="space-y-1 text-sm" data-testid="cd-addresses">
            @for (a of c.addresses; track a.id) {
              <li [class.text-muted]="a.status !== 'ACTIVE'">
                <span class="badge bg-surface-2 text-muted">{{ kind(a.kind) }}</span>
                <strong>{{ a.label }}</strong> · {{ line(a) }}
                @if (a.isDefault) {
                  <span class="badge bg-success-soft text-success-text">Por omissão</span>
                }
                @if (a.status !== 'ACTIVE') {
                  · inactiva
                }
                @if (c.can.manage) {
                  <button
                    type="button"
                    class="link ml-2"
                    [attr.aria-label]="'Editar ' + a.label"
                    (click)="openAddress(a)"
                  >
                    Editar
                  </button>
                }
              </li>
            } @empty {
              <li class="text-muted">
                Sem moradas próprias: a facturação usa a morada do terceiro.
              </li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="cd-ct-title">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h2 id="cd-ct-title" class="font-semibold">Contactos</h2>
            @if (c.can.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-contact-new"
                (click)="openContact()"
              >
                Novo contacto
              </button>
            }
          </div>
          <ul class="space-y-1 text-sm" data-testid="cd-contacts">
            @if (c.partner.email || c.partner.phone) {
              <li class="text-muted">
                Geral: {{ c.partner.email ?? '' }} {{ c.partner.phone ?? '' }}
              </li>
            }
            @for (p of c.partner.contacts; track p.id) {
              <li>
                {{ p.name }}{{ p.role ? ' · ' + p.role : '' }}{{ p.email ? ' · ' + p.email : ''
                }}{{ p.phone ? ' · ' + p.phone : '' }}
                @if (p.isPrimary) {
                  <span class="badge bg-success-soft text-success-text">Principal</span>
                }
              </li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="cd-v-title">
          <h2 id="cd-v-title" class="mb-1 font-semibold">Versões dos dados fiscais</h2>
          <p class="mb-2 text-xs text-muted">
            Cada documento de venda guarda a versão que usou; mudar o nome, o NIF ou a morada de
            facturação cria uma versão nova e as anteriores não mudam.
          </p>
          <ol class="space-y-2 text-sm" data-testid="cd-versions">
            @for (v of c.versions; track v.id) {
              <li>
                <strong>Versão {{ v.versionNo }}</strong> · {{ when(v.at)
                }}{{ v.by ? ' · ' + v.by : '' }}
                <span class="block text-muted">
                  {{ v.data.name }} · NIF {{ v.data.taxId ?? '—' }} ·
                  {{ line(v.data.billingAddress) }}
                </span>
              </li>
            }
          </ol>
        </section>

        <app-attachments subjectType="customer" [subjectId]="c.id" [canWrite]="c.can.manage" />

        <section class="card" aria-labelledby="cd-h-title">
          <h2 id="cd-h-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="cd-history">
            @for (h of c.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ event(h.kind) }}
                @if (h.to) {
                  · {{ status($any(h.to)) }}
                }
                @if (h.by) {
                  · {{ h.by }}
                }
                @if (h.reason) {
                  · <em>{{ h.reason }}</em>
                }
              </li>
            }
          </ul>
        </section>

        <app-audit-history entityType="customer" [entityId]="c.id" [refreshKey]="c.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @switch (dialog()) {
        @case ('status') {
          @if (target !== 'ACTIVE') {
            <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
              <textarea
                appControl
                class="input min-h-16"
                name="reason"
                data-testid="cd-reason"
                [(ngModel)]="reason"
              ></textarea>
            </app-field>
          } @else {
            <p class="text-sm">O cliente volta a poder receber documentos de venda.</p>
          }
        }
        @case ('credit') {
          <div class="space-y-3">
            <app-field
              label="Limite de crédito"
              hint="Vazio = sem limite."
              [error]="act.field('creditLimit')"
            >
              <input
                appControl
                class="input w-48"
                inputmode="decimal"
                name="credit"
                data-testid="cd-credit-value"
                [(ngModel)]="credit"
              />
            </app-field>
            <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
              <textarea
                appControl
                class="input min-h-16"
                name="creason"
                data-testid="cd-credit-reason"
                [(ngModel)]="reason"
              ></textarea>
            </app-field>
          </div>
        }
        @case ('address') {
          <div class="space-y-3">
            @if (!addr.id) {
              <app-field label="Tipo" [required]="true" [error]="act.field('kind')">
                <select
                  appControl
                  class="input"
                  name="kind"
                  data-testid="cd-a-kind"
                  [(ngModel)]="addr.kind"
                >
                  @for (k of kinds; track k[0]) {
                    <option [value]="k[0]">{{ k[1] }}</option>
                  }
                </select>
              </app-field>
            }
            <app-field label="Designação" [required]="true" [error]="act.field('label')">
              <input
                appControl
                class="input"
                name="label"
                data-testid="cd-a-label"
                [(ngModel)]="addr.label"
              />
            </app-field>
            <app-field label="Morada" [required]="true" [error]="act.field('addressLine')">
              <input
                appControl
                class="input"
                name="line"
                data-testid="cd-a-line"
                [(ngModel)]="addr.addressLine"
              />
            </app-field>
            <app-field label="Município" [error]="act.field('municipality')">
              <input appControl class="input" name="municipality" [(ngModel)]="addr.municipality" />
            </app-field>
            <app-field label="Cidade" [error]="act.field('city')">
              <input appControl class="input" name="city" [(ngModel)]="addr.city" />
            </app-field>
            <app-field label="Província" [error]="act.field('province')">
              <input appControl class="input" name="province" [(ngModel)]="addr.province" />
            </app-field>
            <app-field label="País" [required]="true" [error]="act.field('countryCode')">
              <input
                appControl
                class="input w-24"
                name="country"
                maxlength="2"
                [(ngModel)]="addr.countryCode"
              />
            </app-field>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="default"
                data-testid="cd-a-default"
                [(ngModel)]="addr.isDefault"
              />
              Por omissão para este tipo
            </label>
            @if (addr.id) {
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" name="inactive" [(ngModel)]="addr.inactive" />
                Inactiva
              </label>
            }
          </div>
        }
        @case ('contact') {
          <div class="space-y-3">
            <app-field label="Nome" [required]="true" [error]="act.field('name')">
              <input
                appControl
                class="input"
                name="cname"
                data-testid="cd-c-name"
                [(ngModel)]="contact.name"
              />
            </app-field>
            <app-field label="Função" [error]="act.field('role')">
              <input appControl class="input" name="crole" [(ngModel)]="contact.role" />
            </app-field>
            <app-field label="E-mail" [error]="act.field('email')">
              <input
                appControl
                class="input"
                type="email"
                name="cemail"
                data-testid="cd-c-email"
                [(ngModel)]="contact.email"
              />
            </app-field>
            <app-field label="Telefone" [error]="act.field('phone')">
              <input appControl class="input" name="cphone" [(ngModel)]="contact.phone" />
            </app-field>
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" name="cprimary" [(ngModel)]="contact.isPrimary" />
              Contacto principal
            </label>
          </div>
        }
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="cd-ok"
          [disabled]="act.busy()"
          (click)="confirm()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class CustomerDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Customer | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly act = new Action();
  protected readonly money = money;
  protected readonly when = formatDateTime;
  protected readonly tone = customerTone;
  protected readonly line = addressLine;
  protected readonly kinds = Object.entries(ADDRESS_KIND) as [AddressKind, string][];
  protected readonly status = (s: CustomerStatus) => CUSTOMER_STATUS[s] ?? s;
  protected readonly kind = (k: AddressKind) => ADDRESS_KIND[k];
  protected readonly event = (k: string) => CUSTOMER_EVENT[k] ?? k;
  protected readonly partnerType = (c: Customer) => PARTNER_TYPE[c.partner.partnerType];
  protected target: CustomerStatus = 'BLOCKED';
  protected reason = '';
  protected credit = '';
  protected addr = this.blankAddress();
  protected contact = { name: '', role: '', email: '', phone: '', isPrimary: false };

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private blankAddress() {
    return {
      id: '',
      version: 0,
      kind: 'BILLING' as AddressKind,
      label: '',
      addressLine: '',
      municipality: '',
      city: '',
      province: '',
      countryCode: 'AO',
      isDefault: false,
      inactive: false,
    };
  }

  protected dialogTitle() {
    switch (this.dialog()) {
      case 'status':
        return this.target === 'ACTIVE'
          ? 'Reactivar o cliente'
          : this.target === 'BLOCKED'
            ? 'Bloquear o cliente'
            : 'Inactivar o cliente';
      case 'credit':
        return 'Limite de crédito';
      case 'address':
        return this.addr.id ? 'Editar morada' : 'Nova morada';
      case 'contact':
        return 'Novo contacto';
      default:
        return '';
    }
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<Customer>(`sales/customers/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(c: Customer) {
    this.x.set(c);
    this.breadcrumbs.setCurrent(c.partner.code);
  }
  protected back() {
    void this.router.navigate(['/vendas/clientes']);
  }

  private open(d: Dialog) {
    this.act.error.set(null);
    this.dialog.set(d);
  }
  protected openStatus(s: CustomerStatus) {
    this.target = s;
    this.reason = '';
    this.open('status');
  }
  protected openCredit(c: Customer) {
    this.credit = c.creditLimit === null ? '' : plain(c.creditLimit);
    this.reason = '';
    this.open('credit');
  }
  protected openAddress(a: CustomerAddress | null) {
    this.addr = a
      ? {
          id: a.id,
          version: a.version,
          kind: a.kind,
          label: a.label,
          addressLine: a.addressLine,
          municipality: a.municipality ?? '',
          city: a.city ?? '',
          province: a.province ?? '',
          countryCode: a.countryCode,
          isDefault: a.isDefault,
          inactive: a.status !== 'ACTIVE',
        }
      : this.blankAddress();
    this.open('address');
  }
  protected openContact() {
    this.contact = { name: '', role: '', email: '', phone: '', isPrimary: false };
    this.open('contact');
  }

  protected async confirm() {
    const c = this.x()!;
    const base = `sales/customers/${c.id}`;
    const nz = (v: string) => (v.trim() === '' ? null : v.trim());
    let req: () => Promise<Customer>;
    let done: string;
    switch (this.dialog()) {
      case 'status':
        req = () =>
          this.api.post<Customer>(`${base}/status`, {
            expectedVersion: c.version,
            status: this.target,
            reason: this.reason,
          });
        done = 'Estado alterado.';
        break;
      case 'credit':
        req = () =>
          this.api.post<Customer>(`${base}/credit`, {
            expectedVersion: c.version,
            creditLimit: this.credit.trim(),
            reason: this.reason,
          });
        done = 'Limite de crédito guardado.';
        break;
      case 'address': {
        const a = this.addr;
        const fields = {
          label: a.label,
          addressLine: a.addressLine,
          municipality: nz(a.municipality),
          city: nz(a.city),
          province: nz(a.province),
          countryCode: a.countryCode,
          isDefault: a.isDefault,
        };
        req = () =>
          a.id
            ? this.api.patch<Customer>(`${base}/addresses/${a.id}`, {
                ...fields,
                status: a.inactive ? 'INACTIVE' : 'ACTIVE',
                expectedVersion: a.version,
              })
            : this.api.post<Customer>(`${base}/addresses`, { ...fields, kind: a.kind });
        done = 'Morada guardada.';
        break;
      }
      case 'contact':
        req = () =>
          this.api.post<Customer>(`${base}/contacts`, {
            name: this.contact.name,
            role: nz(this.contact.role),
            email: nz(this.contact.email),
            phone: nz(this.contact.phone),
            isPrimary: this.contact.isPrimary,
          });
        done = 'Contacto acrescentado.';
        break;
      default:
        return;
    }
    const res = await this.act.run(req);
    if (!res) return;
    this.set(res);
    this.dialog.set(null);
    this.toasts.show(done);
  }
}
