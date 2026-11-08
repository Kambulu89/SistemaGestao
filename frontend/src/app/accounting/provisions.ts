import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action, Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import {
  normalizeAmount,
  PROVISION_MOVEMENT_LABELS,
  type Provision,
  type ProvisionMovementType,
} from './model';
import {
  accountingDeps,
  entityReferences,
  keepKnown,
  legalEntityOptions,
  moneyText,
} from './shared';

interface Option {
  id: string;
  label: string;
}

const ACCOUNT_FIELDS = [
  ['expenseAccountId', 'Gasto (constituição)'],
  ['provisionAccountId', 'Conta da provisão'],
  ['reversalAccountId', 'Rendimento (reversão)'],
] as const;

/**
 * Provisões: cadastro com as contas e movimentos (constituição/reforço, reversão, utilização) que geram rascunhos.
 * O saldo nunca fica negativo; o saldo contabilizado só conta lançamentos já contabilizados.
 */
@Component({
  selector: 'app-provisions',
  imports: [
    FormsModule,
    RouterLink,
    EntityListPage,
    DataTable,
    CellDef,
    StatusBadge,
    ErrorAlert,
    FormSection,
    FormField,
    FieldControl,
  ],
  template: `
    <app-entity-list-page
      title="Provisões"
      subtitle="Constituições, reversões e utilizações; cada movimento gera um rascunho para aprovar."
      permission="accounting.read"
      feature="accounting"
    >
      <app-data-table
        tableId="acc-provisions"
        label="Provisões"
        [columns]="columns"
        [rows]="list.value() ?? []"
        [total]="list.value()?.length ?? 0"
        [loading]="list.loading()"
        [error]="list.error()"
        emptyText="Ainda não há provisões."
        (retry)="list.load()"
      >
        <ng-template appCell="code" let-row>
          <button type="button" class="btn-link" (click)="select(row)">{{ row.code }}</button>
        </ng-template>
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>

      @if (current(); as p) {
        <section class="card mt-4" aria-labelledby="prv-detail">
          <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="prv-detail" class="font-semibold">{{ p.code }} — {{ p.name }}</h2>
            <p class="text-sm" data-testid="prv-balance">
              Saldo <strong>{{ money(p.balance) }}</strong> · contabilizado
              {{ money(p.postedBalance) }}
            </p>
          </div>
          @if (p.movements?.length) {
            <ul class="mb-3 divide-y divide-border text-sm">
              @for (m of p.movements; track m.id) {
                <li
                  class="flex flex-wrap justify-between gap-2 py-1"
                  [class.text-muted]="m.reversed"
                >
                  <span>
                    {{ date(m.date) }} · <strong>{{ typeText(m.type) }}</strong> ·
                    {{ money(m.amount) }} —
                    {{ m.reason }}
                    @if (m.reversed) {
                      (estornado)
                    }
                  </span>
                  <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', m.entryId]">{{
                    m.entryNumber ?? 'rascunho'
                  }}</a>
                </li>
              }
            </ul>
          }
          @if (canManage()) {
            <form
              class="flex flex-wrap items-end gap-2"
              (ngSubmit)="move()"
              aria-label="Movimento da provisão"
            >
              <div>
                <label class="label" for="mv-type">Movimento</label>
                <select id="mv-type" name="type" class="input w-52" [(ngModel)]="mv.type">
                  @for (t of types; track t[0]) {
                    <option [value]="t[0]">{{ t[1] }}</option>
                  }
                </select>
              </div>
              <div>
                <label class="label" for="mv-date">Data</label>
                <input
                  id="mv-date"
                  name="date"
                  type="date"
                  class="input w-44"
                  [(ngModel)]="mv.date"
                />
              </div>
              <div>
                <label class="label" for="mv-amount">Montante</label>
                <input
                  id="mv-amount"
                  name="amount"
                  inputmode="decimal"
                  class="input w-36"
                  [(ngModel)]="mv.amount"
                />
              </div>
              @if (mv.type === 'USE') {
                <div>
                  <label class="label" for="mv-counter">Conta de contrapartida</label>
                  <select
                    id="mv-counter"
                    name="counter"
                    class="input w-64"
                    [(ngModel)]="mv.counterAccountId"
                  >
                    <option [ngValue]="null">—</option>
                    @for (a of accounts(); track a.id) {
                      <option [ngValue]="a.id">{{ a.label }}</option>
                    }
                  </select>
                </div>
              }
              <div class="min-w-48 flex-1">
                <label class="label" for="mv-reason">Motivo</label>
                <input id="mv-reason" name="reason" class="input" [(ngModel)]="mv.reason" />
              </div>
              <button type="submit" class="btn-primary" [disabled]="moveAction.busy()">
                Registar movimento
              </button>
            </form>
            <app-error-alert [error]="moveAction.error()" [showDetails]="true" />
          }
        </section>
      }

      @if (canManage()) {
        <form
          class="mt-4 space-y-3"
          (ngSubmit)="save()"
          [attr.aria-label]="current() ? 'Alterar provisão' : 'Nova provisão'"
        >
          <app-error-alert [error]="action.error()" [showDetails]="true" />
          <app-form-section [title]="current() ? 'Alterar ' + current()!.code : 'Nova provisão'">
            <app-field
              label="Entidade legal"
              [required]="true"
              [error]="action.field('legalEntityId')"
            >
              <select
                appControl
                class="input"
                name="le"
                [disabled]="!!current()"
                [(ngModel)]="form.legalEntityId"
                (ngModelChange)="loadRefs()"
              >
                <option [ngValue]="null">—</option>
                @for (e of entities(); track e.id) {
                  <option [ngValue]="e.id">{{ e.label }}</option>
                }
              </select>
            </app-field>
            <app-field label="Código" [required]="true" [error]="action.field('code')">
              <input
                appControl
                class="input"
                name="code"
                [disabled]="!!current()"
                [(ngModel)]="form.code"
              />
            </app-field>
            <app-field label="Nome" [required]="true" [error]="action.field('name')">
              <input appControl class="input" name="name" [(ngModel)]="form.name" />
            </app-field>
            <app-field label="Diário" [required]="true" [error]="action.field('journalId')">
              <select appControl class="input" name="journal" [(ngModel)]="form.journalId">
                <option [ngValue]="null">—</option>
                @for (j of journals(); track j.id) {
                  <option [ngValue]="j.id">{{ j.label }}</option>
                }
              </select>
            </app-field>
            @for (f of accountFields; track f[0]) {
              <app-field [label]="f[1]" [required]="true" [error]="action.field(f[0])">
                <select appControl class="input" [name]="f[0]" [(ngModel)]="form[f[0]]">
                  <option [ngValue]="null">—</option>
                  @for (a of accounts(); track a.id) {
                    <option [ngValue]="a.id">{{ a.label }}</option>
                  }
                </select>
              </app-field>
            }
            <app-field label="Centro de custo" [error]="action.field('costCenterId')">
              <select appControl class="input" name="cc" [(ngModel)]="form.costCenterId">
                <option [ngValue]="null">—</option>
                @for (c of centers(); track c.id) {
                  <option [ngValue]="c.id">{{ c.label }}</option>
                }
              </select>
            </app-field>
            <app-field label="Estado">
              <select appControl class="input" name="status" [(ngModel)]="form.status">
                <option value="ACTIVE">Activa</option>
                <option value="INACTIVE">Inactiva</option>
              </select>
            </app-field>
          </app-form-section>
          <div class="flex gap-2">
            <button type="submit" class="btn-primary" [disabled]="action.busy()">
              {{ current() ? 'Guardar provisão' : 'Criar provisão' }}
            </button>
            @if (current()) {
              <button type="button" class="btn-secondary" (click)="reset()">Nova provisão</button>
            }
          </div>
        </form>
      }
    </app-entity-list-page>
  `,
})
export class Provisions {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly accountFields = ACCOUNT_FIELDS;
  protected readonly types = Object.entries(PROVISION_MOVEMENT_LABELS);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.adjustments'));
  protected readonly entities = signal<Option[]>([]);
  protected readonly journals = signal<Option[]>([]);
  protected readonly accounts = signal<Option[]>([]);
  protected readonly centers = signal<Option[]>([]);
  protected readonly current = signal<Provision | null>(null);
  protected readonly action = new Action();
  protected readonly moveAction = new Action();
  protected form = this.blank(null);
  protected mv = this.blankMove();
  private refRequest = 0;
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly list = new Loadable(
    async () =>
      (await this.deps.api.page<Provision>('accounting/provisions', { limit: 200 })).items,
  );
  protected readonly columns: Column<Provision>[] = [
    { key: 'code', required: true, label: 'Código' },
    { key: 'name', label: 'Nome' },
    {
      key: 'legalEntityId',
      label: 'Entidade',
      hideOnMobile: true,
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
    },
    { key: 'balance', label: 'Saldo', align: 'end', value: (r) => moneyText(r.balance) },
    {
      key: 'postedBalance',
      label: 'Contabilizado',
      align: 'end',
      hideOnMobile: true,
      value: (r) => moneyText(r.postedBalance),
    },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.list.load();
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      this.form.legalEntityId =
        this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
      await this.loadRefs();
    })();
  }

  private blank(legalEntityId: string | null) {
    return {
      legalEntityId,
      code: '',
      name: '',
      journalId: null as string | null,
      expenseAccountId: null as string | null,
      provisionAccountId: null as string | null,
      reversalAccountId: null as string | null,
      costCenterId: null as string | null,
      status: 'ACTIVE',
    };
  }

  private blankMove() {
    return {
      type: 'CONSTITUTION' as ProvisionMovementType,
      date: new Date().toISOString().slice(0, 10),
      amount: '',
      counterAccountId: null as string | null,
      reason: '',
    };
  }

  protected money(v: string) {
    return moneyText(v);
  }
  protected date(v: string) {
    return formatDate(v);
  }
  protected typeText(t: ProvisionMovementType) {
    return PROVISION_MOVEMENT_LABELS[t];
  }

  protected async loadRefs() {
    const le = this.form.legalEntityId;
    const request = ++this.refRequest;
    this.journals.set([]);
    this.accounts.set([]);
    this.centers.set([]);
    if (!le) return;
    const refs = await entityReferences(this.deps.api, this.deps.workspace, le);
    if (request !== this.refRequest) return;
    this.journals.set(refs.journals);
    this.accounts.set(refs.accounts);
    this.centers.set(refs.centers);
    keepKnown(this.form, ['journalId'], refs.journals);
    keepKnown(
      this.form,
      ['expenseAccountId', 'provisionAccountId', 'reversalAccountId'],
      refs.accounts,
    );
    keepKnown(this.form, ['costCenterId'], refs.centers);
    if (!this.form.journalId && refs.journals.length === 1)
      this.form.journalId = refs.journals[0].id;
  }

  protected async select(p: Provision) {
    const full = await this.deps.api.get<Provision>(`accounting/provisions/${p.id}`);
    this.current.set(full);
    this.form = {
      legalEntityId: full.legalEntityId,
      code: full.code,
      name: full.name,
      journalId: full.journalId,
      expenseAccountId: full.expenseAccountId,
      provisionAccountId: full.provisionAccountId,
      reversalAccountId: full.reversalAccountId,
      costCenterId: full.costCenterId,
      status: full.status,
    };
    this.mv = this.blankMove();
    this.moveAction.error.set(null);
    await this.loadRefs();
  }

  protected reset() {
    this.current.set(null);
    this.form = this.blank(this.form.legalEntityId);
    void this.loadRefs();
  }

  protected async save() {
    const p = this.current();
    const { legalEntityId, code, ...changes } = this.form;
    const result = await this.action.run(() =>
      p
        ? this.deps.api.patch<Provision>(`accounting/provisions/${p.id}`, {
            expectedVersion: p.version,
            ...changes,
          })
        : this.deps.api.post<Provision>('accounting/provisions', {
            legalEntityId,
            code,
            ...changes,
          }),
    );
    if (!result) return;
    this.toasts.show(p ? 'Provisão guardada.' : 'Provisão criada.');
    this.current.set(result);
    await this.list.load();
  }

  protected async move() {
    const p = this.current()!;
    const result = await this.moveAction.run(() =>
      this.deps.api.post<Provision>(`accounting/provisions/${p.id}/movements`, {
        ...this.mv,
        amount: normalizeAmount(this.mv.amount),
        counterAccountId: this.mv.type === 'USE' ? this.mv.counterAccountId : undefined,
      }),
    );
    if (!result) return;
    this.toasts.show('Movimento registado: rascunho criado.');
    this.current.set(result);
    this.mv = this.blankMove();
    await this.list.load();
  }
}
