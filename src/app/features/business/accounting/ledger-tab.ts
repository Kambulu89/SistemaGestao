import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Alert } from '../../../shared/ui/alert/alert';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { AccountingApi, type LedgerDto } from './accounting.api';
import { accountingError, formatAmount } from './accounting-model';

/** Razão de uma conta (de cabeçalho: soma as subcontas) com saldo inicial, movimentos e saldo acumulado. */
@Component({
  selector: 'app-ledger-tab',
  imports: [FormsModule, Alert, Card, EmptyState, Input, LoadingState, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end gap-2" data-testid="ledger-filters">
      <div class="w-80">
        <app-select
          label="Conta"
          [options]="accountOptions()"
          [ngModel]="accountId()"
          (ngModelChange)="accountId.set($event ?? '')"
        />
      </div>
      <app-input
        label="De"
        type="date"
        [ngModel]="from()"
        (ngModelChange)="from.set($event ?? '')"
      />
      <app-input label="Até" type="date" [ngModel]="to()" (ngModelChange)="to.set($event ?? '')" />
    </div>
    @if (!accountId()) {
      <app-empty-state icon="document" title="Escolha uma conta" />
    } @else if (ledger.isLoading() && !ledger.hasValue()) {
      <app-loading-state label="A calcular o razão…" />
    } @else if (ledger.error()) {
      <app-alert tone="danger">{{ describe(ledger.error()) }}</app-alert>
    } @else if (ledger.hasValue() && ledger.value(); as l) {
      <app-card [flush]="true">
        <table class="w-full text-sm" data-testid="ledger">
          <caption class="sr-only">
            Razão
          </caption>
          <thead>
            <tr class="border-b border-line text-left text-xs text-fg-muted">
              <th class="p-2">Data</th>
              <th class="p-2">Lançamento</th>
              <th class="p-2">Descrição</th>
              <th class="p-2 text-right">Débito</th>
              <th class="p-2 text-right">Crédito</th>
              <th class="p-2 text-right">Saldo</th>
            </tr>
          </thead>
          <tbody>
            <tr class="border-b border-line text-fg-muted">
              <td class="p-2" colspan="5">Saldo inicial</td>
              <td class="p-2 text-right" data-testid="opening">{{ amount(l.opening) }}</td>
            </tr>
            @for (r of l.rows; track $index) {
              <tr class="border-b border-line">
                <td class="p-2">{{ r.entryDate }}</td>
                <td class="p-2 font-mono text-xs">{{ r.journalCode }} {{ r.number }}</td>
                <td class="p-2">{{ r.lineDescription ?? r.description }}</td>
                <td class="p-2 text-right">{{ r.debit === '0.0000' ? '' : amount(r.debit) }}</td>
                <td class="p-2 text-right">{{ r.credit === '0.0000' ? '' : amount(r.credit) }}</td>
                <td class="p-2 text-right">{{ amount(r.balance) }}</td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr class="font-semibold">
              <td class="p-2" colspan="3">Totais e saldo final</td>
              <td class="p-2 text-right">{{ amount(l.totalDebit) }}</td>
              <td class="p-2 text-right">{{ amount(l.totalCredit) }}</td>
              <td class="p-2 text-right" data-testid="closing">{{ amount(l.closing) }}</td>
            </tr>
          </tfoot>
        </table>
        <p class="p-2 text-xs text-fg-muted">
          Saldo positivo = devedor; negativo = credor. Inclui lançamentos revertidos e os seus
          inversos.
        </p>
      </app-card>
    }
  `,
})
export class LedgerTab {
  private readonly api = inject(AccountingApi);

  readonly organizationId = input.required<string>();

  protected readonly accountId = signal('');
  protected readonly from = signal(`${new Date().getFullYear()}-01-01`);
  protected readonly to = signal(`${new Date().getFullYear()}-12-31`);

  private readonly accounts = rxResource({
    params: () => ({ organizationId: this.organizationId() }),
    stream: ({ params }) => this.api.accounts(params.organizationId),
  });
  protected readonly accountOptions = computed<readonly SelectOption[]>(() =>
    (this.accounts.hasValue() ? this.accounts.value() : []).map((a) => ({
      value: a.id,
      label: `${a.code} — ${a.name}`,
    })),
  );
  protected readonly ledger = rxResource<
    LedgerDto,
    { id: string; from: string; to: string } | undefined
  >({
    params: () => {
      const id = this.accountId();
      return id && this.from() && this.to() ? { id, from: this.from(), to: this.to() } : undefined;
    },
    stream: ({ params }) => this.api.ledger(params.id, params.from, params.to),
  });

  protected describe = (e: unknown) => accountingError(e, 'Não foi possível calcular o razão.');
  protected amount = formatAmount;
}
