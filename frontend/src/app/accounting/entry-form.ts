import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Session } from '../core/session';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { type OrgRecord, recordLabel } from '../admin/org-kinds';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { formatMoney } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  type Account,
  type Chart,
  type Entry,
  entryActions,
  ENTRY_STATUS,
  type FiscalYear,
  type Journal,
  lineTotals,
  normalizeAmount,
  type Period,
} from './model';
import { accountingDeps, legalEntityOptions } from './shared';

interface LineForm {
  accountId: string | null;
  description: string;
  debit: string;
  credit: string;
  costCenterId: string | null;
  thirdPartyRef: string;
}

const blankLine = (): LineForm => ({
  accountId: null,
  description: '',
  debit: '',
  credit: '',
  costCenterId: null,
  thirdPartyRef: '',
});
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Criar ou ver/alterar um lançamento. O equilíbrio mostra-se enquanto se escreve; as regras (contas movimentáveis,
 * período aberto, partidas dobradas na moeda funcional, segregação de funções) são verificadas pelo servidor.
 */
@Component({
  selector: 'app-entry-form',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    ErrorAlert,
    ErrorState,
    Skeleton,
    FormSection,
    FormField,
    FieldControl,
    Attachments,
    AuditHistory,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!loaded()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      <app-page-detail [title]="title()" [subtitle]="subtitle()">
        <ng-container actions>
          <a class="btn-secondary" routerLink="/contabilidade/lancamentos">Voltar à lista</a>
        </ng-container>
        <app-error-alert [error]="action.error()" [showDetails]="true" />
        @if (entry()?.rejectionReason && entry()?.status === 'DRAFT') {
          <p class="rounded-md bg-warning-soft p-3 text-sm text-warning-text" role="status">
            Rejeitado: {{ entry()!.rejectionReason }}
          </p>
        }
        <form class="space-y-4" (ngSubmit)="save()" novalidate>
          <app-form-section title="Cabeçalho" description="Entidade, diário, data e período.">
            <app-field
              label="Entidade legal"
              [required]="true"
              [error]="action.field('legalEntityId')"
            >
              <select
                appControl
                class="input"
                name="le"
                [disabled]="!isNew()"
                [(ngModel)]="form.legalEntityId"
                (ngModelChange)="legalEntityChanged()"
              >
                <option [ngValue]="null">—</option>
                @for (o of entities(); track o.id) {
                  <option [ngValue]="o.id">{{ o.label }}</option>
                }
              </select>
            </app-field>
            <app-field label="Diário" [required]="true" [error]="action.field('journalId')">
              <select
                appControl
                class="input"
                name="journal"
                [disabled]="readonly()"
                [(ngModel)]="form.journalId"
              >
                <option [ngValue]="null">—</option>
                @for (j of journals(); track j.id) {
                  <option [ngValue]="j.id">{{ j.code }} — {{ j.name }}</option>
                }
              </select>
            </app-field>
            <app-field
              label="Data do lançamento"
              [required]="true"
              [error]="action.field('entryDate')"
            >
              <input
                appControl
                type="date"
                class="input"
                name="date"
                [disabled]="readonly()"
                [(ngModel)]="form.entryDate"
                (ngModelChange)="dateChanged()"
              />
            </app-field>
            <app-field
              label="Período"
              hint="Por omissão, o mês da data; abertura e regularizações escolhem-se aqui."
              [error]="action.field('periodId')"
            >
              <select
                appControl
                class="input"
                name="period"
                [disabled]="readonly()"
                [(ngModel)]="form.periodId"
              >
                <option [ngValue]="null">Mês da data</option>
                @for (p of periodsForDate(); track p.id) {
                  <option [ngValue]="p.id">
                    {{ p.name }}{{ p.status === 'CLOSED' ? ' (fechado)' : '' }}
                  </option>
                }
              </select>
            </app-field>
            <app-field label="Data do documento" [error]="action.field('documentDate')">
              <input
                appControl
                type="date"
                class="input"
                name="docDate"
                [disabled]="readonly()"
                [(ngModel)]="form.documentDate"
              />
            </app-field>
            <app-field label="Referência" [error]="action.field('reference')">
              <input
                appControl
                class="input"
                name="reference"
                [disabled]="readonly()"
                [(ngModel)]="form.reference"
              />
            </app-field>
            <app-field
              label="Moeda"
              hint="ISO 4217; vazio = moeda funcional."
              [error]="action.field('currency')"
            >
              <input
                appControl
                class="input"
                name="currency"
                [disabled]="readonly()"
                [(ngModel)]="form.currency"
              />
            </app-field>
            <app-field
              label="Câmbio"
              hint="Vazio = câmbio em vigor na data."
              [error]="action.field('exchangeRate')"
            >
              <input
                appControl
                class="input"
                name="rate"
                inputmode="decimal"
                [disabled]="readonly()"
                [(ngModel)]="form.exchangeRate"
              />
            </app-field>
            <app-field
              label="Descrição"
              [required]="true"
              [error]="action.field('description')"
              class="md:col-span-2"
            >
              <input
                appControl
                class="input"
                name="description"
                [disabled]="readonly()"
                [(ngModel)]="form.description"
              />
            </app-field>
          </app-form-section>

          <section class="card overflow-x-auto p-0" aria-labelledby="lines-title">
            <h2 id="lines-title" class="p-4 font-semibold">Linhas</h2>
            <table class="w-full min-w-[56rem] text-sm">
              <caption class="sr-only">
                Linhas do lançamento
              </caption>
              <thead>
                <tr class="border-b border-border text-left">
                  <th scope="col" class="p-2">Conta</th>
                  <th scope="col" class="p-2">Descrição</th>
                  <th scope="col" class="p-2 text-right">Débito</th>
                  <th scope="col" class="p-2 text-right">Crédito</th>
                  <th scope="col" class="p-2">Centro de custo</th>
                  <th scope="col" class="p-2">Terceiro</th>
                  <th scope="col" class="p-2"><span class="sr-only">Acções</span></th>
                </tr>
              </thead>
              <tbody>
                @for (l of lines; track $index; let i = $index) {
                  <tr class="border-b border-border align-top">
                    <td class="p-2">
                      <select
                        class="input"
                        [name]="'acc' + i"
                        [attr.aria-label]="'Conta da linha ' + (i + 1)"
                        [disabled]="readonly()"
                        [(ngModel)]="l.accountId"
                      >
                        <option [ngValue]="null">—</option>
                        @for (a of accounts(); track a.id) {
                          <option [ngValue]="a.id">{{ a.code }} — {{ a.name }}</option>
                        }
                      </select>
                      @if (action.field('lines.' + i + '.accountId'); as e) {
                        <p class="mt-1 text-xs text-danger-text">{{ e }}</p>
                      }
                    </td>
                    <td class="p-2">
                      <input
                        class="input"
                        [name]="'desc' + i"
                        [attr.aria-label]="'Descrição da linha ' + (i + 1)"
                        [disabled]="readonly()"
                        [(ngModel)]="l.description"
                      />
                    </td>
                    <td class="p-2">
                      <input
                        class="input text-right"
                        inputmode="decimal"
                        [name]="'deb' + i"
                        [attr.aria-label]="'Débito da linha ' + (i + 1)"
                        [disabled]="readonly()"
                        [(ngModel)]="l.debit"
                      />
                    </td>
                    <td class="p-2">
                      <input
                        class="input text-right"
                        inputmode="decimal"
                        [name]="'cre' + i"
                        [attr.aria-label]="'Crédito da linha ' + (i + 1)"
                        [disabled]="readonly()"
                        [(ngModel)]="l.credit"
                      />
                    </td>
                    <td class="p-2">
                      <select
                        class="input"
                        [name]="'cc' + i"
                        [attr.aria-label]="'Centro de custo da linha ' + (i + 1)"
                        [disabled]="readonly()"
                        [(ngModel)]="l.costCenterId"
                      >
                        <option [ngValue]="null">—</option>
                        @for (c of costCenters(); track c.id) {
                          <option [ngValue]="c.id">{{ c.label }}</option>
                        }
                      </select>
                      @if (action.field('lines.' + i + '.costCenterId'); as e) {
                        <p class="mt-1 text-xs text-danger-text">{{ e }}</p>
                      }
                    </td>
                    <td class="p-2">
                      <input
                        class="input"
                        [name]="'tp' + i"
                        [attr.aria-label]="'Terceiro da linha ' + (i + 1)"
                        [disabled]="readonly()"
                        [(ngModel)]="l.thirdPartyRef"
                      />
                    </td>
                    <td class="p-2">
                      @if (!readonly() && lines.length > 2) {
                        <button
                          type="button"
                          class="btn-secondary"
                          [attr.aria-label]="'Remover linha ' + (i + 1)"
                          (click)="removeLine(i)"
                        >
                          ×
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr class="font-semibold">
                  <td class="p-2" colspan="2">
                    @if (!readonly()) {
                      <button type="button" class="btn-secondary" (click)="addLine()">
                        Acrescentar linha
                      </button>
                    }
                  </td>
                  <td class="p-2 text-right" data-testid="total-debit">
                    {{ money(totals().debit) }}
                  </td>
                  <td class="p-2 text-right" data-testid="total-credit">
                    {{ money(totals().credit) }}
                  </td>
                  <td class="p-2" colspan="3" role="status" data-testid="balance">
                    @if (totals().invalid) {
                      <span class="text-danger-text">Há valores inválidos.</span>
                    } @else if (totals().balanced) {
                      <span class="text-success-text">Equilibrado</span>
                    } @else {
                      <span class="text-warning-text"
                        >Diferença: {{ money(totals().difference) }}</span
                      >
                    }
                  </td>
                </tr>
              </tfoot>
            </table>
          </section>

          @if (!readonly()) {
            <div class="flex flex-wrap items-center gap-2">
              <button type="submit" class="btn-primary" [disabled]="action.busy()">
                {{ isNew() ? 'Criar rascunho' : 'Guardar rascunho' }}
              </button>
              @if (!isNew() && actions().submit) {
                <button
                  type="button"
                  class="btn-secondary"
                  [disabled]="action.busy() || hasUnsavedChanges()"
                  (click)="transition('submit')"
                >
                  Submeter
                </button>
              }
              @if (!isNew() && actions().remove) {
                <button
                  type="button"
                  class="btn-danger"
                  [disabled]="action.busy()"
                  (click)="remove()"
                >
                  Eliminar rascunho
                </button>
              }
              @if (hasUnsavedChanges()) {
                <span class="text-sm text-muted" role="status">Alterações por guardar</span>
              }
            </div>
          }
        </form>

        @if (entry(); as e) {
          @if (actions().approve || actions().post || actions().reject || actions().reverse) {
            <section class="card space-y-3" aria-labelledby="actions-title">
              <h2 id="actions-title" class="font-semibold">Acções</h2>
              <div class="flex flex-wrap gap-2">
                @if (actions().approve) {
                  <button
                    type="button"
                    class="btn-primary"
                    [disabled]="action.busy()"
                    (click)="transition('approve')"
                  >
                    Aprovar
                  </button>
                }
                @if (actions().post) {
                  <button
                    type="button"
                    class="btn-primary"
                    [disabled]="action.busy()"
                    (click)="transition('post')"
                  >
                    Contabilizar
                  </button>
                }
              </div>
              @if (actions().reject) {
                <form
                  class="flex flex-wrap items-end gap-2"
                  (ngSubmit)="reject()"
                  aria-label="Rejeitar lançamento"
                >
                  <div class="grow">
                    <label class="label" for="reason">Motivo da rejeição</label>
                    <input id="reason" name="reason" class="input" [(ngModel)]="reason" />
                  </div>
                  <button
                    type="submit"
                    class="btn-danger"
                    [disabled]="action.busy() || reason.trim().length < 5"
                  >
                    Rejeitar
                  </button>
                </form>
              }
              @if (actions().reverse) {
                <form
                  class="flex flex-wrap items-end gap-2"
                  (ngSubmit)="reverse()"
                  aria-label="Estornar lançamento"
                >
                  <div>
                    <label class="label" for="rdate">Data do estorno</label>
                    <input
                      id="rdate"
                      name="rdate"
                      type="date"
                      class="input"
                      [(ngModel)]="reverseDate"
                    />
                  </div>
                  <button
                    type="submit"
                    class="btn-danger"
                    [disabled]="action.busy() || !reverseDate"
                  >
                    Estornar
                  </button>
                </form>
              }
            </section>
          }
          @if (e.reversalOfId || e.reversedById) {
            <p class="text-sm">
              @if (e.reversalOfId) {
                Estorno de
                <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', e.reversalOfId]">{{
                  e.reference ?? 'lançamento original'
                }}</a
                >.
              }
              @if (e.reversedById) {
                Estornado por
                <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', e.reversedById]"
                  >lançamento de estorno</a
                >.
              }
            </p>
          }
        }

        <div aside>
          @if (entry(); as e) {
            <section class="card text-sm" aria-labelledby="state-title">
              <h2 id="state-title" class="font-semibold">Estado: {{ statusLabel(e.status) }}</h2>
              <dl class="mt-2 grid grid-cols-2 gap-1">
                <dt class="text-muted">Número</dt>
                <dd>{{ e.number ?? '—' }}</dd>
                <dt class="text-muted">Exercício</dt>
                <dd>{{ e.fiscalYearCode }} · {{ e.periodName }}</dd>
                <dt class="text-muted">Moeda</dt>
                <dd>{{ e.currency }} × {{ e.exchangeRate }}</dd>
                <dt class="text-muted">Total (funcional)</dt>
                <dd>{{ money(e.totalDebit) }}</dd>
              </dl>
            </section>
            <app-attachments
              subjectType="journal_entry"
              [subjectId]="e.id"
              [canWrite]="workspace.can('accounting.create') && e.status !== 'POSTED'"
            />
            <app-audit-history
              entityType="journal_entry"
              [entityId]="e.id"
              [refreshKey]="e.version"
            />
          }
        </div>
      </app-page-detail>
    }
  `,
})
export class EntryForm implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly deps = accountingDeps();
  protected readonly workspace = this.deps.workspace;
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly when = formatDateTime;
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly entry = signal<Entry | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly journals = signal<Journal[]>([]);
  protected readonly accounts = signal<Account[]>([]);
  protected readonly costCenters = signal<{ id: string; label: string }[]>([]);
  protected readonly years = signal<FiscalYear[]>([]);
  protected readonly periodsForDate = signal<Period[]>([]);
  protected readonly action = new Action();
  protected form = {
    legalEntityId: null as string | null,
    journalId: null as string | null,
    entryDate: today(),
    periodId: null as string | null,
    documentDate: '',
    reference: '',
    currency: '',
    exchangeRate: '',
    description: '',
  };
  protected lines: LineForm[] = [blankLine(), blankLine()];
  protected reason = '';
  protected reverseDate = today();
  private initial = '';

  protected readonly readonly = computed(
    () =>
      !this.isNew() &&
      (this.entry()?.status !== 'DRAFT' || !this.workspace.can('accounting.create')),
  );
  protected readonly actions = computed(() => {
    const e = this.entry();
    const none = {
      edit: false,
      remove: false,
      submit: false,
      approve: false,
      reject: false,
      post: false,
      reverse: false,
    };
    if (!e) return none;
    return entryActions(e, {
      userId: this.session.user()?.id ?? null,
      can: (p) => this.workspace.can(p),
    });
  });
  /** Totais calculados a cada detecção de alterações (as linhas são um objecto simples editado pelo formulário). */
  protected totals = () => lineTotals(this.lines, 6);
  protected readonly statusLabel = (s: keyof typeof ENTRY_STATUS) => ENTRY_STATUS[s];
  protected readonly title = computed(() => {
    const e = this.entry();
    if (!e) return 'Novo lançamento';
    return e.number
      ? `Lançamento ${e.number}`
      : `Lançamento (${ENTRY_STATUS[e.status].toLowerCase()})`;
  });
  protected readonly subtitle = computed(() => {
    const e = this.entry();
    return e ? `${e.journalCode} · ${e.description}` : null;
  });

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && !this.readonly() && this.snap() !== this.initial;
  }

  private snap() {
    return snapshot({ ...this.form, lines: this.lines });
  }

  protected money(v: string) {
    const [int, frac = ''] = v.split('.');
    const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
    return formatMoney(`${int}.${trimmed}`, trimmed.length);
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set(null);
    try {
      // Sem `organization.read` não há lista de entidades: mostra-se só a do lançamento (a API decide o resto).
      this.entities.set(await legalEntityOptions(this.deps.api, this.workspace).catch(() => []));
      if (id === 'novo') {
        this.entry.set(null);
        this.form = {
          ...this.form,
          legalEntityId: this.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null,
        };
        this.lines = [blankLine(), blankLine()];
      } else {
        this.apply(await this.deps.api.get<Entry>(`accounting/entries/${id}`));
      }
      await this.loadReferences();
      this.initial = this.snap();
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(e: Entry) {
    this.entry.set(e);
    if (!this.entities().some((x) => x.id === e.legalEntityId))
      this.entities.update((list) => [
        ...list,
        { id: e.legalEntityId, label: 'Entidade do lançamento' },
      ]);
    this.breadcrumbs.setCurrent(e.number ?? 'Rascunho');
    this.form = {
      legalEntityId: e.legalEntityId,
      journalId: e.journalId,
      entryDate: e.entryDate,
      periodId: e.periodId,
      documentDate: e.documentDate ?? '',
      reference: e.reference ?? '',
      currency: e.currency,
      exchangeRate: e.exchangeRate,
      description: e.description,
    };
    this.lines = e.lines.map((l) => ({
      accountId: l.accountId,
      description: l.description ?? '',
      debit: Number(l.debit) === 0 ? '' : l.debit,
      credit: Number(l.credit) === 0 ? '' : l.credit,
      costCenterId: l.costCenterId,
      thirdPartyRef: l.thirdPartyRef ?? '',
    }));
  }

  /** Diários, contas movimentáveis do plano activo, centros de custo e exercícios da entidade legal escolhida. */
  private refRequest = 0;

  private async loadReferences() {
    const le = this.form.legalEntityId;
    if (!le) return;
    // Só a última escolha de entidade legal conta: respostas de pedidos anteriores são ignoradas.
    const request = ++this.refRequest;
    const stale = () => request !== this.refRequest;
    const [journals, charts, years] = await Promise.all([
      this.deps.api.page<Journal>('accounting/journals', { legalEntityId: le, limit: 200 }),
      this.deps.api.page<Chart>('accounting/charts', {
        legalEntityId: le,
        status: 'ACTIVE',
        limit: 1,
      }),
      this.deps.api.page<FiscalYear>('accounting/fiscal-years', { legalEntityId: le, limit: 50 }),
    ]);
    const chart = charts.items[0];
    const accounts = chart
      ? (
          await this.deps.api.page<Account>('accounting/accounts', {
            chartId: chart.id,
            postable: 'true',
            limit: 500,
          })
        ).items
      : [];
    const centers = this.workspace.can('organization.read')
      ? (
          await this.deps.api.page<OrgRecord>('organization/cost-centers', {
            legalEntityId: le,
            status: 'ACTIVE',
            limit: 200,
          })
        ).items
      : [];
    if (stale()) return;
    this.journals.set(
      journals.items.filter((j) => j.status === 'ACTIVE' || j.id === this.form.journalId),
    );
    this.years.set(years.items);
    this.accounts.set(
      accounts.filter((a) => a.status === 'ACTIVE' || this.lines.some((l) => l.accountId === a.id)),
    );
    this.costCenters.set(centers.map((r) => ({ id: r.id, label: recordLabel(r) })));
    if (!this.form.journalId && this.journals().length === 1)
      this.form.journalId = this.journals()[0].id;
    await this.dateChanged(false);
  }

  protected async legalEntityChanged() {
    // As listas da entidade anterior deixam de ser escolhíveis até chegarem as da nova.
    this.journals.set([]);
    this.accounts.set([]);
    this.costCenters.set([]);
    this.periodsForDate.set([]);
    this.form.journalId = null;
    this.form.periodId = null;
    this.lines.forEach((l) => {
      l.accountId = null;
      l.costCenterId = null;
    });
    await this.loadReferences();
  }

  /** Períodos (normais e especiais) que contêm a data, do exercício correspondente. */
  protected async dateChanged(resetPeriod = true) {
    if (resetPeriod) this.form.periodId = null;
    const date = this.form.entryDate;
    const year = this.years().find((y) => y.startDate <= date && date <= y.endDate);
    if (!year) {
      this.periodsForDate.set([]);
      return;
    }
    try {
      const detail = await this.deps.api.get<FiscalYear>(`accounting/fiscal-years/${year.id}`);
      this.periodsForDate.set(
        (detail.periods ?? []).filter((p) => p.startDate <= date && date <= p.endDate),
      );
    } catch {
      this.periodsForDate.set([]);
    }
  }

  protected addLine() {
    this.lines = [...this.lines, blankLine()];
  }

  protected removeLine(i: number) {
    this.lines = this.lines.filter((_, k) => k !== i);
  }

  private body() {
    return {
      journalId: this.form.journalId,
      entryDate: this.form.entryDate,
      periodId: this.form.periodId,
      documentDate: this.form.documentDate || null,
      reference: this.form.reference || null,
      description: this.form.description,
      ...(this.form.currency ? { currency: this.form.currency.trim().toUpperCase() } : {}),
      ...(this.form.exchangeRate ? { exchangeRate: normalizeAmount(this.form.exchangeRate) } : {}),
      lines: this.lines
        .filter((l) => l.accountId || l.debit || l.credit)
        .map((l) => ({
          accountId: l.accountId,
          description: l.description || null,
          debit: normalizeAmount(l.debit) || null,
          credit: normalizeAmount(l.credit) || null,
          costCenterId: l.costCenterId,
          thirdPartyRef: l.thirdPartyRef || null,
        })),
    };
  }

  protected async save() {
    if (this.action.busy()) return;
    const e = this.entry();
    const result = await this.action.run(() =>
      e
        ? this.deps.api.patch<Entry>(`accounting/entries/${e.id}`, {
            ...this.body(),
            expectedVersion: e.version,
          })
        : this.deps.api.post<Entry>('accounting/entries', {
            ...this.body(),
            legalEntityId: this.form.legalEntityId,
          }),
    );
    if (!result) return;
    this.apply(result);
    this.initial = this.snap();
    if (!e) {
      this.toasts.show('Rascunho criado.');
      await this.router.navigate(['/contabilidade/lancamentos', result.id]);
    } else this.toasts.show('Rascunho guardado.');
  }

  protected async transition(kind: 'submit' | 'approve' | 'post') {
    const e = this.entry()!;
    if (kind === 'post') {
      const ok = await this.confirm.ask({
        title: 'Contabilizar lançamento',
        message:
          'Recebe número definitivo e deixa de poder ser alterado; correcções só por estorno.',
        confirmLabel: 'Contabilizar',
      });
      if (!ok) return;
    }
    const result = await this.action.run(() =>
      this.deps.api.post<Entry>(`accounting/entries/${e.id}/${kind}`, {
        expectedVersion: e.version,
      }),
    );
    if (!result) return;
    this.apply(result);
    this.initial = this.snap();
    this.toasts.show(
      kind === 'submit'
        ? 'Lançamento submetido.'
        : kind === 'approve'
          ? 'Lançamento aprovado.'
          : `Contabilizado com o número ${result.number}.`,
    );
  }

  protected async reject() {
    const e = this.entry()!;
    const result = await this.action.run(() =>
      this.deps.api.post<Entry>(`accounting/entries/${e.id}/reject`, {
        expectedVersion: e.version,
        reason: this.reason,
      }),
    );
    if (!result) return;
    this.reason = '';
    this.apply(result);
    this.initial = this.snap();
    this.toasts.show('Lançamento devolvido a rascunho.');
  }

  protected async reverse() {
    const e = this.entry()!;
    const ok = await this.confirm.ask({
      title: 'Estornar lançamento',
      message: `É criado e contabilizado um lançamento com os lados trocados, com data ${this.reverseDate}.`,
      confirmLabel: 'Estornar',
      danger: true,
    });
    if (!ok) return;
    const result = await this.action.run(() =>
      this.deps.api.post<Entry>(`accounting/entries/${e.id}/reverse`, { date: this.reverseDate }),
    );
    if (!result) return;
    this.toasts.show(`Estorno ${result.number} contabilizado.`);
    await this.router.navigate(['/contabilidade/lancamentos', result.id]);
  }

  protected async remove() {
    const e = this.entry()!;
    const ok = await this.confirm.ask({
      title: 'Eliminar rascunho',
      message: 'O rascunho é eliminado (fica registado na auditoria).',
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    await this.action.run(() => this.deps.api.delete(`accounting/entries/${e.id}`));
    if (this.action.error()) return;
    this.initial = this.snap();
    this.toasts.show('Rascunho eliminado.');
    await this.router.navigate(['/contabilidade/lancamentos']);
  }
}
