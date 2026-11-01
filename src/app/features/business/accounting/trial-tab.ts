import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { AccountingApi } from './accounting.api';
import { accountingError, formatAmount } from './accounting-model';

/** Balancete: saldos iniciais, movimentos e saldos finais por conta de movimento, com subtotais por classe. */
@Component({
  selector: 'app-trial-tab',
  imports: [FormsModule, Alert, Badge, Card, EmptyState, Input, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end gap-2">
      <app-input
        label="De"
        type="date"
        [ngModel]="from()"
        (ngModelChange)="from.set($event ?? '')"
      />
      <app-input label="Até" type="date" [ngModel]="to()" (ngModelChange)="to.set($event ?? '')" />
    </div>
    @if (trial.isLoading() && !trial.hasValue()) {
      <app-loading-state label="A calcular o balancete…" />
    } @else if (trial.error()) {
      <app-alert tone="danger">{{ describe(trial.error()) }}</app-alert>
    } @else if (trial.hasValue() && trial.value(); as t) {
      @if (t.rows.length === 0) {
        <app-empty-state icon="document" title="Sem movimentos até esta data" />
      } @else {
        <p class="mb-2 text-sm" data-testid="trial-check">
          @if (
            t.totals.periodDebit === t.totals.periodCredit &&
            t.totals.closingDebit === t.totals.closingCredit
          ) {
            <app-badge tone="success">Débitos = créditos</app-badge>
          } @else {
            <app-badge tone="danger">Balancete desequilibrado</app-badge>
          }
        </p>
        <app-card [flush]="true">
          <div class="overflow-x-auto">
            <table class="w-full min-w-[48rem] text-sm" data-testid="trial">
              <caption class="sr-only">
                Balancete
              </caption>
              <thead>
                <tr class="border-b border-line text-left text-xs text-fg-muted">
                  <th class="p-2">Conta</th>
                  <th class="p-2 text-right">Inicial débito</th>
                  <th class="p-2 text-right">Inicial crédito</th>
                  <th class="p-2 text-right">Débitos</th>
                  <th class="p-2 text-right">Créditos</th>
                  <th class="p-2 text-right">Saldo devedor</th>
                  <th class="p-2 text-right">Saldo credor</th>
                </tr>
              </thead>
              <tbody>
                @for (r of t.rows; track r.accountId) {
                  <tr class="border-b border-line">
                    <td class="p-2">
                      <span class="font-mono">{{ r.code }}</span> {{ r.name }}
                    </td>
                    <td class="p-2 text-right">{{ amount(r.openingDebit) }}</td>
                    <td class="p-2 text-right">{{ amount(r.openingCredit) }}</td>
                    <td class="p-2 text-right">{{ amount(r.periodDebit) }}</td>
                    <td class="p-2 text-right">{{ amount(r.periodCredit) }}</td>
                    <td class="p-2 text-right">{{ amount(r.closingDebit) }}</td>
                    <td class="p-2 text-right">{{ amount(r.closingCredit) }}</td>
                  </tr>
                }
                @for (c of t.byClass; track c.accountClass) {
                  <tr class="border-b border-line bg-surface-muted text-xs">
                    <td class="p-2">Classe {{ c.accountClass }}</td>
                    <td class="p-2" colspan="2"></td>
                    <td class="p-2 text-right">{{ amount(c.periodDebit) }}</td>
                    <td class="p-2 text-right">{{ amount(c.periodCredit) }}</td>
                    <td class="p-2 text-right">{{ amount(c.closingDebit) }}</td>
                    <td class="p-2 text-right">{{ amount(c.closingCredit) }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr class="font-semibold" data-testid="trial-totals">
                  <td class="p-2">Totais</td>
                  <td class="p-2 text-right">{{ amount(t.totals.openingDebit) }}</td>
                  <td class="p-2 text-right">{{ amount(t.totals.openingCredit) }}</td>
                  <td class="p-2 text-right">{{ amount(t.totals.periodDebit) }}</td>
                  <td class="p-2 text-right">{{ amount(t.totals.periodCredit) }}</td>
                  <td class="p-2 text-right">{{ amount(t.totals.closingDebit) }}</td>
                  <td class="p-2 text-right">{{ amount(t.totals.closingCredit) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </app-card>
        <p class="mt-2 text-xs text-fg-muted">
          Calculado em tempo real às {{ t.asOf.slice(11, 19) }} (UTC).
        </p>
      }
    }
  `,
})
export class TrialTab {
  private readonly api = inject(AccountingApi);

  readonly organizationId = input.required<string>();

  protected readonly from = signal(`${new Date().getFullYear()}-01-01`);
  protected readonly to = signal(`${new Date().getFullYear()}-12-31`);

  protected readonly trial = rxResource({
    params: () =>
      this.from() && this.to()
        ? { organizationId: this.organizationId(), from: this.from(), to: this.to() }
        : undefined,
    stream: ({ params }) => this.api.trialBalance(params.organizationId, params.from, params.to),
  });

  protected describe = (e: unknown) => accountingError(e, 'Não foi possível calcular o balancete.');
  protected amount = formatAmount;
}
