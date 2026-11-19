import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  BANK_STATUS,
  type BankAccount,
  bankTone,
  EVENT,
  PARTNER_TYPE,
  PAYMENT_METHOD,
  qualificationText,
  RESULT,
  type Supplier,
  type SupplierDocument,
  SUPPLIER_STATUS,
  SUPPLIER_TYPE,
  supplierTone,
} from './supplier-model';

type ReasonKind = 'reject' | 'suspend' | 'bank-reject' | 'bank-deactivate' | 'doc-deactivate';
type FormKind = 'contact' | 'bank' | 'document' | 'submit';

/**
 * Fornecedor (9.1): estado e validade da homologação, condições, contactos, dados bancários protegidos (pendentes até
 * outra pessoa aprovar; mascarados sem permissão), documentos com validade e anexo, pedidos de homologação com a
 * avaliação de cada critério, histórico e auditoria. O servidor decide o que cada pessoa pode fazer (`can`).
 */
@Component({
  selector: 'app-supplier-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    Attachments,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="title()"
      [subtitle]="subtitle()"
      formId="supplier-detail"
      [loading]="!s()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (s(); as x) {
        <section class="card space-y-3" aria-label="Estado" data-testid="sd-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(x.status)" data-testid="sd-status">{{
              statusLabel(x.status)
            }}</span>
            @if (x.approvedAt) {
              <span class="text-sm text-muted">Homologado em {{ date(x.approvedAt) }}</span>
            }
          </div>
          <p
            class="text-sm"
            [class.text-danger-text]="!x.qualification.valid"
            [class.text-success-text]="x.qualification.valid"
            data-testid="sd-qualification"
          >
            {{ qualification(x) }}
          </p>
          <div class="flex flex-wrap gap-2">
            @if (x.can.manage) {
              <a
                class="btn-secondary"
                [routerLink]="['/compras/fornecedores', x.id, 'editar']"
                data-testid="sd-edit"
                >Editar ficha</a
              >
            }
            @if (x.can.submit) {
              <button
                type="button"
                class="btn-primary"
                data-testid="sd-submit"
                (click)="openForm('submit')"
              >
                Pedir homologação
              </button>
            }
            @if (x.can.decide) {
              <button
                type="button"
                class="btn-primary"
                data-testid="sd-approve"
                (click)="approve()"
              >
                Homologar
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="sd-reject"
                (click)="openReason('reject')"
              >
                Recusar
              </button>
            }
            @if (x.can.suspend) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="sd-suspend"
                (click)="openReason('suspend')"
              >
                Suspender
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="sd-terms">
          <h2 id="sd-terms" class="mb-2 font-semibold">Terceiro e condições</h2>
          <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-muted">Tipo de pessoa</dt>
              <dd>{{ partnerType(x) }}</dd>
            </div>
            <div>
              <dt class="text-muted">NIF</dt>
              <dd>{{ x.partner.taxId ?? '—' }} ({{ x.partner.countryCode }})</dd>
            </div>
            <div>
              <dt class="text-muted">Contacto geral</dt>
              <dd>{{ x.partner.email ?? '—' }} · {{ x.partner.phone ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Morada</dt>
              <dd>{{ address(x) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Tipo de fornecedor</dt>
              <dd>{{ supplierType(x) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Pagamento</dt>
              <dd data-testid="sd-terms-payment">
                {{ x.paymentTermsDays }} dias · {{ payment(x) }} · {{ x.currency }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Prazo de entrega</dt>
              <dd>{{ x.leadTimeDays === null ? '—' : x.leadTimeDays + ' dias' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Encomenda mínima</dt>
              <dd>{{ x.minOrderAmount ?? '—' }}</dd>
            </div>
          </dl>
        </section>

        <section class="card" aria-labelledby="sd-contacts">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="sd-contacts" class="font-semibold">Contactos</h2>
            @if (x.can.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="sd-contact-new"
                (click)="openForm('contact')"
              >
                Novo contacto
              </button>
            }
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="sd-contacts-table">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Nome</th>
                  <th class="px-2 py-1">Função</th>
                  <th class="px-2 py-1">E-mail</th>
                  <th class="px-2 py-1">Telefone</th>
                </tr>
              </thead>
              <tbody>
                @for (c of x.partner.contacts; track c.id) {
                  <tr class="border-t border-border" [class.text-muted]="c.status === 'INACTIVE'">
                    <td class="px-2 py-1">
                      {{ c.name }}
                      @if (c.isPrimary) {
                        <span class="badge ml-1 bg-info-soft text-info-text">Principal</span>
                      }
                    </td>
                    <td class="px-2 py-1">{{ c.role ?? '—' }}</td>
                    <td class="px-2 py-1">{{ c.email ?? '—' }}</td>
                    <td class="px-2 py-1">{{ c.phone ?? '—' }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="4" class="px-2 py-3 text-muted">Sem contactos.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card" aria-labelledby="sd-banks">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="sd-banks" class="font-semibold">Dados bancários</h2>
            @if (x.can.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="sd-bank-new"
                (click)="openForm('bank')"
              >
                Nova conta
              </button>
            }
          </div>
          <p class="mb-2 text-xs text-muted">
            Uma conta nova só fica activa depois de aprovada por outra pessoa.
            @if (!x.can.seeBank) {
              Os números aparecem mascarados.
            }
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="sd-banks-table">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Banco</th>
                  <th class="px-2 py-1">Titular</th>
                  <th class="px-2 py-1">IBAN / conta</th>
                  <th class="px-2 py-1">Moeda</th>
                  <th class="px-2 py-1">Estado</th>
                  <th class="px-2 py-1">Acções</th>
                </tr>
              </thead>
              <tbody>
                @for (a of x.bankAccounts; track a.id) {
                  <tr class="border-t border-border">
                    <td class="px-2 py-1">{{ a.bankName }}</td>
                    <td class="px-2 py-1">{{ a.holderName }}</td>
                    <td class="px-2 py-1 font-mono text-xs" data-testid="sd-bank-number">
                      {{ a.iban ?? a.accountNumber }}
                    </td>
                    <td class="px-2 py-1">{{ a.currency }}</td>
                    <td class="px-2 py-1">
                      <span class="badge" [class]="btone(a.status)">{{ bstatus(a) }}</span>
                      @if (a.decisionReason) {
                        <span class="block text-xs text-muted">{{ a.decisionReason }}</span>
                      }
                    </td>
                    <td class="px-2 py-1">
                      <span class="flex flex-wrap gap-2">
                        @if (a.canDecide) {
                          <button
                            type="button"
                            class="link text-sm"
                            data-testid="sd-bank-approve"
                            (click)="approveBank(a)"
                          >
                            Aprovar
                          </button>
                          <button
                            type="button"
                            class="link text-sm"
                            (click)="openReason('bank-reject', a.id, a.version)"
                          >
                            Recusar
                          </button>
                        }
                        @if (
                          (a.status === 'PENDING_APPROVAL' || a.status === 'ACTIVE') && x.can.manage
                        ) {
                          <button
                            type="button"
                            class="link text-sm"
                            (click)="openReason('bank-deactivate', a.id, a.version)"
                          >
                            Desactivar
                          </button>
                        }
                      </span>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="6" class="px-2 py-3 text-muted">Sem dados bancários.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card" aria-labelledby="sd-docs">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="sd-docs" class="font-semibold">Documentos</h2>
            @if (x.can.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="sd-doc-new"
                (click)="openForm('document')"
              >
                Registar documento
              </button>
            }
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="sd-docs-table">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Tipo</th>
                  <th class="px-2 py-1">Número</th>
                  <th class="px-2 py-1">Emissão</th>
                  <th class="px-2 py-1">Validade</th>
                  <th class="px-2 py-1">Ficheiro</th>
                  <th class="px-2 py-1">Estado</th>
                  <th class="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                @for (d of x.documents; track d.id) {
                  <tr class="border-t border-border" [class.text-muted]="d.status === 'INACTIVE'">
                    <td class="px-2 py-1">
                      {{ d.documentType.name }}
                      @if (d.documentType.required) {
                        <span class="text-xs text-muted">(obrigatório)</span>
                      }
                    </td>
                    <td class="px-2 py-1">{{ d.number ?? '—' }}</td>
                    <td class="px-2 py-1">{{ date(d.issuedOn) }}</td>
                    <td class="px-2 py-1">
                      {{ d.validUntil ? date(d.validUntil) : 'Sem validade' }}
                    </td>
                    <td class="px-2 py-1">{{ d.attachment?.fileName ?? '—' }}</td>
                    <td class="px-2 py-1">
                      @if (d.status === 'INACTIVE') {
                        Inactivo<span class="block text-xs">{{ d.inactiveReason }}</span>
                      } @else if (d.valid) {
                        <span class="text-success-text">Válido</span>
                      } @else {
                        <span class="text-danger-text">Caducado</span>
                      }
                    </td>
                    <td class="px-2 py-1">
                      @if (d.status === 'ACTIVE' && x.can.manage) {
                        <button
                          type="button"
                          class="link text-sm"
                          (click)="openReason('doc-deactivate', d.id, d.version)"
                        >
                          Desactivar
                        </button>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="7" class="px-2 py-3 text-muted">Sem documentos.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <app-attachments subjectType="supplier" [subjectId]="x.id" [canWrite]="x.can.manage" />

        <section class="card" aria-labelledby="sd-reviews">
          <h2 id="sd-reviews" class="mb-2 font-semibold">Pedidos de homologação</h2>
          @for (r of x.reviews; track r.id) {
            <div
              class="border-t border-border py-2 text-sm first:border-t-0"
              data-testid="sd-review"
            >
              <p>
                <strong>{{ reviewStatus(r.status) }}</strong> · pedido por
                {{ r.submittedBy.name ?? '—' }} em {{ when(r.submittedAt) }}
                @if (r.decidedAt) {
                  · decidido por {{ r.decidedBy?.name ?? '—' }} em {{ when(r.decidedAt) }}
                }
              </p>
              @if (r.decisionReason) {
                <p class="text-muted">Motivo: {{ r.decisionReason }}</p>
              }
              @if (r.notes) {
                <p class="text-muted">Notas: {{ r.notes }}</p>
              }
              <ul class="mt-1 list-inside list-disc text-muted">
                @for (i of r.items; track i.criterionId) {
                  <li>
                    {{ i.code }} — {{ i.name }}: {{ result(i.result) }}
                    @if (i.notes) {
                      ({{ i.notes }})
                    }
                  </li>
                }
              </ul>
            </div>
          } @empty {
            <p class="text-sm text-muted">Ainda não foi pedida a homologação.</p>
          }
        </section>

        <section class="card" aria-labelledby="sd-history">
          <h2 id="sd-history" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="sd-history">
            @for (h of x.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ event(h.kind) }}
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

        <app-audit-history entityType="supplier" [entityId]="x.id" [refreshKey]="x.version" />
      }
    </app-entity-form-page>

    <app-modal
      [title]="reasonTitle()"
      [open]="reasonKind() !== null"
      (closed)="reasonKind.set(null)"
    >
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="sd-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="reasonKind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="sd-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>

    <app-modal [title]="formTitle()" [open]="formKind() !== null" (closed)="formKind.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      @switch (formKind()) {
        @case ('contact') {
          <div class="space-y-3">
            <app-field label="Nome" [required]="true" [error]="act.field('name')">
              <input
                appControl
                class="input"
                name="cname"
                data-testid="ct-name"
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
                data-testid="ct-email"
                [(ngModel)]="contact.email"
              />
            </app-field>
            <app-field label="Telefone" [error]="act.field('phone')">
              <input appControl class="input" name="cphone" [(ngModel)]="contact.phone" />
            </app-field>
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" name="cprimary" [(ngModel)]="contact.isPrimary" /> Contacto
              principal
            </label>
          </div>
        }
        @case ('bank') {
          <div class="space-y-3">
            <app-field label="Banco" [required]="true" [error]="act.field('bankName')">
              <input
                appControl
                class="input"
                name="bname"
                data-testid="bk-bank"
                [(ngModel)]="bank.bankName"
              />
            </app-field>
            <app-field label="Titular" [required]="true" [error]="act.field('holderName')">
              <input
                appControl
                class="input"
                name="bholder"
                data-testid="bk-holder"
                [(ngModel)]="bank.holderName"
              />
            </app-field>
            <app-field
              label="IBAN"
              hint="Com os dígitos de controlo; espaços são ignorados."
              [error]="act.field('iban')"
            >
              <input
                appControl
                class="input font-mono"
                name="biban"
                data-testid="bk-iban"
                [(ngModel)]="bank.iban"
              />
            </app-field>
            <app-field
              label="Número de conta"
              hint="Se não houver IBAN."
              [error]="act.field('accountNumber')"
            >
              <input appControl class="input" name="baccount" [(ngModel)]="bank.accountNumber" />
            </app-field>
            <app-field label="SWIFT/BIC" [error]="act.field('swiftBic')">
              <input appControl class="input w-40" name="bswift" [(ngModel)]="bank.swiftBic" />
            </app-field>
            <app-field label="Moeda" [error]="act.field('currency')">
              <input
                appControl
                class="input w-24"
                name="bcurrency"
                maxlength="3"
                [(ngModel)]="bank.currency"
              />
            </app-field>
          </div>
        }
        @case ('document') {
          <div class="space-y-3">
            <app-field label="Tipo" [required]="true" [error]="act.field('documentTypeId')">
              <select
                appControl
                class="input"
                name="dtype"
                data-testid="dc-type"
                [(ngModel)]="doc.documentTypeId"
              >
                <option value="">Escolher…</option>
                @for (t of s()?.documentTypes ?? []; track t.id) {
                  <option [value]="t.id">
                    {{ t.code }} — {{ t.name }}{{ t.required ? ' (obrigatório)' : '' }}
                  </option>
                }
              </select>
            </app-field>
            <app-field label="Número" [error]="act.field('number')">
              <input
                appControl
                class="input"
                name="dnumber"
                data-testid="dc-number"
                [(ngModel)]="doc.number"
              />
            </app-field>
            <app-field label="Emissão" [error]="act.field('issuedOn')">
              <input
                appControl
                class="input w-44"
                type="date"
                name="dissued"
                data-testid="dc-issued"
                [(ngModel)]="doc.issuedOn"
              />
            </app-field>
            <app-field
              label="Válido até"
              hint="Vazio: sem validade."
              [error]="act.field('validUntil')"
            >
              <input
                appControl
                class="input w-44"
                type="date"
                name="dvalid"
                data-testid="dc-valid"
                [(ngModel)]="doc.validUntil"
              />
            </app-field>
            <app-field
              label="Ficheiro"
              hint="Um anexo já carregado neste fornecedor."
              [error]="act.field('attachmentId')"
            >
              <select
                appControl
                class="input"
                name="dfile"
                data-testid="dc-file"
                [(ngModel)]="doc.attachmentId"
              >
                <option value="">Sem ficheiro</option>
                @for (a of files(); track a.id) {
                  <option [value]="a.id">{{ a.fileName }}</option>
                }
              </select>
            </app-field>
          </div>
        }
        @case ('submit') {
          <p class="mb-3 text-sm text-muted">
            Avalie cada critério. Os obrigatórios têm de estar cumpridos; um critério não cumprido
            precisa de justificação. Quem pede não pode decidir.
          </p>
          <div class="space-y-3">
            @for (c of s()?.criteria ?? []; track c.id; let i = $index) {
              <fieldset
                class="rounded border border-border p-2"
                [attr.data-testid]="'cr-' + c.code"
              >
                <legend class="px-1 text-sm font-medium">
                  {{ c.code }} — {{ c.name }}{{ c.required ? ' (obrigatório)' : '' }}
                </legend>
                <select
                  class="input"
                  [name]="'res' + i"
                  [attr.aria-label]="'Resultado ' + c.code"
                  [(ngModel)]="answers[c.id].result"
                >
                  @for (r of results; track r[0]) {
                    <option [value]="r[0]">{{ r[1] }}</option>
                  }
                </select>
                <input
                  class="input mt-2"
                  [name]="'note' + i"
                  placeholder="Notas"
                  [attr.aria-label]="'Notas ' + c.code"
                  [(ngModel)]="answers[c.id].notes"
                />
              </fieldset>
            } @empty {
              <p class="text-sm text-muted">Não há critérios configurados.</p>
            }
            <app-field label="Notas do pedido" [error]="act.field('notes')">
              <textarea
                appControl
                class="input min-h-16"
                name="snotes"
                [(ngModel)]="submitNotes"
              ></textarea>
            </app-field>
          </div>
        }
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="formKind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="sd-form-ok"
          [disabled]="act.busy()"
          (click)="saveForm()"
        >
          {{ formKind() === 'submit' ? 'Pedir homologação' : 'Guardar' }}
        </button>
      </div>
    </app-modal>
  `,
})
export class SupplierDetailPage {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly s = signal<Supplier | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly files = signal<{ id: string; fileName: string }[]>([]);
  protected readonly act = new Action();
  protected readonly reasonKind = signal<ReasonKind | null>(null);
  protected readonly formKind = signal<FormKind | null>(null);
  private target: { id: string; version: number } | null = null;
  protected reason = '';
  protected contact = { name: '', role: '', email: '', phone: '', isPrimary: false };
  protected bank = {
    bankName: '',
    holderName: '',
    iban: '',
    accountNumber: '',
    swiftBic: '',
    currency: '',
  };
  protected doc = {
    documentTypeId: '',
    number: '',
    issuedOn: '',
    validUntil: '',
    attachmentId: '',
  };
  protected answers: Record<string, { result: string; notes: string }> = {};
  protected submitNotes = '';
  protected readonly results = Object.entries(RESULT);
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = supplierTone;
  protected readonly btone = bankTone;
  protected readonly statusLabel = (st: Supplier['status']) => SUPPLIER_STATUS[st];
  protected readonly bstatus = (a: BankAccount) => BANK_STATUS[a.status];
  protected readonly qualification = (x: Supplier) => qualificationText(x.qualification);
  protected readonly partnerType = (x: Supplier) => PARTNER_TYPE[x.partner.partnerType];
  protected readonly supplierType = (x: Supplier) => SUPPLIER_TYPE[x.supplierType];
  protected readonly payment = (x: Supplier) => PAYMENT_METHOD[x.paymentMethod];
  protected readonly result = (r: string) => RESULT[r] ?? r;
  protected readonly event = (k: string) => EVENT[k] ?? k;
  protected readonly reviewStatus = (r: string) =>
    ({ PENDING: 'Pendente', APPROVED: 'Homologado', REJECTED: 'Recusado', CANCELLED: 'Cancelado' })[
      r
    ] ?? r;
  protected readonly address = (x: Supplier) =>
    [x.partner.addressLine, x.partner.city, x.partner.province, x.partner.postalCode]
      .filter(Boolean)
      .join(', ') || '—';
  protected readonly title = computed(() => {
    const x = this.s();
    return x ? `${x.partner.code} — ${x.partner.name}` : 'Fornecedor';
  });
  protected readonly subtitle = computed(() => {
    const x = this.s();
    return x ? `${SUPPLIER_TYPE[x.supplierType]} · NIF ${x.partner.taxId ?? '—'}` : '';
  });
  protected readonly reasonTitle = computed(
    () =>
      ({
        reject: 'Recusar a homologação',
        suspend: 'Suspender o fornecedor',
        'bank-reject': 'Recusar a conta bancária',
        'bank-deactivate': 'Desactivar a conta bancária',
        'doc-deactivate': 'Desactivar o documento',
      })[this.reasonKind() ?? 'reject'],
  );
  protected readonly formTitle = computed(
    () =>
      ({
        contact: 'Novo contacto',
        bank: 'Nova conta bancária',
        document: 'Registar documento',
        submit: 'Pedir homologação',
      })[this.formKind() ?? 'contact'],
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const x = await this.api.get<Supplier>(`procurement/suppliers/${this.id()}`);
      this.s.set(x);
      this.breadcrumbs.setCurrent(x.partner.code);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected back() {
    void this.router.navigate(['/compras/fornecedores']);
  }

  private done(x: Supplier | undefined, message: string) {
    if (!x) return false;
    this.s.set(x);
    this.toasts.show(message);
    return true;
  }

  protected openReason(kind: ReasonKind, id?: string, version?: number) {
    this.act.error.set(null);
    this.reason = '';
    this.target = id ? { id, version: version! } : null;
    this.reasonKind.set(kind);
  }

  protected async confirmReason() {
    const x = this.s()!;
    const kind = this.reasonKind()!;
    const body = { reason: this.reason, expectedVersion: this.target?.version ?? x.version };
    const url = {
      reject: `procurement/suppliers/${x.id}/reject`,
      suspend: `procurement/suppliers/${x.id}/suspend`,
      'bank-reject': `procurement/supplier-bank-accounts/${this.target?.id}/reject`,
      'bank-deactivate': `procurement/supplier-bank-accounts/${this.target?.id}/deactivate`,
      'doc-deactivate': `procurement/supplier-documents/${this.target?.id}/deactivate`,
    }[kind];
    const r = await this.act.run(() => this.api.post<Supplier>(url, body));
    if (
      this.done(
        r ?? undefined,
        {
          reject: 'Homologação recusada.',
          suspend: 'Fornecedor suspenso.',
          'bank-reject': 'Conta bancária recusada.',
          'bank-deactivate': 'Conta bancária desactivada.',
          'doc-deactivate': 'Documento desactivado.',
        }[kind],
      )
    )
      this.reasonKind.set(null);
  }

  protected async approve() {
    const x = this.s()!;
    const ok = await this.confirmSvc.ask({
      title: 'Homologar fornecedor',
      message: `${x.partner.name} passa a homologado e pode receber encomendas enquanto os documentos obrigatórios estiverem em dia.`,
      confirmLabel: 'Homologar',
    });
    if (!ok) return;
    const r = await this.act.run(() =>
      this.api.post<Supplier>(`procurement/suppliers/${x.id}/approve`, {
        expectedVersion: x.version,
      }),
    );
    if (!this.done(r ?? undefined, 'Fornecedor homologado.'))
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
  }

  protected async approveBank(a: BankAccount) {
    const ok = await this.confirmSvc.ask({
      title: 'Aprovar conta bancária',
      message: `Confirme que verificou os dados de ${a.bankName} (${a.iban ?? a.accountNumber}) com um comprovativo do fornecedor.`,
      confirmLabel: 'Aprovar',
    });
    if (!ok) return;
    const r = await this.act.run(() =>
      this.api.post<Supplier>(`procurement/supplier-bank-accounts/${a.id}/approve`, {
        expectedVersion: a.version,
      }),
    );
    if (!this.done(r ?? undefined, 'Conta bancária aprovada.'))
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
  }

  protected async openForm(kind: FormKind) {
    const x = this.s()!;
    this.act.error.set(null);
    if (kind === 'contact')
      this.contact = { name: '', role: '', email: '', phone: '', isPrimary: false };
    if (kind === 'bank')
      this.bank = {
        bankName: '',
        holderName: x.partner.name,
        iban: '',
        accountNumber: '',
        swiftBic: '',
        currency: x.currency,
      };
    if (kind === 'document') {
      this.doc = { documentTypeId: '', number: '', issuedOn: '', validUntil: '', attachmentId: '' };
      this.api
        .get<{ id: string; fileName: string }[]>('attachments', {
          subjectType: 'supplier',
          subjectId: x.id,
        })
        .then(
          (f) => this.files.set(f),
          () => this.files.set([]),
        );
    }
    if (kind === 'submit') {
      this.answers = Object.fromEntries(
        x.criteria.map((c) => [c.id, { result: 'MET', notes: '' }]),
      );
      this.submitNotes = '';
    }
    this.formKind.set(kind);
  }

  protected async saveForm() {
    const x = this.s()!;
    const kind = this.formKind()!;
    const t = (v: string) => v.trim() || null;
    const r = await this.act.run(() => {
      if (kind === 'contact')
        return this.api.post<Supplier>(`procurement/suppliers/${x.id}/contacts`, {
          name: this.contact.name,
          role: t(this.contact.role),
          email: t(this.contact.email),
          phone: t(this.contact.phone),
          isPrimary: this.contact.isPrimary,
        });
      if (kind === 'bank')
        return this.api.post<Supplier>(`procurement/suppliers/${x.id}/bank-accounts`, {
          bankName: this.bank.bankName,
          holderName: this.bank.holderName,
          iban: t(this.bank.iban),
          accountNumber: t(this.bank.accountNumber),
          swiftBic: t(this.bank.swiftBic),
          currency: t(this.bank.currency),
        });
      if (kind === 'document')
        return this.api.post<Supplier>(`procurement/suppliers/${x.id}/documents`, {
          documentTypeId: this.doc.documentTypeId,
          number: t(this.doc.number),
          issuedOn: t(this.doc.issuedOn),
          validUntil: t(this.doc.validUntil),
          attachmentId: t(this.doc.attachmentId),
        });
      return this.api.post<Supplier>(`procurement/suppliers/${x.id}/submit`, {
        expectedVersion: x.version,
        notes: t(this.submitNotes),
        items: Object.entries(this.answers).map(([criterionId, a]) => ({
          criterionId,
          result: a.result,
          notes: t(a.notes),
        })),
      });
    });
    const message = {
      contact: 'Contacto acrescentado.',
      bank: 'Conta registada: fica por aprovar.',
      document: 'Documento registado.',
      submit: 'Homologação pedida.',
    }[kind];
    if (this.done(r ?? undefined, message)) this.formKind.set(null);
  }

  protected docLabel(d: SupplierDocument) {
    return `${d.documentType.code} ${d.number ?? ''}`.trim();
  }
}
