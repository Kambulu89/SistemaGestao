import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import { itemKey, type OpenItem, type ReconciliationGroup, selectionTotals } from './model';
import { accountingDeps, entityReferences, legalEntityOptions, moneyText } from './shared';

interface Option {
  id: string;
  label: string;
}
interface OpenItems {
  items: OpenItem[];
  truncated: boolean;
  debit: string;
  credit: string;
  balance: string;
}

/**
 * Reconciliação de contas: escolher linhas contabilizadas em aberto de uma conta (e terceiro) cujos débitos e créditos
 * se anulam e reconciliá-las; as reconciliações podem ser desfeitas (auditado).
 */
@Component({
  selector: 'app-reconciliation',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert],
  template: `
    <app-page-header
      title="Reconciliação de contas"
      subtitle="Emparelhe débitos e créditos de uma conta (p. ex. factura e pagamento do mesmo fornecedor)."
    />
    <form
      class="mb-4 flex flex-wrap items-end gap-2"
      (ngSubmit)="load()"
      aria-label="Conta a reconciliar"
    >
      <div>
        <label class="label" for="rc-le">Entidade legal</label>
        <select
          id="rc-le"
          name="le"
          class="input w-64"
          [(ngModel)]="legalEntityId"
          (ngModelChange)="entityChanged()"
        >
          @for (e of entities(); track e.id) {
            <option [ngValue]="e.id">{{ e.label }}</option>
          }
        </select>
      </div>
      <div>
        <label class="label" for="rc-account">Conta</label>
        <select id="rc-account" name="account" class="input w-64" [(ngModel)]="accountId">
          <option [ngValue]="null">—</option>
          @for (a of accounts(); track a.id) {
            <option [ngValue]="a.id">{{ a.label }}</option>
          }
        </select>
      </div>
      <div>
        <label class="label" for="rc-third">Terceiro</label>
        <input
          id="rc-third"
          name="third"
          class="input w-40"
          [(ngModel)]="thirdPartyRef"
          placeholder="Todos"
        />
      </div>
      <button type="submit" class="btn-secondary" [disabled]="!accountId || loadAction.busy()">
        Ver em aberto
      </button>
    </form>
    <app-error-alert [error]="loadAction.error()" />

    @if (open(); as o) {
      <section class="card mb-4 p-0" aria-labelledby="rc-open">
        <div class="flex flex-wrap items-center justify-between gap-2 p-3">
          <h2 id="rc-open" class="font-semibold">
            Em aberto ({{ o.items.length }}{{ o.truncated ? '+' : '' }})
          </h2>
          <p class="text-sm">Saldo em aberto {{ money(o.balance) }}</p>
        </div>
        @if (o.items.length === 0) {
          <p class="p-3 text-sm text-muted">Nada em aberto nesta conta.</p>
        } @else {
          <div class="overflow-x-auto">
            <table class="w-full min-w-[40rem] text-sm">
              <caption class="sr-only">
                Linhas em aberto
              </caption>
              <thead>
                <tr class="border-b border-border text-left">
                  <th scope="col" class="p-2"><span class="sr-only">Escolher</span></th>
                  <th scope="col" class="p-2">Data</th>
                  <th scope="col" class="p-2">Lançamento</th>
                  <th scope="col" class="p-2">Descrição</th>
                  <th scope="col" class="p-2">Terceiro</th>
                  <th scope="col" class="p-2 text-right">Débito</th>
                  <th scope="col" class="p-2 text-right">Crédito</th>
                </tr>
              </thead>
              <tbody>
                @for (i of o.items; track key(i)) {
                  <tr class="border-b border-border">
                    <td class="p-2">
                      <input
                        type="checkbox"
                        [attr.aria-label]="'Escolher ' + (i.number ?? '') + ' linha ' + i.lineNo"
                        [checked]="selected().has(key(i))"
                        (change)="toggle(i)"
                      />
                    </td>
                    <td class="p-2">{{ day(i.date) }}</td>
                    <td class="p-2">
                      <a
                        class="btn-link"
                        [routerLink]="['/contabilidade/lancamentos', i.entryId]"
                        >{{ i.number }}</a
                      >
                    </td>
                    <td class="p-2">{{ i.description }}</td>
                    <td class="p-2">{{ i.thirdPartyRef ?? '—' }}</td>
                    <td class="p-2 text-right">{{ blank(i.debit) }}</td>
                    <td class="p-2 text-right">{{ blank(i.credit) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap items-end gap-2 border-t border-border p-3">
            <p class="text-sm" role="status" data-testid="rc-selection">
              {{ totals().count }} linha(s): débitos {{ money(totals().debit) }}, créditos
              {{ money(totals().credit) }}
              @if (totals().count && !totals().sameThirdParty) {
                — <span class="text-danger-text">terceiros diferentes</span>
              } @else if (totals().count >= 2 && !totals().ready) {
                — <span class="text-danger-text">diferença {{ money(totals().difference) }}</span>
              }
            </p>
            @if (canReconcile()) {
              <div class="flex-1">
                <label class="label" for="rc-note">Nota</label>
                <input id="rc-note" name="note" class="input" [(ngModel)]="note" />
              </div>
              <button
                type="button"
                class="btn-primary"
                [disabled]="!totals().ready || action.busy()"
                (click)="reconcile()"
              >
                Reconciliar
              </button>
            }
          </div>
          <app-error-alert [error]="action.error()" [showDetails]="true" />
        }
      </section>
    }

    @if (groups().length) {
      <section class="card" aria-labelledby="rc-done">
        <h2 id="rc-done" class="mb-2 font-semibold">Reconciliadas</h2>
        <ul class="divide-y divide-border text-sm" data-testid="rc-groups">
          @for (g of groups(); track g.id) {
            <li class="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {{ money(g.total) }}{{ g.thirdPartyRef ? ' · ' + g.thirdPartyRef : '' }} ·
                {{ numbers(g) }}
                @if (g.note) {
                  <span class="text-muted"> — {{ g.note }}</span>
                }
              </span>
              @if (canReconcile()) {
                <button
                  type="button"
                  class="btn-secondary"
                  [attr.aria-label]="'Desfazer reconciliação ' + numbers(g)"
                  (click)="undo(g)"
                >
                  Desfazer
                </button>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class ReconciliationPage {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly canReconcile = computed(() => this.deps.workspace.can('accounting.reconcile'));
  protected readonly entities = signal<Option[]>([]);
  protected readonly accounts = signal<Option[]>([]);
  protected readonly open = signal<OpenItems | null>(null);
  protected readonly groups = signal<ReconciliationGroup[]>([]);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly loadAction = new Action();
  protected readonly action = new Action();
  protected legalEntityId: string | null = null;
  protected accountId: string | null = null;
  protected thirdPartyRef = '';
  protected note = '';
  protected readonly key = itemKey;
  private refRequest = 0;
  protected readonly totals = computed(() => {
    const items = this.open()?.items ?? [];
    const sample = items[0]?.debit ?? '0.00';
    const scale = sample.includes('.') ? sample.split('.')[1].length : 0;
    return selectionTotals(items, this.selected(), scale);
  });

  constructor() {
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      this.legalEntityId = this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
      await this.entityChanged();
    })();
  }

  protected money(v: string) {
    return moneyText(v);
  }
  protected blank(v: string) {
    return /[1-9]/.test(v) ? moneyText(v) : '';
  }
  protected day(v: string) {
    return formatDate(v);
  }
  protected numbers(g: ReconciliationGroup) {
    return g.lines.map((l) => l.number).join(', ');
  }

  protected async entityChanged() {
    this.open.set(null);
    this.groups.set([]);
    this.accounts.set([]);
    this.accountId = null;
    const le = this.legalEntityId;
    const request = ++this.refRequest;
    if (!le) return;
    const refs = await entityReferences(this.deps.api, this.deps.workspace, le);
    if (request !== this.refRequest) return;
    this.accounts.set(refs.accounts);
  }

  protected toggle(i: OpenItem) {
    const next = new Set(this.selected());
    const k = itemKey(i);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    this.selected.set(next);
  }

  protected async load() {
    const params = {
      legalEntityId: this.legalEntityId,
      accountId: this.accountId,
      thirdPartyRef: this.thirdPartyRef.trim() || undefined,
    };
    const result = await this.loadAction.run(async () => {
      const [open, groups] = await Promise.all([
        this.deps.api.get<OpenItems>('accounting/reconciliations/open-items', params),
        this.deps.api.get<ReconciliationGroup[]>('accounting/reconciliations', params),
      ]);
      return { open, groups };
    });
    if (!result) return;
    this.open.set(result.open);
    this.groups.set(result.groups);
    this.selected.set(new Set());
  }

  protected async reconcile() {
    const lines = (this.open()?.items ?? [])
      .filter((i) => this.selected().has(itemKey(i)))
      .map((i) => ({ entryId: i.entryId, lineNo: i.lineNo }));
    const r = await this.action.run(() =>
      this.deps.api.post<{ id: string; lines: number }>('accounting/reconciliations', {
        legalEntityId: this.legalEntityId,
        accountId: this.accountId,
        note: this.note,
        lines,
      }),
    );
    if (!r) return;
    this.toasts.show(`Reconciliadas ${r.lines} linhas.`);
    this.note = '';
    await this.load();
  }

  protected async undo(g: ReconciliationGroup) {
    const ok = await this.confirm.ask({
      title: 'Desfazer reconciliação',
      message: `As linhas ${this.numbers(g)} voltam a ficar em aberto.`,
      confirmLabel: 'Desfazer',
      danger: true,
    });
    if (!ok) return;
    const done = await this.action.run(async () => {
      await this.deps.api.delete(`accounting/reconciliations/${g.id}`);
      return true;
    });
    if (!done) return;
    this.toasts.show('Reconciliação desfeita.');
    await this.load();
  }
}
