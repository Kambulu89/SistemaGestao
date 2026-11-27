import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { price, qty } from './pricing-model';
import {
  FREQUENCY,
  type Recurring,
  RECURRING_STATUS,
  type RecurringOptions,
  type RecurringVersion,
  recurringTone,
  TIMING,
  VERSION_STATUS,
} from './recurring-model';

type Dialog = 'version' | 'approve' | 'discard' | 'suspend' | 'end' | null;
interface LineForm {
  key: number;
  productId: string;
  label: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  taxCodes: Record<string, boolean>;
}
let seq = 0;

/**
 * Contrato recorrente: dados, versões de preço/linhas (aprovação por outra pessoa), calendário dos próximos períodos e
 * períodos gerados com o rascunho de factura (a emissão é feita na factura, por uma pessoa).
 */
@Component({
  selector: 'app-recurring-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    Autocomplete,
    Attachments,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? x()!.reference + ' — ' + x()!.description : 'Contrato recorrente'"
      [subtitle]="
        x() ? x()!.customer.code + ' — ' + x()!.customer.name + ' · ' + x()!.legalEntity.code : ''
      "
      formId="recurring-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as c) {
        <p class="rounded-card border border-border bg-surface-2 p-3 text-sm" role="note">
          A geração cria <strong>rascunhos</strong> de factura, um por período. Nada é emitido
          automaticamente: cada rascunho é revisto e emitido por quem tem permissão para emitir.
        </p>
        <section class="card space-y-3" aria-label="Contrato" data-testid="rd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(c.status)" data-testid="rd-status">{{
              status(c.status)
            }}</span>
            @if (c.statusReason) {
              <em class="text-sm">{{ c.statusReason }}</em>
            }
          </div>
          <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt class="text-muted">Periodicidade</dt>
              <dd>{{ frequency(c.frequency) }} · {{ timing(c.billingTiming) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Vigência</dt>
              <dd>{{ c.startDate }} → {{ c.endDate ?? 'sem fim' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Moeda e prazo</dt>
              <dd>{{ c.currency }} · {{ c.paymentTermsDays }} dias</dd>
            </div>
            <div>
              <dt class="text-muted">Períodos gerados</dt>
              <dd data-testid="rd-periods">{{ c.periodsGenerated }}</dd>
            </div>
          </dl>
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="false" />
          }
          <div class="flex flex-wrap gap-2">
            @if (c.can.edit) {
              <a
                class="btn-secondary"
                data-testid="rd-edit"
                [routerLink]="['/vendas/recorrentes', c.id, 'editar']"
                >Editar</a
              >
            }
            @if (c.can.addVersion) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-new-version"
                (click)="openVersion(null)"
              >
                Nova versão
              </button>
            }
            @if (c.can.activate) {
              <button
                type="button"
                class="btn-primary"
                data-testid="rd-activate"
                (click)="transition('activate')"
              >
                Activar
              </button>
            }
            @if (c.can.generate) {
              <button
                type="button"
                class="btn-primary"
                data-testid="rd-generate"
                [disabled]="act.busy()"
                (click)="generate()"
              >
                Gerar rascunhos vencidos
              </button>
            }
            @if (c.can.suspend) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-suspend"
                (click)="open('suspend')"
              >
                Suspender
              </button>
            }
            @if (c.can.resume) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-resume"
                (click)="transition('resume')"
              >
                Retomar
              </button>
            }
            @if (c.can.end) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-end"
                (click)="open('end')"
              >
                Terminar
              </button>
            }
          </div>
        </section>

        <section class="card space-y-3" aria-labelledby="rd-v-title">
          <h2 id="rd-v-title" class="font-semibold">Versões de preço e linhas</h2>
          @for (v of c.versions; track v.id) {
            <div
              class="space-y-2 border-b border-border pb-3"
              [attr.data-testid]="'rd-version-' + v.versionNo"
            >
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <strong>Versão {{ v.versionNo }}</strong> · em vigor a partir de {{ v.validFrom }}
                <span class="badge" [class]="tone(v.status)" data-testid="rd-v-status">{{
                  vStatus(v.status)
                }}</span>
                {{ v.createdBy ? '· preparada por ' + v.createdBy : ''
                }}{{ v.approvedBy ? ' · aprovada por ' + v.approvedBy : '' }}
                @if (v.decisionReason) {
                  · <em>{{ v.decisionReason }}</em>
                }
              </div>
              <ul class="space-y-1 text-sm">
                @for (l of v.lines; track l.productId) {
                  <li>
                    {{ l.sku }} — {{ l.description ?? l.name }} · {{ qty(l.quantity) }} ×
                    {{
                      l.unitPrice === null
                        ? 'preço da tabela à data'
                        : price(l.unitPrice) + ' (fixo)'
                    }}
                  </li>
                }
              </ul>
              <div class="flex flex-wrap gap-2">
                @if (v.can.edit) {
                  <button type="button" class="link text-sm" (click)="openVersion(v)">
                    Editar
                  </button>
                }
                @if (v.can.approve) {
                  <button
                    type="button"
                    class="btn-primary"
                    data-testid="rd-v-approve"
                    (click)="openDecision(v, 'approve')"
                  >
                    Aprovar
                  </button>
                } @else if (v.status === 'DRAFT') {
                  <span class="self-center text-sm text-muted"
                    >Aprovação por outra pessoa com permissão.</span
                  >
                }
                @if (v.can.discard) {
                  <button type="button" class="link text-sm" (click)="openDecision(v, 'discard')">
                    Descartar
                  </button>
                }
              </div>
            </div>
          } @empty {
            <p class="text-sm text-muted">
              Sem versões: acrescente a primeira, em vigor no início do contrato.
            </p>
          }
        </section>

        <section class="card space-y-2" aria-labelledby="rd-s-title">
          <h2 id="rd-s-title" class="font-semibold">Próximos períodos</h2>
          <ul class="space-y-1 text-sm" data-testid="rd-schedule">
            @for (p of c.schedule; track p.index) {
              <li>
                {{ p.periodStart }} a {{ p.periodEnd }} · factura de {{ p.invoiceDate }} ·
                {{ p.versionNo ? 'versão ' + p.versionNo : 'sem versão aprovada'
                }}{{ p.due ? ' · por gerar' : '' }}
              </li>
            } @empty {
              <li class="text-muted">Sem mais períodos.</li>
            }
          </ul>
        </section>

        <section class="card space-y-2" aria-labelledby="rd-r-title">
          <h2 id="rd-r-title" class="font-semibold">Períodos gerados</h2>
          <ul class="space-y-1 text-sm" data-testid="rd-runs">
            @for (r of c.runs; track r.id) {
              <li class="flex flex-wrap items-center gap-2">
                <span class="badge" [class]="tone(r.status)">{{
                  r.status === 'GENERATED' ? 'Gerado' : 'Falhou'
                }}</span>
                {{ r.periodStart }} a {{ r.periodEnd }}
                @if (r.invoice) {
                  ·
                  <a
                    class="link"
                    [routerLink]="['/vendas/facturas', r.invoice.id]"
                    data-testid="rd-run-invoice"
                    >{{ r.invoice.number ?? 'Rascunho de ' + r.invoiceDate }}</a
                  >
                  · {{ money(r.invoice.payable, c.currency) }} ·
                  {{ r.invoice.status === 'DRAFT' ? 'por emitir' : 'emitida' }}
                  {{ r.versionNo ? '· versão ' + r.versionNo : '' }}
                }
                @if (r.reason) {
                  · <em>{{ r.reason }}</em>
                }
              </li>
            } @empty {
              <li class="text-muted">Ainda nenhum período gerado.</li>
            }
          </ul>
        </section>

        <app-attachments
          subjectType="sales_recurring_contract"
          [subjectId]="c.id"
          [canWrite]="c.can.edit"
        />
        <app-audit-history
          entityType="sales_recurring_contract"
          [entityId]="c.id"
          [refreshKey]="c.version"
        />
      }
    </app-entity-form-page>

    <app-modal [title]="dialogTitle()" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      @switch (dialog()) {
        @case ('version') {
          <div class="space-y-3">
            <app-field
              label="Em vigor a partir de"
              [required]="true"
              hint="A primeira começa no início do contrato; as seguintes, no próximo período por gerar ou depois."
              [error]="act.field('validFrom')"
            >
              <input
                appControl
                class="input"
                type="date"
                name="vfrom"
                data-testid="rd-v-from"
                [(ngModel)]="vf.validFrom"
              />
            </app-field>
            @if (act.field('lines'); as e) {
              <p class="field-error">{{ e }}</p>
            }
            @for (l of vf.lines; track l.key; let i = $index) {
              <fieldset
                class="space-y-2 border-b border-border pb-2"
                [attr.data-testid]="'rd-v-line-' + i"
              >
                <legend class="text-sm font-medium">Linha {{ i + 1 }}</legend>
                <app-field
                  #pf
                  label="Serviço"
                  [required]="true"
                  [error]="act.field('lines.' + i + '.productId')"
                >
                  <app-autocomplete
                    [name]="'p' + l.key"
                    data-testid="rd-v-product"
                    [inputId]="pf.controlId"
                    [describedBy]="pf.describedBy()"
                    [search]="searchProducts"
                    [initialLabel]="l.label"
                    [(ngModel)]="l.productId"
                  />
                </app-field>
                <div class="flex flex-wrap gap-3">
                  <app-field
                    label="Quantidade"
                    [required]="true"
                    [error]="act.field('lines.' + i + '.quantity')"
                  >
                    <input
                      appControl
                      class="input w-28"
                      inputmode="decimal"
                      [name]="'q' + l.key"
                      data-testid="rd-v-qty"
                      [(ngModel)]="l.quantity"
                    />
                  </app-field>
                  <app-field
                    label="Preço unitário fixo"
                    hint="Vazio: o da tabela de preços na data da factura."
                    [error]="act.field('lines.' + i + '.unitPrice')"
                  >
                    <input
                      appControl
                      class="input w-36"
                      inputmode="decimal"
                      [name]="'u' + l.key"
                      data-testid="rd-v-price"
                      [(ngModel)]="l.unitPrice"
                    />
                  </app-field>
                </div>
                <fieldset class="text-sm">
                  <legend class="mb-1">Impostos</legend>
                  @for (t of taxCodes(); track t.id) {
                    <label class="mr-3 inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        [name]="'t' + l.key + t.id"
                        [attr.data-testid]="'rd-v-tax-' + t.code"
                        [(ngModel)]="l.taxCodes[t.id]"
                      />
                      {{ t.code }}
                    </label>
                  }
                  @if (act.field('lines.' + i + '.taxCodeIds'); as e) {
                    <p class="field-error">{{ e }}</p>
                  }
                </fieldset>
                @if (vf.lines.length > 1) {
                  <button type="button" class="link text-sm" (click)="vf.lines.splice(i, 1)">
                    Remover linha
                  </button>
                }
              </fieldset>
            }
            <button
              type="button"
              class="link text-sm"
              data-testid="rd-v-add-line"
              (click)="vf.lines.push(emptyLine())"
            >
              Acrescentar linha
            </button>
            <app-field label="Notas" [error]="act.field('notes')">
              <input appControl class="input" name="vnotes" [(ngModel)]="vf.notes" />
            </app-field>
          </div>
        }
        @case ('approve') {
          <p class="text-sm">
            Aprova a versão {{ target()?.versionNo }} em vigor a partir de
            {{ target()?.validFrom }}. Fica imutável e aplica-se aos períodos que começam nessa data
            ou depois.
          </p>
        }
        @default {
          <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
            <textarea
              appControl
              class="input min-h-16"
              name="reason"
              data-testid="rd-reason"
              [(ngModel)]="reason"
            ></textarea>
          </app-field>
        }
      }
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rd-ok"
          [disabled]="act.busy()"
          (click)="submit()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class RecurringDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Recurring | null>(null);
  protected readonly opts = signal<RecurringOptions | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<Dialog>(null);
  protected readonly target = signal<RecurringVersion | null>(null);
  protected readonly act = new Action();
  protected readonly money = money;
  protected readonly qty = qty;
  protected readonly price = price;
  protected readonly when = formatDateTime;
  protected readonly tone = recurringTone;
  protected readonly status = (s: string) => RECURRING_STATUS[s] ?? s;
  protected readonly vStatus = (s: string) => VERSION_STATUS[s] ?? s;
  protected readonly frequency = (s: string) => FREQUENCY[s] ?? s;
  protected readonly timing = (s: string) => TIMING[s] ?? s;
  protected readonly taxCodes = computed(() => {
    const le = this.opts()?.legalEntities.find((e) => e.id === this.x()?.legalEntity.id);
    return (this.opts()?.taxCodes ?? []).filter((t) => !le || t.countryCode === le.countryCode);
  });
  protected vf = { validFrom: '', notes: '', lines: [] as LineForm[] };
  protected reason = '';
  protected readonly searchProducts = async (q: string): Promise<Option[]> =>
    (
      await this.api.get<{ id: string; sku: string; name: string }[]>(
        'sales/recurring/search/products',
        { q },
      )
    ).map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}` }));

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected emptyLine(): LineForm {
    return {
      key: ++seq,
      productId: '',
      label: null,
      description: '',
      quantity: '1',
      unitPrice: '',
      taxCodes: {},
    };
  }
  protected dialogTitle() {
    return (
      (
        {
          version: this.target() ? `Editar versão ${this.target()!.versionNo}` : 'Nova versão',
          approve: 'Aprovar versão',
          discard: 'Descartar versão',
          suspend: 'Suspender o contrato',
          end: 'Terminar o contrato',
        } as Record<string, string>
      )[this.dialog() ?? ''] ?? ''
    );
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [c, o] = await Promise.all([
        this.api.get<Recurring>(`sales/recurring/${this.id()}`),
        this.api.get<RecurringOptions>('sales/recurring/options').catch(() => null),
      ]);
      this.opts.set(o);
      this.set(c);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(c: Recurring) {
    this.x.set(c);
    this.breadcrumbs.setCurrent(c.reference);
  }
  protected back() {
    void this.router.navigate(['/vendas/recorrentes']);
  }
  protected open(d: Dialog) {
    this.act.error.set(null);
    this.reason = '';
    this.dialog.set(d);
  }
  protected openVersion(v: RecurringVersion | null) {
    const c = this.x()!;
    this.target.set(v);
    const last = [...c.versions].reverse().find((x) => x.status !== 'DISCARDED');
    const base = v ?? last;
    const next = c.schedule[0]?.periodStart ?? c.startDate;
    this.vf = {
      validFrom: v
        ? v.validFrom
        : c.versions.some((x) => x.status === 'APPROVED')
          ? next
          : c.startDate,
      notes: v?.notes ?? '',
      lines: base
        ? base.lines.map((l) => ({
            key: ++seq,
            productId: l.productId,
            label: `${l.sku} — ${l.name}`,
            description: l.description ?? '',
            quantity: qty(l.quantity).replace(',', '.').replace(/\s/g, ''),
            unitPrice: l.unitPrice ?? '',
            taxCodes: Object.fromEntries(l.taxCodeIds.map((t) => [t, true])),
          }))
        : [this.emptyLine()],
    };
    this.open('version');
  }
  protected openDecision(v: RecurringVersion, d: 'approve' | 'discard') {
    this.target.set(v);
    this.open(d);
  }

  protected async transition(action: 'activate' | 'resume') {
    const c = this.x()!;
    const r = await this.act.run(() =>
      this.api.post<Recurring>(`sales/recurring/${c.id}/${action}`, { expectedVersion: c.version }),
    );
    if (!r) return;
    this.set(r);
    this.toasts.show(action === 'activate' ? 'Contrato activo.' : 'Contrato retomado.');
  }

  protected async generate() {
    const c = this.x()!;
    const r = await this.act.run(() =>
      this.api.post<{ generated: number; failed: string | null; contract: Recurring }>(
        `sales/recurring/${c.id}/generate`,
        {},
      ),
    );
    if (!r) return;
    this.set(r.contract);
    this.toasts.show(
      r.failed
        ? `${r.generated} rascunho(s) gerado(s); um período falhou: ${r.failed}`
        : `${r.generated} rascunho(s) de factura gerado(s). Nada foi emitido.`,
    );
  }

  protected async submit() {
    const c = this.x()!;
    const d = this.dialog();
    let call: () => Promise<Recurring>;
    let done: string;
    if (d === 'version') {
      const body = {
        validFrom: this.vf.validFrom,
        notes: this.vf.notes || null,
        lines: this.vf.lines.map((l) => ({
          productId: l.productId,
          description: l.description || null,
          quantity: l.quantity.trim().replace(',', '.'),
          unitPrice: l.unitPrice.trim() ? l.unitPrice.trim().replace(',', '.') : null,
          taxCodeIds: Object.entries(l.taxCodes)
            .filter(([, on]) => on)
            .map(([t]) => t),
        })),
      };
      const v = this.target();
      call = () =>
        v
          ? this.api.patch<Recurring>(`sales/recurring-versions/${v.id}`, {
              ...body,
              expectedVersion: v.version,
            })
          : this.api.post<Recurring>(`sales/recurring/${c.id}/versions`, body);
      done = 'Versão guardada: falta a aprovação de outra pessoa.';
    } else if (d === 'approve' || d === 'discard') {
      const v = this.target()!;
      call = () =>
        this.api.post<Recurring>(`sales/recurring-versions/${v.id}/${d}`, {
          expectedVersion: v.version,
          ...(d === 'discard' ? { reason: this.reason } : {}),
        });
      done = d === 'approve' ? 'Versão aprovada.' : 'Versão descartada.';
    } else {
      call = () =>
        this.api.post<Recurring>(`sales/recurring/${c.id}/${d}`, {
          expectedVersion: c.version,
          reason: this.reason,
        });
      done = d === 'suspend' ? 'Contrato suspenso.' : 'Contrato terminado.';
    }
    const r = await this.act.run(call);
    if (!r) return;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show(done);
  }
}
