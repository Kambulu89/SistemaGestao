import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { ReportPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { isZeroMoney, money, PROBLEM, type Reconciliation } from './valuation-model';

interface AccountsInfo {
  mappings: { accountingClass: string; account: { id: string; code: string; name: string } }[];
  classes: string[];
  accounts: { id: string; code: string; name: string; postable: boolean }[];
}

/**
 * Reconciliação do inventário com a contabilidade (8.9): valor do stock por classe contabilística à data (do livro de
 * custo) contra o saldo da conta configurada, e a coerência interna (livro = saldos = camadas; quantidade = stock).
 */
@Component({
  selector: 'app-valuation-reconciliation',
  imports: [FormsModule, ReportPage, FormField, FieldControl, ErrorAlert],
  template: `
    <app-report-page
      title="Reconciliação do inventário"
      subtitle="Valor do stock por classe contabilística, à data, contra o saldo da conta do razão."
      [busy]="busy()"
      [error]="error()"
      [canRun]="!!legalEntityId"
      [hasResult]="!!r()"
      [exportable]="false"
      [summary]="summary()"
      (run)="load()"
    >
      <div params class="flex flex-wrap items-end gap-3">
        <app-field label="Entidade legal" [required]="true">
          <select
            appControl
            class="input"
            name="le"
            data-testid="rc-le"
            [(ngModel)]="legalEntityId"
          >
            <option value="">—</option>
            @for (e of entities(); track e.id) {
              <option [value]="e.id">{{ e.code }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data">
          <input
            appControl
            type="date"
            class="input"
            name="date"
            data-testid="rc-date"
            [(ngModel)]="date"
          />
        </app-field>
      </div>
      @if (r(); as x) {
        <section class="card" aria-labelledby="rc-acc" data-testid="rc-accounts">
          <h2 id="rc-acc" class="mb-3 font-semibold">Inventário × razão em {{ x.date }}</h2>
          @if (x.accounts.length) {
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-muted">
                    <th class="py-2 pr-3">Conta</th>
                    <th class="py-2 pr-3">Classes</th>
                    <th class="py-2 pr-3 text-right">Inventário</th>
                    <th class="py-2 pr-3 text-right">Razão</th>
                    <th class="py-2 text-right">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  @for (a of x.accounts; track a.accountId) {
                    <tr
                      class="border-b border-border"
                      [attr.data-testid]="'rc-acc-' + a.account.code"
                    >
                      <td class="py-2 pr-3">{{ a.account.code }} — {{ a.account.name }}</td>
                      <td class="py-2 pr-3">{{ a.classes.join(', ') }}</td>
                      <td class="py-2 pr-3 text-right">{{ m(a.inventoryValue) }}</td>
                      <td class="py-2 pr-3 text-right">{{ m(a.ledgerBalance) }}</td>
                      <td
                        class="py-2 text-right font-medium"
                        [class.text-danger-text]="!zero(a.difference)"
                        [class.text-success-text]="zero(a.difference)"
                        data-testid="rc-diff"
                      >
                        {{ zero(a.difference) ? 'Reconciliado' : m(a.difference) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="text-sm text-muted">Nenhuma classe tem conta configurada.</p>
          }
          @if (x.unmappedClasses.length) {
            <p class="mt-3 text-sm text-warning-text" data-testid="rc-unmapped">
              Classes com valor sem conta: {{ x.unmappedClasses.join(', ') }}.
            </p>
          }
          @if (x.productsWithoutCost) {
            <p class="mt-1 text-sm text-warning-text">
              {{ x.productsWithoutCost }} produto(s) com entradas sem custo (stock anterior à
              valorização ou sem custo conhecido): corrija com um ajuste de custo.
            </p>
          }
        </section>
        <section class="card" aria-labelledby="rc-int" data-testid="rc-internal">
          <h2 id="rc-int" class="mb-1 font-semibold">Coerência interna</h2>
          @if (x.internal.differences.length) {
            <ul class="text-sm">
              @for (d of x.internal.differences; track d.productId) {
                <li class="text-danger-text">{{ d.sku }}: {{ problems(d.problems) }}</li>
              }
            </ul>
          } @else {
            <p class="text-sm text-success-text">
              {{ x.internal.checked }} saldo(s) verificados: livro, saldos de custo, camadas e stock
              batem.
            </p>
          }
        </section>
        @if (accounts(); as a) {
          <section class="card" aria-labelledby="rc-map">
            <h2 id="rc-map" class="mb-3 font-semibold">Conta de cada classe</h2>
            <div class="grid gap-3 sm:grid-cols-2">
              @for (c of classes(); track c) {
                <app-field [label]="c">
                  <select
                    appControl
                    class="input"
                    [attr.data-testid]="'rc-map-' + c"
                    [(ngModel)]="mapping[c]"
                    [disabled]="!canManage()"
                  >
                    <option value="">—</option>
                    @for (acc of a.accounts; track acc.id) {
                      <option [value]="acc.id">{{ acc.code }} — {{ acc.name }}</option>
                    }
                  </select>
                </app-field>
              }
            </div>
            @if (canManage()) {
              <app-error-alert [error]="save.error()" [showDetails]="true" />
              <div class="mt-3 flex justify-end">
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="rc-save"
                  [disabled]="save.busy()"
                  (click)="saveMapping()"
                >
                  Guardar contas
                </button>
              </div>
            }
          </section>
        }
      }
    </app-report-page>
  `,
})
export class ValuationReconciliation {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly entities = signal<{ id: string; code: string }[]>([]);
  protected readonly r = signal<Reconciliation | null>(null);
  protected readonly accounts = signal<AccountsInfo | null>(null);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly busy = signal(false);
  protected readonly summary = computed(() => {
    const r = this.r();
    const le = this.entities().find((e) => e.id === r?.legalEntityId)?.code;
    return r ? `${le ?? ''} · ${r.date}` : null;
  });
  protected readonly save = new Action();
  protected legalEntityId = '';
  protected date = new Date().toISOString().slice(0, 10);
  protected mapping: Record<string, string> = {};
  protected readonly m = money;
  protected readonly zero = isZeroMoney;
  protected readonly canManage = computed(() =>
    this.workspace.canAny('inventory.valuation.manage'),
  );
  protected readonly classes = computed(() => {
    const a = this.accounts();
    const r = this.r();
    return [
      ...new Set([
        ...(a?.classes ?? []),
        ...(a?.mappings.map((x) => x.accountingClass) ?? []),
        ...(r?.classes.map((x) => x.accountingClass).filter((c) => c !== 'SEM_CLASSE') ?? []),
      ]),
    ].sort();
  });

  constructor() {
    this.api.get<{ id: string; code: string }[]>('organization/legal-entities').then(
      (e) => {
        this.entities.set(e);
        if (e.length === 1) {
          this.legalEntityId = e[0].id;
          void this.load();
        }
      },
      () => undefined,
    );
  }

  protected problems(p: string[]) {
    return p.map((x) => PROBLEM[x] ?? x).join('; ');
  }

  protected async load() {
    this.error.set(null);
    if (!this.legalEntityId) return;
    this.busy.set(true);
    try {
      const [r, a] = await Promise.all([
        this.api.get<Reconciliation>('inventory/valuation/reconciliation', {
          legalEntityId: this.legalEntityId,
          date: this.date,
        }),
        this.api.get<AccountsInfo>('inventory/valuation/accounts', {
          legalEntityId: this.legalEntityId,
        }),
      ]);
      this.r.set(r);
      this.accounts.set(a);
      const mapped = Object.fromEntries(a.mappings.map((x) => [x.accountingClass, x.account.id]));
      // Todas as classes começam em "—" (sem conta) para o selector mostrar o estado real.
      this.mapping = Object.fromEntries(this.classes().map((c) => [c, mapped[c] ?? '']));
    } catch (e) {
      this.error.set(ApiError.from(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveMapping() {
    const mappings = Object.entries(this.mapping)
      .filter(([, accountId]) => accountId)
      .map(([accountingClass, accountId]) => ({ accountingClass, accountId }));
    const res = await this.save.run(() =>
      this.api.put<AccountsInfo>(
        `inventory/valuation/accounts?legalEntityId=${this.legalEntityId}`,
        { mappings },
      ),
    );
    if (!res) return;
    this.toasts.show('Contas guardadas.');
    await this.load();
  }
}
