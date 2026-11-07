import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action, Loadable } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { type Account, accountTree, type Chart, label, LEVELS, NATURES } from './model';
import { accountingDeps } from './shared';

interface AccountForm {
  parentId: string | null;
  code: string;
  name: string;
  level: string;
  nature: string;
  normalBalance: string;
  postable: boolean;
  requiresCostCenter: boolean;
  requiresThirdParty: boolean;
  statementLine: string;
  status: string;
}

const EMPTY: AccountForm = {
  parentId: null,
  code: '',
  name: '',
  level: 'CLASS',
  nature: 'ASSET',
  normalBalance: 'DEBIT',
  postable: false,
  requiresCostCenter: false,
  requiresThirdParty: false,
  statementLine: '',
  status: 'ACTIVE',
};

/** Plano de contas: árvore de contas e formulário para criar ou alterar uma conta. */
@Component({
  selector: 'app-chart-detail',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    ErrorAlert,
    ErrorState,
    Skeleton,
    StatusBadge,
    FormSection,
    FormField,
    FieldControl,
    AuditHistory,
  ],
  template: `
    @if (chart.error()) {
      <app-error-state [error]="chart.error()" (retry)="chart.load()" />
    } @else if (!chart.value()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let c = chart.value()!;
      <app-page-detail
        [title]="c.code + ' — ' + c.name"
        [subtitle]="'Jurisdição ' + c.jurisdiction + (c.baseModel ? ' · ' + c.baseModel : '')"
        [status]="c.status"
      >
        <ng-container actions
          ><a class="btn-secondary" routerLink="/contabilidade/planos">Voltar</a></ng-container
        >
        <section class="card overflow-x-auto p-0" aria-labelledby="tree-title">
          <h2 id="tree-title" class="p-4 font-semibold">
            Contas ({{ accounts.value()?.length ?? 0 }})
          </h2>
          @if ((accounts.value() ?? []).length === 0) {
            <p class="px-4 pb-4 text-sm text-muted">
              Comece pelas classes (ex.: 1, 2, …) e depois as contas e subcontas.
            </p>
          } @else {
            <table class="w-full text-sm">
              <caption class="sr-only">
                Plano de contas
              </caption>
              <thead>
                <tr class="border-b border-border text-left">
                  <th scope="col" class="p-2">Código e nome</th>
                  <th scope="col" class="p-2">Natureza</th>
                  <th scope="col" class="p-2">Movimentável</th>
                  <th scope="col" class="p-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                @for (item of tree(); track item.account.id) {
                  <tr
                    class="border-b border-border"
                    [class.font-semibold]="item.account.level === 'CLASS'"
                  >
                    <td class="p-2" [style.padding-left.rem]="0.5 + item.depth * 1.25">
                      <button type="button" class="btn-link text-left" (click)="edit(item.account)">
                        <span class="font-mono">{{ item.account.code }}</span>
                        {{ item.account.name }}
                      </button>
                      <span class="sr-only">({{ levelLabel(item.account.level) }})</span>
                    </td>
                    <td class="p-2">{{ natureLabel(item.account.nature) }}</td>
                    <td class="p-2">{{ item.account.postable ? 'Sim' : 'Não' }}</td>
                    <td class="p-2"><app-status-badge [status]="item.account.status" /></td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
        @if (canManage()) {
          <form
            class="space-y-3"
            (ngSubmit)="save()"
            [attr.aria-label]="editing() ? 'Alterar conta' : 'Nova conta'"
          >
            <app-error-alert [error]="action.error()" [showDetails]="false" />
            <app-form-section
              [title]="editing() ? 'Alterar ' + editing()!.code : 'Nova conta'"
              description="O código de uma conta começa pelo código da conta-mãe. Só contas sem subcontas são movimentáveis."
            >
              <app-field label="Conta-mãe" [error]="action.field('parentId')">
                <select
                  appControl
                  class="input"
                  name="parentId"
                  [disabled]="!!editing()"
                  [(ngModel)]="form.parentId"
                  (ngModelChange)="parentChanged()"
                >
                  <option [ngValue]="null">— (classe)</option>
                  @for (p of parents(); track p.id) {
                    <option [ngValue]="p.id">{{ p.code }} — {{ p.name }}</option>
                  }
                </select>
              </app-field>
              <app-field label="Nível" [required]="true" [error]="action.field('level')">
                <select
                  appControl
                  class="input"
                  name="level"
                  [disabled]="!!editing()"
                  [(ngModel)]="form.level"
                >
                  @for (l of levels; track l.value) {
                    <option [value]="l.value">{{ l.label }}</option>
                  }
                </select>
              </app-field>
              <app-field label="Código" [required]="true" [error]="action.field('code')">
                <input
                  appControl
                  class="input font-mono"
                  name="code"
                  [disabled]="!!editing()"
                  [(ngModel)]="form.code"
                />
              </app-field>
              <app-field label="Nome" [required]="true" [error]="action.field('name')">
                <input appControl class="input" name="name" [(ngModel)]="form.name" />
              </app-field>
              <app-field label="Natureza" [required]="true" [error]="action.field('nature')">
                <select
                  appControl
                  class="input"
                  name="nature"
                  [(ngModel)]="form.nature"
                  (ngModelChange)="natureChanged()"
                >
                  @for (n of natures; track n.value) {
                    <option [value]="n.value">{{ n.label }}</option>
                  }
                </select>
              </app-field>
              <app-field label="Saldo normal" [error]="action.field('normalBalance')">
                <select
                  appControl
                  class="input"
                  name="normalBalance"
                  [(ngModel)]="form.normalBalance"
                >
                  <option value="DEBIT">Devedor</option>
                  <option value="CREDIT">Credor</option>
                </select>
              </app-field>
              <app-field
                label="Linha das demonstrações"
                hint="Código livre para os mapas (6.8)."
                [error]="action.field('statementLine')"
              >
                <input
                  appControl
                  class="input"
                  name="statementLine"
                  [(ngModel)]="form.statementLine"
                />
              </app-field>
              <app-field label="Estado" [error]="action.field('status')">
                <select appControl class="input" name="status" [(ngModel)]="form.status">
                  <option value="ACTIVE">Activa</option>
                  <option value="INACTIVE">Inactiva</option>
                </select>
              </app-field>
              <fieldset class="flex flex-wrap gap-4 text-sm md:col-span-2">
                <legend class="sr-only">Regras da conta</legend>
                <label class="flex items-center gap-2"
                  ><input type="checkbox" name="postable" [(ngModel)]="form.postable" />
                  Movimentável</label
                >
                <label class="flex items-center gap-2"
                  ><input type="checkbox" name="cc" [(ngModel)]="form.requiresCostCenter" /> Exige
                  centro de custo</label
                >
                <label class="flex items-center gap-2"
                  ><input type="checkbox" name="tp" [(ngModel)]="form.requiresThirdParty" /> Exige
                  terceiro</label
                >
              </fieldset>
            </app-form-section>
            <div class="flex gap-2">
              <button type="submit" class="btn-primary" [disabled]="action.busy()">
                {{ editing() ? 'Guardar conta' : 'Criar conta' }}
              </button>
              @if (editing()) {
                <button type="button" class="btn-secondary" (click)="reset()">Nova conta</button>
              }
            </div>
          </form>
        }
        <div aside>
          <app-audit-history
            entityType="account_chart"
            [entityId]="c.id"
            [refreshKey]="c.version"
          />
          @if (editing(); as a) {
            <app-audit-history entityType="account" [entityId]="a.id" [refreshKey]="a.version" />
          }
        </div>
      </app-page-detail>
    }
  `,
})
export class ChartDetail {
  readonly id = input.required<string>();
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly natures = NATURES;
  protected readonly levels = LEVELS;
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly editing = signal<Account | null>(null);
  protected readonly action = new Action();
  protected form: AccountForm = { ...EMPTY };
  protected readonly chart = new Loadable(async () => {
    const c = await this.deps.api.get<Chart>(`accounting/charts/${this.id()}`);
    this.breadcrumbs.setCurrent(c.code);
    return c;
  });
  protected readonly accounts = new Loadable(
    async () =>
      (await this.deps.api.page<Account>('accounting/accounts', { chartId: this.id(), limit: 500 }))
        .items,
  );
  protected readonly tree = computed(() => accountTree(this.accounts.value() ?? []));
  protected readonly parents = computed(() =>
    (this.accounts.value() ?? []).filter((a) => !a.postable),
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => {
        void this.chart.load();
        void this.accounts.load();
        this.reset();
      });
    });
  }

  protected natureLabel = (v: string) => label(NATURES, v);
  protected levelLabel = (v: string) => label(LEVELS, v);

  protected reset() {
    this.editing.set(null);
    this.form = { ...EMPTY };
    this.action.error.set(null);
  }

  protected edit(a: Account) {
    this.editing.set(a);
    this.action.error.set(null);
    this.form = { ...a, statementLine: a.statementLine ?? '' };
  }

  /** Sugere nível, natureza e prefixo do código a partir da conta-mãe. */
  protected parentChanged() {
    const parent = (this.accounts.value() ?? []).find((a) => a.id === this.form.parentId);
    if (!parent) {
      this.form.level = 'CLASS';
      return;
    }
    this.form.level = parent.level === 'CLASS' ? 'ACCOUNT' : 'SUBACCOUNT';
    this.form.nature = parent.nature;
    this.form.normalBalance = parent.normalBalance;
    if (!this.form.code.startsWith(parent.code)) this.form.code = parent.code;
  }

  protected natureChanged() {
    this.form.normalBalance =
      this.form.nature === 'ASSET' || this.form.nature === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
  }

  protected async save() {
    const a = this.editing();
    const common = {
      name: this.form.name,
      nature: this.form.nature,
      normalBalance: this.form.normalBalance,
      postable: this.form.postable,
      requiresCostCenter: this.form.requiresCostCenter,
      requiresThirdParty: this.form.requiresThirdParty,
      statementLine: this.form.statementLine || null,
      status: this.form.status,
    };
    const result = await this.action.run(() =>
      a
        ? this.deps.api.patch<Account>(`accounting/accounts/${a.id}`, {
            ...common,
            expectedVersion: a.version,
          })
        : this.deps.api.post<Account>('accounting/accounts', {
            ...common,
            chartId: this.id(),
            parentId: this.form.parentId,
            code: this.form.code,
            level: this.form.level,
          }),
    );
    if (!result) return;
    this.toasts.show(a ? 'Conta alterada.' : 'Conta criada.');
    await this.accounts.load();
    if (a) this.edit(result);
    else
      this.form = {
        ...EMPTY,
        parentId: this.form.parentId,
        level: this.form.level,
        nature: this.form.nature,
        normalBalance: this.form.normalBalance,
        code: '',
      };
  }
}
