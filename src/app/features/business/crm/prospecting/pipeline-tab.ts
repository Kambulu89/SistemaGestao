import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
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
import { CustomersApi } from '../customers/customers.api';
import {
  ProspectingApi,
  type ActivityKind,
  type OpportunityDto,
  type StageDto,
} from './prospecting.api';
import {
  boardOf,
  formatDecimal,
  isMoney,
  prospectingError,
  totalsByCurrency,
} from './prospecting-model';

const KIND_OPTIONS: readonly SelectOption[] = [
  { value: 'CALL', label: 'Chamada' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'MEETING', label: 'Reunião' },
  { value: 'TASK', label: 'Tarefa' },
  { value: 'NOTE', label: 'Nota' },
];

type View = 'board' | 'list';

/**
 * Pipeline de oportunidades: quadro por etapas e lista sobre os mesmos dados. Mover uma oportunidade é uma
 * transição que o servidor valida e regista com a data (perder pede motivo; ganhar pode pedir evidência).
 */
@Component({
  selector: 'app-prospecting-pipeline',
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
    <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div class="flex gap-1" role="group" aria-label="Vista">
        <app-button
          size="sm"
          [variant]="view() === 'board' ? 'primary' : 'secondary'"
          data-testid="view-board"
          (click)="view.set('board')"
          >Quadro</app-button
        >
        <app-button
          size="sm"
          [variant]="view() === 'list' ? 'primary' : 'secondary'"
          data-testid="view-list"
          (click)="view.set('list')"
          >Lista</app-button
        >
      </div>
      @if (canManage()) {
        <app-button (click)="openCreate()">Nova oportunidade</app-button>
      }
    </div>

    @if (metrics.hasValue() && metrics.value(); as m) {
      <div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="metrics">
        <app-card>
          <p class="text-xs text-fg-muted">Em aberto</p>
          @for (v of m.openValue; track v.currency) {
            <p class="text-lg font-semibold">{{ money(v.value) }} {{ v.currency }}</p>
          } @empty {
            <p class="text-lg font-semibold">—</p>
          }
        </app-card>
        <app-card>
          <p class="text-xs text-fg-muted">Ganhas · últimos 30 dias</p>
          <p class="text-lg font-semibold" data-testid="won-count">{{ m.won }}</p>
          @for (v of m.wonValue; track v.currency) {
            <p class="text-xs text-fg-muted">{{ money(v.value) }} {{ v.currency }}</p>
          }
        </app-card>
        <app-card>
          <p class="text-xs text-fg-muted">Perdidas · últimos 30 dias</p>
          <p class="text-lg font-semibold">{{ m.lost }}</p>
        </app-card>
        <app-card>
          <p class="text-xs text-fg-muted">Taxa de ganho</p>
          <p class="text-lg font-semibold" data-testid="win-rate">{{ rate(m.winRate) }}</p>
          @if (m.averageDaysToWin) {
            <p class="text-xs text-fg-muted">
              {{ m.averageDaysToWin.replace('.', ',') }} dias até ganhar
            </p>
          }
        </app-card>
      </div>
    }

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }

    @if (opportunities.isLoading() && !opportunities.hasValue()) {
      <app-loading-state label="A carregar o pipeline…" />
    } @else if (opportunities.error()) {
      <app-alert tone="danger" title="Não foi possível carregar o pipeline">
        {{ describe(opportunities.error()) }}
      </app-alert>
    } @else if (opportunities.hasValue() && opportunities.value(); as page) {
      @if (view() === 'board') {
        <div class="grid gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="board">
          @for (column of board(); track column.stage.id) {
            <section
              class="rounded-lg border border-line bg-surface-muted p-2"
              [attr.data-testid]="'column-' + column.stage.code"
            >
              <header class="mb-2 flex items-center justify-between text-sm font-semibold">
                <span>{{ column.stage.name }}</span>
                <app-badge [tone]="column.stage.outcome === 'LOST' ? 'danger' : 'neutral'">{{
                  column.cards.length
                }}</app-badge>
              </header>
              <ul class="space-y-2">
                @for (card of column.cards; track card.id) {
                  <li
                    class="rounded-md border border-line bg-surface p-2 text-sm"
                    data-testid="card"
                  >
                    <button
                      type="button"
                      class="block w-full text-left font-medium"
                      (click)="select(card)"
                    >
                      {{ card.name }}
                    </button>
                    <span class="block text-xs text-fg-muted">{{
                      card.customerName ?? card.leadName ?? '—'
                    }}</span>
                    <span class="block text-xs"
                      >{{ money(card.expectedValue) }} {{ card.currency }}</span
                    >
                    @if (canManage() && !card.outcome) {
                      <select
                        class="mt-1 h-8 w-full rounded border border-line bg-surface text-xs"
                        [attr.aria-label]="'Mover ' + card.name"
                        (change)="onMoveSelect(card, $event)"
                      >
                        <option value="">Mover para…</option>
                        @for (s of targets(card); track s.id) {
                          <option [value]="s.id">{{ s.name }}</option>
                        }
                      </select>
                    }
                  </li>
                }
              </ul>
            </section>
          }
        </div>
      } @else {
        <app-card [flush]="true">
          @if (page.items.length === 0) {
            <app-empty-state icon="bolt" title="Sem oportunidades" />
          } @else {
            <app-table caption="Oportunidades" [columns]="columns" [rows]="page.items">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <button type="button" class="font-medium" (click)="select(row)">
                      {{ row.name }}
                    </button>
                  }
                  @case ('party') {
                    {{ row.customerName ?? row.leadName ?? '—' }}
                  }
                  @case ('value') {
                    {{ money(row.expectedValue) }} {{ row.currency }}
                  }
                  @case ('stage') {
                    <app-badge
                      [tone]="
                        row.outcome === 'WON'
                          ? 'success'
                          : row.outcome === 'LOST'
                            ? 'danger'
                            : 'brand'
                      "
                      >{{ row.stageName }}</app-badge
                    >
                  }
                }
              </ng-template>
            </app-table>
          }
        </app-card>
      }
    }

    @if (detail.hasValue() && detail.value(); as op) {
      <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="opportunity-title">
        {{ op.name }} — {{ op.stageName }}
      </h3>
      <div class="grid gap-4 lg:grid-cols-2">
        <app-card [flush]="true">
          <p class="border-b border-line px-4 py-2 text-xs font-semibold text-fg-muted">
            Histórico de etapas
          </p>
          <ul class="divide-y divide-line text-sm" data-testid="history">
            @for (h of op.history; track h.id) {
              <li class="px-4 py-2">
                {{ stageName(h.toStageId) }}
                <span class="text-xs text-fg-muted">· {{ h.movedAt.slice(0, 10) }}</span>
              </li>
            }
          </ul>
          @if (op.lossReason) {
            <p class="px-4 py-2 text-sm">Motivo da perda: {{ op.lossReason }}</p>
          }
          @if (op.winEvidence) {
            <p class="px-4 py-2 text-sm">Evidência do ganho: {{ op.winEvidence }}</p>
          }
        </app-card>
        <app-card [flush]="true">
          <p class="border-b border-line px-4 py-2 text-xs font-semibold text-fg-muted">
            Actividades
          </p>
          <ul class="divide-y divide-line text-sm" data-testid="activities">
            @for (a of op.activities; track a.id) {
              <li class="flex items-center justify-between gap-3 px-4 py-2">
                <span [class.line-through]="a.doneAt">{{ a.subject }}</span>
                @if (canManage() && !a.doneAt) {
                  <app-button size="sm" variant="secondary" (click)="complete(a.id)"
                    >Concluir</app-button
                  >
                }
              </li>
            } @empty {
              <li class="px-4 py-2 text-fg-muted">Sem actividades.</li>
            }
          </ul>
          @if (canManage()) {
            <div
              class="flex flex-wrap items-end gap-2 border-t border-line p-3"
              data-testid="activity-form"
            >
              <div class="w-36">
                <app-select
                  label="Tipo"
                  [options]="kindOptions"
                  [ngModel]="activityKind()"
                  (ngModelChange)="activityKind.set($event ?? 'CALL')"
                />
              </div>
              <div class="min-w-40 flex-1">
                <app-input
                  label="Assunto"
                  [ngModel]="activitySubject()"
                  (ngModelChange)="activitySubject.set($event ?? '')"
                />
              </div>
              <app-button size="sm" [loading]="busy()" (click)="addActivity(op.id)"
                >Adicionar</app-button
              >
            </div>
          }
        </app-card>
      </div>
    }

    <app-dialog
      [open]="closing() !== null"
      [title]="closing()?.stage?.outcome === 'LOST' ? 'Perder oportunidade' : 'Ganhar oportunidade'"
      (closed)="closing.set(null)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      @if (closing()?.stage?.outcome === 'LOST') {
        <app-input
          label="Motivo da perda"
          [ngModel]="closeText()"
          (ngModelChange)="closeText.set($event ?? '')"
        />
      } @else {
        <app-input
          [label]="
            closing()?.stage?.requiresEvidence
              ? 'Evidência comercial (obrigatória)'
              : 'Evidência comercial'
          "
          [ngModel]="closeText()"
          (ngModelChange)="closeText.set($event ?? '')"
        />
        <p class="mt-2 text-xs text-fg-muted">Ganhar não cria recebimento nem factura.</p>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="closing.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="confirmClose()">Confirmar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog [open]="creating()" title="Nova oportunidade" (closed)="creating.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="opportunity-form">
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <app-select
          label="Cliente"
          placeholder="Escolha o cliente"
          [options]="customerOptions()"
          [ngModel]="customerId()"
          (ngModelChange)="customerId.set($event ?? '')"
        />
        <app-input
          label="Valor esperado"
          [ngModel]="value()"
          (ngModelChange)="value.set($event ?? '')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class PipelineTab {
  private readonly api = inject(ProspectingApi);
  private readonly customersApi = inject(CustomersApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly kindOptions = KIND_OPTIONS;
  protected readonly canManage = computed(() => this.permissions.can('crm.manage'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Oportunidade' },
    { key: 'party', label: 'Cliente / lead' },
    { key: 'value', label: 'Valor esperado', align: 'end' },
    { key: 'stage', label: 'Etapa' },
  ];

  protected readonly view = signal<View>('board');
  private readonly tick = signal(0);
  private readonly selectedId = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  private readonly scope = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, tick: this.tick() } : undefined;
  };
  protected readonly stages = rxResource({
    params: this.scope,
    stream: () => this.api.stages(),
  });
  protected readonly opportunities = rxResource({
    params: this.scope,
    stream: () => this.api.opportunities({ limit: 200 }),
  });
  protected readonly metrics = rxResource({
    params: this.scope,
    stream: () => this.api.metrics(),
  });
  protected readonly detail = rxResource({
    params: () => {
      const id = this.selectedId();
      return id ? { id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.opportunity(params.id),
  });
  private readonly customers = rxResource({
    params: () => (this.creating() ? true : undefined),
    stream: () => this.customersApi.customers({ limit: 200 }),
  });

  private readonly stageList = computed<readonly StageDto[]>(() =>
    this.stages.hasValue() ? this.stages.value() : [],
  );
  protected readonly board = computed(() =>
    boardOf(
      this.stageList(),
      this.opportunities.hasValue() ? this.opportunities.value().items : [],
    ),
  );
  protected readonly customerOptions = computed<readonly SelectOption[]>(() =>
    (this.customers.hasValue() ? this.customers.value().items : []).map((c) => ({
      value: c.id,
      label: `${c.code} — ${c.partyName}`,
    })),
  );

  protected readonly closing = signal<{ card: OpportunityDto; stage: StageDto } | null>(null);
  protected readonly closeText = signal('');

  protected readonly creating = signal(false);
  protected readonly name = signal('');
  protected readonly customerId = signal('');
  protected readonly value = signal('');

  protected readonly activityKind = signal<string>('CALL');
  protected readonly activitySubject = signal('');

  protected money = formatDecimal;
  protected describe = (e: unknown) => prospectingError(e, 'Pedido falhado.');
  protected totals = totalsByCurrency;
  protected rate = (value: string | null) =>
    value === null ? '—' : `${(Number(value) * 100).toFixed(1).replace('.', ',')} %`;
  protected stageName = (id: string) =>
    this.stageList().find((s) => s.id === id)?.name ?? id.slice(0, 8);
  protected targets = (card: OpportunityDto) =>
    this.stageList().filter((s) => s.id !== card.stageId);

  protected select(card: OpportunityDto): void {
    this.selectedId.set(card.id);
  }

  protected onMoveSelect(card: OpportunityDto, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const stageId = select.value;
    select.value = '';
    if (stageId) this.requestMove(card, stageId);
  }

  /** Mover para uma etapa de ganho ou perda pede o motivo/evidência; as outras movem-se logo. */
  protected requestMove(card: OpportunityDto, stageId: string): void {
    const stage = this.stageList().find((s) => s.id === stageId);
    if (!stage) return;
    this.notice.set(null);
    this.actionError.set(null);
    if (stage.outcome) {
      this.formError.set(null);
      this.closeText.set('');
      this.closing.set({ card, stage });
      return;
    }
    this.move(card.id, { stageId: stage.id }, `Movida para «${stage.name}».`);
  }

  protected confirmClose(): void {
    const pending = this.closing();
    if (!pending) return;
    const text = this.closeText().trim();
    if (pending.stage.outcome === 'LOST' && !text) {
      this.formError.set('Indique o motivo da perda.');
      return;
    }
    if (pending.stage.outcome === 'WON' && pending.stage.requiresEvidence && text.length < 3) {
      this.formError.set('Esta etapa exige a evidência comercial do ganho.');
      return;
    }
    this.busy.set(true);
    this.api
      .move(pending.card.id, {
        stageId: pending.stage.id,
        ...(pending.stage.outcome === 'LOST'
          ? { lossReason: text }
          : text
            ? { winEvidence: text }
            : {}),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.closing.set(null);
          this.notice.set(
            pending.stage.outcome === 'WON' ? 'Oportunidade ganha.' : 'Oportunidade perdida.',
          );
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(prospectingError(e, 'Não foi possível mover a oportunidade.'));
        },
      });
  }

  private move(
    id: string,
    body: { stageId: string; lossReason?: string; winEvidence?: string },
    message: string,
  ): void {
    this.api.move(id, body).subscribe({
      next: () => {
        this.notice.set(message);
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.actionError.set(prospectingError(e, 'Não foi possível mover a oportunidade.'));
        this.tick.update((n) => n + 1);
      },
    });
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.name.set('');
    this.customerId.set('');
    this.value.set('');
    this.creating.set(true);
  }

  protected create(): void {
    if (!this.name().trim() || !this.customerId()) {
      this.formError.set('Indique o nome e o cliente.');
      return;
    }
    if (this.value().trim() && !isMoney(this.value())) {
      this.formError.set('Valor esperado inválido (até 4 casas decimais).');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .createOpportunity({
        name: this.name().trim(),
        customerId: this.customerId(),
        ...(this.value().trim() ? { expectedValue: this.value().trim() } : {}),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.creating.set(false);
          this.notice.set('Oportunidade criada na primeira etapa.');
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(prospectingError(e, 'Não foi possível criar a oportunidade.'));
        },
      });
  }

  protected addActivity(id: string): void {
    if (!this.activitySubject().trim()) {
      this.actionError.set('Indique o assunto da actividade.');
      return;
    }
    this.actionError.set(null);
    this.busy.set(true);
    this.api
      .addActivity(id, {
        kind: this.activityKind() as ActivityKind,
        subject: this.activitySubject().trim(),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.activitySubject.set('');
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.actionError.set(prospectingError(e, 'Não foi possível registar a actividade.'));
        },
      });
  }

  protected complete(id: string): void {
    this.api.completeActivity(id).subscribe({
      next: () => this.tick.update((n) => n + 1),
      error: (e: unknown) =>
        this.actionError.set(prospectingError(e, 'Não foi possível concluir a actividade.')),
    });
  }
}
