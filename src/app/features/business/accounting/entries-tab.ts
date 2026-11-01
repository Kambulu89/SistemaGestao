import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type WritableSignal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { AccountingApi, type EntryDetailDto, type EntryDto } from './accounting.api';
import {
  STATUS_LABEL,
  accountingError,
  defaultJournal,
  formatAmount,
  normalizeAmount,
  todayIso,
  totalsOf,
  type LineDraft,
} from './accounting-model';

const PAGE = 20;
const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: 'DRAFT', label: 'Rascunho' },
  { value: 'POSTED', label: 'Lançado' },
  { value: 'REVERSED', label: 'Revertido' },
];
const blankLine = (): LineDraft => ({ accountId: '', debit: '', credit: '', description: '' });

/**
 * Lançamentos: lista com filtros e paginação do servidor, editor de linhas com totais em tempo real (exactos) e
 * as operações de estado: lançar (numera e torna definitivo) e reverter (lançamento inverso).
 */
@Component({
  selector: 'app-entries-tab',
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
    <div class="mb-3 flex flex-wrap items-end gap-2" data-testid="entry-filters">
      <div class="w-40">
        <app-select
          label="Estado"
          placeholder="Todos"
          [options]="statusOptions"
          [ngModel]="status()"
          (ngModelChange)="setFilter(status, $event)"
        />
      </div>
      <div class="w-48">
        <app-select
          label="Diário"
          placeholder="Todos"
          [options]="journalOptions()"
          [ngModel]="journalId()"
          (ngModelChange)="setFilter(journalId, $event)"
        />
      </div>
      <app-input
        label="De"
        type="date"
        [ngModel]="from()"
        (ngModelChange)="setFilter(from, $event)"
      />
      <app-input label="Até" type="date" [ngModel]="to()" (ngModelChange)="setFilter(to, $event)" />
      @if (canPost()) {
        <app-button class="ml-auto" (click)="openEditor(null)">Novo lançamento</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (entries.isLoading() && !entries.hasValue()) {
        <app-loading-state label="A carregar lançamentos…" />
      } @else if (entries.error()) {
        <div class="p-5">
          <app-alert tone="danger">{{ describe(entries.error()) }}</app-alert>
        </div>
      } @else if (entries.hasValue() && entries.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="document" title="Sem lançamentos" />
        } @else {
          <app-table caption="Lançamentos" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('number') {
                  <span class="font-mono text-xs"
                    >{{ row.journalCode }} {{ row.number ?? '—' }}</span
                  >
                }
                @case ('date') {
                  {{ row.entryDate }}
                }
                @case ('description') {
                  <button type="button" class="text-left underline" (click)="openDetail(row)">
                    {{ row.description }}
                  </button>
                  @if (row.sourceType) {
                    <span class="block text-xs text-fg-muted">Origem: {{ row.sourceType }}</span>
                  }
                }
                @case ('amount') {
                  {{ amount(row.totalDebit) }}
                }
                @case ('status') {
                  <app-badge [tone]="statusOf(row).tone">{{ statusOf(row).label }}</app-badge>
                }
              }
            </ng-template>
          </app-table>
          <div class="flex items-center gap-2 p-3 text-sm text-fg-muted">
            <app-button
              size="sm"
              variant="secondary"
              [disabled]="offset() === 0"
              (click)="turnPage(-1)"
              >Anterior</app-button
            >
            <app-button
              size="sm"
              variant="secondary"
              [disabled]="offset() + pageSize >= page.total"
              (click)="turnPage(1)"
              >Seguinte</app-button
            >
            <span>{{ page.total }} lançamentos</span>
          </div>
        }
      }
    </app-card>

    <app-dialog
      [open]="editing()"
      [wide]="true"
      [title]="draftId() ? 'Editar rascunho' : 'Novo lançamento'"
      (closed)="editing.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="entry-error">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="entry-editor">
        <div class="grid gap-3 sm:grid-cols-3">
          <app-select
            label="Diário"
            [options]="journalOptions()"
            [ngModel]="formJournal()"
            (ngModelChange)="formJournal.set($event ?? '')"
          />
          <app-input
            label="Data"
            type="date"
            [ngModel]="formDate()"
            (ngModelChange)="formDate.set($event ?? '')"
          />
          <app-input
            label="Descrição"
            [ngModel]="formDescription()"
            (ngModelChange)="formDescription.set($event ?? '')"
          />
        </div>
        <table class="w-full text-sm" data-testid="lines">
          <thead>
            <tr class="text-left text-xs text-fg-muted">
              <th class="pb-1">Conta</th>
              <th class="pb-1 text-right">Débito</th>
              <th class="pb-1 text-right">Crédito</th>
              <th class="pb-1">Descrição</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (line of lines(); track $index; let i = $index) {
              <tr [class.bg-red-50]="totals().invalid.includes(i)">
                <td class="py-1 pe-2">
                  <select
                    class="h-9 w-full rounded-lg border border-line bg-surface px-2"
                    [attr.aria-label]="'Conta da linha ' + (i + 1)"
                    [value]="line.accountId"
                    (change)="patchLine(i, 'accountId', $any($event.target).value)"
                  >
                    <option value="">Escolha a conta…</option>
                    @for (a of postingAccounts(); track a.id) {
                      <option [value]="a.id" [selected]="a.id === line.accountId">
                        {{ a.code }} — {{ a.name }}
                      </option>
                    }
                  </select>
                </td>
                <td class="py-1 pe-2">
                  <input
                    class="h-9 w-28 rounded-lg border border-line bg-surface px-2 text-right"
                    inputmode="decimal"
                    [attr.aria-label]="'Débito da linha ' + (i + 1)"
                    [value]="line.debit"
                    (input)="patchLine(i, 'debit', $any($event.target).value)"
                  />
                </td>
                <td class="py-1 pe-2">
                  <input
                    class="h-9 w-28 rounded-lg border border-line bg-surface px-2 text-right"
                    inputmode="decimal"
                    [attr.aria-label]="'Crédito da linha ' + (i + 1)"
                    [value]="line.credit"
                    (input)="patchLine(i, 'credit', $any($event.target).value)"
                  />
                </td>
                <td class="py-1 pe-2">
                  <input
                    class="h-9 w-full rounded-lg border border-line bg-surface px-2"
                    [attr.aria-label]="'Descrição da linha ' + (i + 1)"
                    [value]="line.description"
                    (input)="patchLine(i, 'description', $any($event.target).value)"
                  />
                </td>
                <td>
                  <button type="button" class="text-xs underline" (click)="removeLine(i)">
                    Remover
                  </button>
                </td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr class="font-medium" data-testid="totals">
              <td class="pt-2">
                <app-button size="sm" variant="secondary" (click)="addLine()"
                  >Acrescentar linha</app-button
                >
              </td>
              <td class="pt-2 text-right">{{ amount(totals().debit) }}</td>
              <td class="pt-2 text-right">{{ amount(totals().credit) }}</td>
              <td class="pt-2" colspan="2">
                @if (totals().balanced) {
                  <app-badge tone="success">Equilibrado</app-badge>
                } @else {
                  <app-badge tone="warning" data-testid="difference"
                    >Diferença {{ amount(totals().difference) }}</app-badge
                  >
                }
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="editing.set(false)">Cancelar</app-button>
        <app-button variant="secondary" [loading]="busy()" (click)="save(false)"
          >Guardar rascunho</app-button
        >
        <app-button [loading]="busy()" [disabled]="!totals().balanced" (click)="save(true)"
          >Guardar e lançar</app-button
        >
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="detailId() !== null"
      [wide]="true"
      [title]="detail.value()?.description ?? 'Lançamento'"
      (closed)="detailId.set(null)"
    >
      @if (actionError(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="detail-error">{{
          text
        }}</app-alert>
      }
      @if (detail.hasValue() && detail.value(); as e) {
        <div class="space-y-3" data-testid="entry-detail">
          <p class="text-sm">
            <app-badge [tone]="statusOf(e).tone">{{ statusOf(e).label }}</app-badge>
            <span class="ml-2 font-mono">{{ e.journalCode }} {{ e.number ?? '(sem número)' }}</span>
            · {{ e.entryDate }}
            @if (e.reversalOfId) {
              · inverso de outro lançamento
            }
            @if (e.reversedById) {
              · revertido
            }
          </p>
          <app-table caption="Linhas" [columns]="lineColumns" [rows]="e.lines">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('account') {
                  <span class="font-mono">{{ row.accountCode }}</span> {{ row.accountName }}
                }
                @case ('debit') {
                  {{ row.debit === '0.0000' ? '' : amount(row.debit) }}
                }
                @case ('credit') {
                  {{ row.credit === '0.0000' ? '' : amount(row.credit) }}
                }
                @case ('description') {
                  {{ row.description ?? '' }}
                }
              }
            </ng-template>
          </app-table>
          @if (e.status === 'POSTED' && !e.reversalOfId && canReverse()) {
            <div class="flex items-end gap-2" data-testid="reverse-form">
              <app-input
                label="Data da reversão"
                type="date"
                [ngModel]="reverseDate()"
                (ngModelChange)="reverseDate.set($event ?? '')"
              />
              <app-button variant="secondary" (click)="reverse(e)">Reverter</app-button>
            </div>
          }
        </div>
      }
      <ng-container dialogActions>
        @if (detail.hasValue() && detail.value(); as e) {
          @if (e.status === 'DRAFT' && canPost()) {
            <app-button variant="ghost" (click)="remove(e)">Apagar rascunho</app-button>
            <app-button variant="secondary" (click)="openEditor(e)">Editar</app-button>
            <app-button (click)="post(e)">Lançar</app-button>
          }
        }
        <app-button variant="secondary" (click)="detailId.set(null)">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class EntriesTab {
  private readonly api = inject(AccountingApi);
  private readonly permissions = inject(PermissionService);

  readonly organizationId = input.required<string>();

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly pageSize = PAGE;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Nº' },
    { key: 'date', label: 'Data' },
    { key: 'description', label: 'Descrição' },
    { key: 'amount', label: 'Montante', align: 'end' },
    { key: 'status', label: 'Estado' },
  ];
  protected readonly lineColumns: readonly TableColumn[] = [
    { key: 'account', label: 'Conta' },
    { key: 'debit', label: 'Débito', align: 'end' },
    { key: 'credit', label: 'Crédito', align: 'end' },
    { key: 'description', label: 'Descrição' },
  ];
  protected readonly canPost = computed(() => this.permissions.can('journal.post'));
  protected readonly canReverse = computed(() => this.permissions.can('journal.reverse'));

  protected readonly status = signal('');
  protected readonly journalId = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly offset = signal(0);
  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);

  protected readonly entries = rxResource({
    params: () => ({
      organizationId: this.organizationId(),
      status: this.status(),
      journalId: this.journalId(),
      from: this.from(),
      to: this.to(),
      offset: this.offset(),
      tick: this.tick(),
    }),
    stream: ({ params }) =>
      this.api.entries({
        organizationId: params.organizationId,
        status: params.status,
        journalId: params.journalId,
        from: params.from,
        to: params.to,
        limit: PAGE,
        offset: params.offset,
      }),
  });
  private readonly journals = rxResource({
    params: () => ({ organizationId: this.organizationId() }),
    stream: ({ params }) => this.api.journals(params.organizationId),
  });
  private readonly accounts = rxResource({
    params: () => ({ organizationId: this.organizationId(), tick: this.tick() }),
    stream: ({ params }) => this.api.accounts(params.organizationId),
  });
  protected readonly journalOptions = computed<readonly SelectOption[]>(() =>
    (this.journals.hasValue() ? this.journals.value() : [])
      .filter((j) => j.active)
      .map((j) => ({ value: j.id, label: `${j.code} — ${j.name}` })),
  );
  protected readonly postingAccounts = computed(() =>
    (this.accounts.hasValue() ? this.accounts.value() : []).filter(
      (a) => a.kind === 'POSTING' && a.active,
    ),
  );

  // --- editor
  protected readonly editing = signal(false);
  protected readonly draftId = signal<string | null>(null);
  private readonly draftVersion = signal(0);
  protected readonly formJournal = signal('');
  protected readonly formDate = signal(todayIso());
  protected readonly formDescription = signal('');
  protected readonly lines = signal<readonly LineDraft[]>([blankLine(), blankLine()]);
  protected readonly totals = computed(() => totalsOf(this.lines()));
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);

  // --- detalhe
  protected readonly detailId = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly reverseDate = signal(todayIso());
  protected readonly detail = rxResource({
    params: () => {
      const id = this.detailId();
      return id ? { id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.entry(params.id),
  });

  protected describe = (e: unknown) => accountingError(e, 'Pedido falhado.');
  protected amount = formatAmount;
  protected statusOf = (e: EntryDto) => STATUS_LABEL[e.status];

  protected setFilter(target: WritableSignal<string>, value: unknown): void {
    target.set(typeof value === 'string' ? value : '');
    this.offset.set(0);
  }

  protected turnPage(direction: -1 | 1): void {
    this.offset.update((o) => Math.max(0, o + direction * PAGE));
  }

  protected patchLine(index: number, key: keyof LineDraft, value: string): void {
    this.lines.update((ls) => ls.map((l, i) => (i === index ? { ...l, [key]: value } : l)));
  }

  protected addLine(): void {
    this.lines.update((ls) => [...ls, blankLine()]);
  }

  protected removeLine(index: number): void {
    this.lines.update((ls) => ls.filter((_, i) => i !== index));
  }

  protected openEditor(entry: EntryDetailDto | null): void {
    this.formError.set(null);
    this.detailId.set(null);
    this.draftId.set(entry?.id ?? null);
    this.draftVersion.set(entry?.version ?? 0);
    this.formJournal.set(
      entry?.journalId ??
        defaultJournal(this.journals.hasValue() ? this.journals.value() : [])?.id ??
        '',
    );
    this.formDate.set(entry?.entryDate ?? todayIso());
    this.formDescription.set(entry?.description ?? '');
    this.lines.set(
      entry
        ? entry.lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit === '0.0000' ? '' : l.debit,
            credit: l.credit === '0.0000' ? '' : l.credit,
            description: l.description ?? '',
          }))
        : [blankLine(), blankLine()],
    );
    this.editing.set(true);
  }

  protected openDetail(entry: EntryDto): void {
    this.actionError.set(null);
    this.reverseDate.set(entry.entryDate);
    this.detailId.set(entry.id);
  }

  protected save(andPost: boolean): void {
    this.formError.set(null);
    const lines = [];
    for (const [i, l] of this.lines().entries()) {
      const debit = normalizeAmount(l.debit);
      const credit = normalizeAmount(l.credit);
      if (debit === null || credit === null) {
        this.formError.set(`Linha ${i + 1}: montante inválido (até 4 casas decimais).`);
        return;
      }
      lines.push({
        accountId: l.accountId,
        debit,
        credit,
        description: l.description.trim() || null,
      });
    }
    const body = {
      organizationId: this.organizationId(),
      journalId: this.formJournal(),
      entryDate: this.formDate(),
      description: this.formDescription(),
      lines,
    };
    const id = this.draftId();
    const call = id
      ? this.api.updateEntry(id, { ...body, version: this.draftVersion() })
      : this.api.createEntry(body);
    this.busy.set(true);
    call.subscribe({
      next: (saved) => {
        if (!andPost) {
          this.busy.set(false);
          this.editing.set(false);
          this.changed('Rascunho guardado.');
          return;
        }
        this.api.postEntry(saved.id).subscribe({
          next: (posted) => {
            this.busy.set(false);
            this.editing.set(false);
            this.changed(`Lançado com o número ${posted.journalCode} ${posted.number}.`);
          },
          error: (e: unknown) => {
            // O rascunho ficou guardado: a partir daqui edita-se esse.
            this.busy.set(false);
            this.draftId.set(saved.id);
            this.draftVersion.set(saved.version);
            this.tick.update((t) => t + 1);
            this.formError.set(`Guardado como rascunho, mas não lançado: ${this.describe(e)}`);
          },
        });
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(this.describe(e));
      },
    });
  }

  private act<T>(call: Observable<T>, message: string, close = false): void {
    this.actionError.set(null);
    call.subscribe({
      next: () => {
        this.changed(message);
        if (close) this.detailId.set(null);
      },
      error: (e: unknown) => this.actionError.set(this.describe(e)),
    });
  }

  protected post(entry: EntryDetailDto): void {
    this.act(this.api.postEntry(entry.id), 'Lançamento lançado.');
  }

  protected reverse(entry: EntryDetailDto): void {
    this.act(
      this.api.reverseEntry(entry.id, this.reverseDate()),
      'Lançamento revertido por um lançamento inverso.',
      true,
    );
  }

  protected remove(entry: EntryDetailDto): void {
    this.act(this.api.deleteEntry(entry.id), 'Rascunho apagado.', true);
  }

  private changed(message: string): void {
    this.notice.set(message);
    this.tick.update((t) => t + 1);
  }
}
