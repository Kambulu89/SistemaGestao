import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { Dialog } from '../../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { FinanceApi } from './finance.api';
import {
  ReconciliationApi,
  type MatchDto,
  type MatchState,
  type StatementLineDto,
  type SuggestionDto,
} from './reconciliation.api';
import {
  formatDecimal,
  MATCH_STATE,
  parseStatementCsv,
  reconciliationError,
  type ParsedStatement,
} from './reconciliation-model';

const STATE_OPTIONS: readonly SelectOption[] = (Object.keys(MATCH_STATE) as MatchState[]).map(
  (value) => ({ value, label: MATCH_STATE[value].label }),
);

/**
 * Conciliação bancária: importa o extracto, sugere movimentos para cada linha e regista as correspondências que uma
 * pessoa confirma. O extracto nunca cria nem altera movimentos de tesouraria.
 */
@Component({
  selector: 'app-finance-reconciliation',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end gap-3">
      <div class="min-w-64">
        <app-select
          label="Conta bancária"
          placeholder="Escolha a conta"
          [options]="accountOptions()"
          [ngModel]="accountId()"
          (ngModelChange)="chooseAccount($event ?? '')"
        />
      </div>
      @if (accountId()) {
        <div class="min-w-48">
          <app-select
            label="Estado das linhas"
            placeholder="Todas"
            [options]="stateOptions"
            [ngModel]="lineState()"
            (ngModelChange)="lineState.set($event ?? '')"
          />
        </div>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }

    @if (!accountId()) {
      <app-card>
        <app-empty-state
          icon="card"
          title="Escolha uma conta bancária"
          description="Só as contas bancárias têm extracto para conciliar."
        />
      </app-card>
    } @else {
      @if (summary.hasValue() && summary.value(); as s) {
        <div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="summary">
          <app-card>
            <p class="text-xs text-fg-muted">Saldo do livro</p>
            <p class="text-lg font-semibold">{{ money(s.bookBalance) }} {{ s.currency }}</p>
          </app-card>
          <app-card>
            <p class="text-xs text-fg-muted">Total do extracto importado</p>
            <p class="text-lg font-semibold">{{ money(s.statementTotal) }} {{ s.currency }}</p>
          </app-card>
          <app-card>
            <p class="text-xs text-fg-muted">Extracto por conciliar</p>
            <p class="text-lg font-semibold" data-testid="open-statement">
              {{ money(s.unmatchedStatementAmount) }}
            </p>
            <p class="text-xs text-fg-muted">
              {{ s.lines.unmatched }} por conciliar · {{ s.lines.partial }} parciais ·
              {{ s.lines.matched }} conciliadas
            </p>
          </app-card>
          <app-card>
            <p class="text-xs text-fg-muted">Livro por conciliar</p>
            <p class="text-lg font-semibold" data-testid="open-book">
              {{ money(s.unmatchedBookAmount) }}
            </p>
            <p class="text-xs text-fg-muted">
              {{ s.entries.unmatched }} por conciliar · {{ s.entries.partial }} parciais ·
              {{ s.entries.matched }} conciliados
            </p>
          </app-card>
        </div>
      }

      @if (canImport()) {
        <app-card class="mb-4 block">
          <h3 class="mb-2 text-sm font-semibold">Importar extracto</h3>
          <p class="mb-2 text-xs text-fg-muted">
            Ficheiro CSV do banco com cabeçalhos (data, valor ou crédito/débito, descrição,
            referência). Importar o mesmo extracto outra vez não duplica linhas.
          </p>
          <div class="flex flex-wrap items-end gap-3">
            <label class="text-sm">
              <span class="mb-1 block font-medium">Ficheiro</span>
              <input
                type="file"
                accept=".csv,.txt"
                data-testid="statement-file"
                (change)="read($event)"
              />
            </label>
            <label class="min-w-64 flex-1 text-sm">
              <span class="mb-1 block font-medium">…ou cole o conteúdo</span>
              <textarea
                class="h-20 w-full rounded-lg border border-line bg-surface p-2 text-sm"
                data-testid="statement-text"
                [ngModel]="csv()"
                (ngModelChange)="setCsv($event ?? '')"
              ></textarea>
            </label>
            <app-button [loading]="busy()" [disabled]="!parsed().lines.length" (click)="importCsv()"
              >Importar {{ parsed().lines.length }} linhas</app-button
            >
          </div>
          @if (parsed().errors.length > 0) {
            <app-alert tone="danger" class="mt-3 block" data-testid="csv-errors">
              {{ parsed().errors.slice(0, 5).join(' ') }}
            </app-alert>
          }
        </app-card>
      }

      <h3 class="mb-2 text-sm font-semibold">Extracto</h3>
      <app-card [flush]="true">
        @if (lines.isLoading() && !lines.hasValue()) {
          <app-loading-state label="A carregar o extracto…" />
        } @else if (lines.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar o extracto">
              {{ describe(lines.error()) }}
            </app-alert>
          </div>
        } @else if (lines.hasValue() && lines.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="card" title="Sem linhas de extracto" />
          } @else {
            <app-table caption="Linhas do extracto" [columns]="lineColumns" [rows]="page.items">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('occurredOn') {
                    {{ row.occurredOn }}
                  }
                  @case ('description') {
                    {{ row.description ?? '—' }}
                    @if (row.reference) {
                      <span class="block text-xs text-fg-muted">{{ row.reference }}</span>
                    }
                  }
                  @case ('amount') {
                    <span [class.text-red-600]="row.amountSigned.startsWith('-')">{{
                      money(row.amountSigned)
                    }}</span>
                  }
                  @case ('matched') {
                    {{ money(row.matched) }}
                  }
                  @case ('state') {
                    <app-badge [tone]="stateOf(row.state).tone">{{
                      stateOf(row.state).label
                    }}</app-badge>
                  }
                  @case ('actions') {
                    <span class="flex justify-end">
                      <app-button size="sm" variant="secondary" (click)="open(row)">{{
                        row.state === 'MATCHED' ? 'Ver' : 'Conciliar'
                      }}</app-button>
                    </span>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>

      @if (detail.hasValue() && detail.value(); as line) {
        <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="line-title">
          Linha de {{ line.occurredOn }} · {{ money(line.amountSigned) }} ·
          {{ stateOf(line.state).label }}
        </h3>
        <app-card [flush]="true">
          <ul class="divide-y divide-line" data-testid="line-matches">
            @for (m of line.matches; track m.id) {
              <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
                <span [class.line-through]="m.undoneAt" [class.text-fg-muted]="m.undoneAt">
                  {{ money(m.matchedAmount) }} ligado ao movimento
                  {{ m.treasuryEntryId.slice(0, 8) }}
                  @if (m.undoneAt) {
                    — desfeita: {{ m.undoReason }}
                  }
                </span>
                @if (canConfirm() && !m.undoneAt) {
                  <app-button size="sm" variant="secondary" (click)="askUndo(m)"
                    >Desfazer</app-button
                  >
                }
              </li>
            } @empty {
              <li class="px-4 py-2 text-sm text-fg-muted">Ainda sem correspondências.</li>
            }
          </ul>
        </app-card>

        @if (line.state !== 'MATCHED') {
          <h3 class="mb-2 mt-4 text-sm font-semibold">Sugestões</h3>
          <app-card [flush]="true">
            @if (suggestions.hasValue() && suggestions.value(); as list) {
              @if (list.length === 0) {
                <app-empty-state
                  icon="card"
                  title="Sem movimentos candidatos"
                  description="Não há movimentos por conciliar nesta conta, com o mesmo sentido, a menos de 30 dias."
                />
              } @else {
                <ul class="divide-y divide-line" data-testid="suggestions">
                  @for (s of list; track s.entryId) {
                    <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
                      <span>
                        <strong>{{ money(s.entry.amountSigned) }}</strong> ·
                        {{ s.entry.occurredOn }}
                        @if (s.entry.partyName) {
                          · {{ s.entry.partyName }}
                        }
                        <span class="block text-xs text-fg-muted">
                          {{ s.reasons.join(' · ') }} · pontuação {{ s.score }} · por conciliar
                          {{ money(s.entry.remaining) }}
                        </span>
                      </span>
                      @if (canConfirm()) {
                        <app-button size="sm" [loading]="busy()" (click)="confirm(line, s)"
                          >Confirmar {{ money(s.matchableAmount) }}</app-button
                        >
                      }
                    </li>
                  }
                </ul>
              }
            }
          </app-card>
        }
      }

      <h3 class="mb-2 mt-6 text-sm font-semibold">Movimentos do livro por conciliar</h3>
      <app-card [flush]="true">
        @if (entries.hasValue() && entries.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="card" title="Todos os movimentos estão conciliados" />
          } @else {
            <app-table
              caption="Movimentos por conciliar"
              [columns]="entryColumns"
              [rows]="page.items"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('occurredOn') {
                    {{ row.occurredOn }}
                  }
                  @case ('amount') {
                    {{ money(row.amountSigned) }}
                  }
                  @case ('party') {
                    {{ row.partyName ?? '—' }}
                  }
                  @case ('remaining') {
                    {{ money(row.remaining) }}
                  }
                  @case ('state') {
                    <app-badge [tone]="stateOf(row.state).tone">{{
                      stateOf(row.state).label
                    }}</app-badge>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>

      @if (batches.hasValue() && batches.value(); as b) {
        @if (b.items.length > 0) {
          <h3 class="mb-2 mt-6 text-sm font-semibold">Extractos importados</h3>
          <app-card [flush]="true">
            <ul class="divide-y divide-line" data-testid="batches">
              @for (batch of b.items; track batch.id) {
                <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span>
                    {{ batch.fileName ?? 'Sem nome' }} · {{ batch.lineCount }} linhas
                    @if (batch.skippedCount > 0) {
                      · {{ batch.skippedCount }} ignoradas
                    }
                  </span>
                  @if (canImport()) {
                    <app-button size="sm" variant="secondary" (click)="discard(batch.id)"
                      >Descartar</app-button
                    >
                  }
                </li>
              }
            </ul>
          </app-card>
        }
      }
    }

    <app-dialog
      [open]="undoing() !== null"
      title="Desfazer correspondência"
      (closed)="undoing.set(null)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <app-input label="Motivo" [ngModel]="reason()" (ngModelChange)="reason.set($event ?? '')" />
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="undoing.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="undo()">Desfazer</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class ReconciliationTab {
  private readonly api = inject(ReconciliationApi);
  private readonly finance = inject(FinanceApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly stateOptions = STATE_OPTIONS;
  protected readonly canImport = computed(() => this.permissions.can('reconciliation.manage'));
  protected readonly canConfirm = computed(() => this.permissions.can('reconciliation.confirm'));
  protected readonly lineColumns: readonly TableColumn[] = [
    { key: 'occurredOn', label: 'Data' },
    { key: 'description', label: 'Descrição' },
    { key: 'amount', label: 'Valor', align: 'end' },
    { key: 'matched', label: 'Conciliado', align: 'end' },
    { key: 'state', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];
  protected readonly entryColumns: readonly TableColumn[] = [
    { key: 'occurredOn', label: 'Data' },
    { key: 'party', label: 'Entidade' },
    { key: 'amount', label: 'Valor', align: 'end' },
    { key: 'remaining', label: 'Por conciliar', align: 'end' },
    { key: 'state', label: 'Estado' },
  ];

  protected readonly accountId = signal('');
  protected readonly lineState = signal('');
  private readonly tick = signal(0);
  private readonly selectedLine = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly csv = signal('');
  protected readonly parsed = signal<ParsedStatement>({ lines: [], errors: [] });
  private fileName: string | undefined;

  protected readonly undoing = signal<MatchDto | null>(null);
  protected readonly reason = signal('');

  private readonly accounts = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.finance.accounts({ limit: 200 }),
  });
  protected readonly accountOptions = computed<readonly SelectOption[]>(() =>
    (this.accounts.hasValue() ? this.accounts.value().items : [])
      .filter((a) => a.type === 'BANK')
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
  );

  private readonly scope = () => {
    const tenant = this.tenantId();
    const accountId = this.accountId();
    return tenant && accountId ? { tenantId: tenant.id, accountId, tick: this.tick() } : undefined;
  };
  protected readonly summary = rxResource({
    params: this.scope,
    stream: ({ params }) => this.api.summary(params.accountId),
  });
  protected readonly lines = rxResource({
    params: () => {
      const base = this.scope();
      return base ? { ...base, state: this.lineState() } : undefined;
    },
    stream: ({ params }) =>
      this.api.lines({
        accountId: params.accountId,
        limit: 100,
        ...(params.state ? { state: params.state as MatchState } : {}),
      }),
  });
  protected readonly entries = rxResource({
    params: this.scope,
    stream: ({ params }) => this.api.entries({ accountId: params.accountId, limit: 100 }),
  });
  protected readonly batches = rxResource({
    params: this.scope,
    stream: ({ params }) => this.api.batches(params.accountId),
  });
  protected readonly detail = rxResource({
    params: () => {
      const id = this.selectedLine();
      return id ? { id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.line(params.id),
  });
  protected readonly suggestions = rxResource({
    params: () => {
      const id = this.selectedLine();
      return id ? { id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.suggestions(params.id),
  });

  protected describe = (e: unknown) => reconciliationError(e, 'Pedido falhado.');
  protected money = formatDecimal;
  protected stateOf = (state: MatchState) => MATCH_STATE[state];

  protected chooseAccount(id: string): void {
    this.accountId.set(id);
    this.selectedLine.set(null);
    this.lineState.set('');
    this.notice.set(null);
    this.actionError.set(null);
  }

  protected open(line: StatementLineDto): void {
    this.selectedLine.set(line.id);
  }

  protected read(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.fileName = file.name;
    file
      .text()
      .then((text) => this.setCsv(text))
      .catch(() => this.actionError.set('Não foi possível ler o ficheiro.'));
  }

  protected setCsv(text: string): void {
    this.csv.set(text);
    this.parsed.set(text.trim() === '' ? { lines: [], errors: [] } : parseStatementCsv(text));
  }

  protected importCsv(): void {
    const lines = this.parsed().lines;
    if (lines.length === 0 || this.parsed().errors.length > 0) {
      this.actionError.set('Corrija os erros do ficheiro antes de importar.');
      return;
    }
    this.run(
      this.api.importStatement({
        accountId: this.accountId(),
        ...(this.fileName ? { fileName: this.fileName } : {}),
        lines,
      }),
      (result) =>
        result.imported === 0
          ? `Nada de novo: ${result.skipped} linhas já estavam importadas.`
          : `${result.imported} linhas importadas, ${result.skipped} ignoradas por já existirem.`,
      () => {
        this.csv.set('');
        this.parsed.set({ lines: [], errors: [] });
        this.fileName = undefined;
      },
    );
  }

  protected confirm(line: StatementLineDto, suggestion: SuggestionDto): void {
    this.run(
      this.api.confirm({
        statementLineId: line.id,
        treasuryEntryId: suggestion.entryId,
        amount: suggestion.matchableAmount,
      }),
      () => 'Correspondência confirmada.',
    );
  }

  protected askUndo(match: MatchDto): void {
    this.formError.set(null);
    this.reason.set('');
    this.undoing.set(match);
  }

  protected undo(): void {
    const match = this.undoing();
    if (!match) return;
    if (!this.reason().trim()) {
      this.formError.set('Indique o motivo.');
      return;
    }
    this.busy.set(true);
    this.api.undo(match.id, this.reason().trim()).subscribe({
      next: () => {
        this.busy.set(false);
        this.undoing.set(null);
        this.notice.set('Correspondência desfeita.');
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(reconciliationError(e, 'Não foi possível desfazer.'));
      },
    });
  }

  protected discard(id: string): void {
    this.run(this.api.discardBatch(id), () => 'Extracto descartado.');
  }

  private run<T>(call: Observable<T>, message: (result: T) => string, after?: () => void): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.subscribe({
      next: (result) => {
        this.busy.set(false);
        this.notice.set(message(result));
        after?.();
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(reconciliationError(e, 'Não foi possível concluir a operação.'));
        this.tick.update((n) => n + 1);
      },
    });
  }
}
