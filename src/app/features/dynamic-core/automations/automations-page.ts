import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { StateGuardEditor, type GuardField } from '../states/state-guard-editor';
import {
  AUTOMATION_STATUS,
  canRetry,
  describeTrigger,
  emptyAction,
  ERROR_LABEL,
  eventFieldKind,
  RUN_STATUS,
  toActionDraft,
  toActionDto,
  type ActionDraft,
  type ParamDraft,
} from './automation-model';
import {
  AutomationsApi,
  type AutomationBody,
  type AutomationDto,
  type RunDto,
  type SimulationDto,
} from './automations.api';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Automação' },
  { key: 'trigger', label: 'Gatilho' },
  { key: 'status', label: 'Estado' },
  { key: 'next', label: 'Próxima execução' },
  { key: 'actions', label: '', align: 'end' },
];

const RUN_COLUMNS: readonly TableColumn[] = [
  { key: 'automation', label: 'Automação' },
  { key: 'when', label: 'Criada em' },
  { key: 'status', label: 'Estado' },
  { key: 'attempts', label: 'Tentativas' },
  { key: 'error', label: 'Erro' },
  { key: 'actions', label: '', align: 'end' },
];

const TRIGGERS: readonly SelectOption[] = [
  { value: 'event', label: 'Quando acontece um evento' },
  { value: 'schedule', label: 'Num calendário' },
];

interface Editing {
  /** `null` numa automação nova. */
  readonly id: string | null;
  readonly version: number;
  readonly status: AutomationDto['status'];
}

/**
 * Automações (C15): o gatilho (evento ou calendário), a condição sobre o evento e as acções que os módulos oferecem,
 * com simulação, activação, pausa e o histórico de execuções com a fila de falhas. Uma automação activa executa em nome de
 * quem a activa, com as permissões dessa pessoa; o servidor verifica tudo antes de activar.
 */
@Component({
  selector: 'app-automations-page',
  imports: [
    DatePipe,
    FormsModule,
    PageHeader,
    Card,
    Table,
    Badge,
    Alert,
    Button,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Textarea,
    StateGuardEditor,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Automações"
      description="Reagem a eventos ou a um calendário e executam acções, em nome de quem as activa."
    >
      <div pageActions>
        @if (canManage() && !editing()) {
          <app-button (click)="startNew()">Nova automação</app-button>
        }
      </div>
    </app-page-header>

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }

    @if (!editing()) {
      <app-card [flush]="true">
        @if (automations.isLoading() && !automations.hasValue()) {
          <app-loading-state label="A carregar automações…" />
        } @else if (automations.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as automações">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (automations.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="bolt" title="Ainda não há automações" />
          } @else {
            <app-table
              caption="Automações"
              [columns]="columns"
              [rows]="list"
              data-testid="automations"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                    <span class="block text-xs text-fg-muted"
                      >{{ row.code }} · v{{ row.version }}</span
                    >
                  }
                  @case ('trigger') {
                    {{ trigger(row) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="statusOf(row).tone">{{ statusOf(row).label }}</app-badge>
                    @if (row.issues.length > 0) {
                      <app-badge tone="danger" class="ms-1">Com problemas</app-badge>
                    }
                  }
                  @case ('next') {
                    @if (row.nextRunAt) {
                      {{ row.nextRunAt | date: 'dd/MM/yyyy HH:mm' }}
                      <span class="block text-xs text-fg-muted">{{ row.timezone }}</span>
                    } @else {
                      —
                    }
                  }
                  @case ('actions') {
                    <span class="flex flex-wrap justify-end gap-2">
                      <app-button size="sm" variant="secondary" (click)="showRuns(row)"
                        >Histórico</app-button
                      >
                      @if (canManage() && row.status !== 'ACTIVE') {
                        <app-button size="sm" variant="secondary" (click)="edit(row)"
                          >Editar</app-button
                        >
                        <app-button size="sm" [disabled]="busy()" (click)="activate(row)"
                          >Activar</app-button
                        >
                      }
                      @if (canManage() && row.status === 'ACTIVE') {
                        <app-button
                          size="sm"
                          variant="secondary"
                          [disabled]="busy()"
                          (click)="pause(row)"
                          >Pausar</app-button
                        >
                      }
                    </span>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>

      <div class="mb-3 mt-8 flex items-center justify-between">
        <h2 class="text-base font-semibold">
          Histórico de execuções
          @if (runsOf(); as filter) {
            <span class="text-fg-muted">— {{ filter.name }}</span>
          }
        </h2>
        @if (runsOf()) {
          <app-button size="sm" variant="secondary" (click)="runsOf.set(null)"
            >Ver todas</app-button
          >
        }
      </div>
      <app-card [flush]="true">
        @if (runs.isLoading() && !runs.hasValue()) {
          <app-loading-state label="A carregar execuções…" />
        } @else if (runs.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as execuções">{{
              runsError()
            }}</app-alert>
          </div>
        } @else if (runs.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="bolt" title="Sem execuções" />
          } @else {
            <app-table caption="Execuções" [columns]="runColumns" [rows]="list" data-testid="runs">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('automation') {
                    {{ row.automationCode }}
                    <span class="block text-xs text-fg-muted"
                      >v{{ row.automationVersion }} · nível {{ row.depth }}</span
                    >
                  }
                  @case ('when') {
                    {{ row.createdAt | date: 'dd/MM/yyyy HH:mm:ss' }}
                  }
                  @case ('status') {
                    <app-badge [tone]="runStatus(row).tone">{{ runStatus(row).label }}</app-badge>
                    @if (row.retriedAt) {
                      <app-badge tone="neutral" class="ms-1">Reprocessada</app-badge>
                    }
                  }
                  @case ('attempts') {
                    {{ row.attempts }}
                    @if (row.status === 'PENDING' && row.attempts > 0) {
                      <span class="block text-xs text-fg-muted"
                        >próxima: {{ row.nextAttemptAt | date: 'HH:mm:ss' }}</span
                      >
                    }
                  }
                  @case ('error') {
                    {{ errorText(row) }}
                  }
                  @case ('actions') {
                    @if (canManage() && retriable(row)) {
                      <app-button
                        size="sm"
                        variant="secondary"
                        [disabled]="busy()"
                        (click)="retry(row)"
                        >Reprocessar</app-button
                      >
                    }
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>
      <p class="mt-2 text-sm text-fg-muted">
        Cada evento produz no máximo uma execução por automação. Uma falha repete com intervalos
        crescentes; esgotadas as tentativas, a execução fica na fila de falhas e só um
        reprocessamento manual a devolve à fila (retoma a seguir à última acção concluída).
      </p>
    } @else {
      <div class="space-y-4">
        <app-card [title]="editing()!.id ? 'Editar automação' : 'Nova automação'">
          <div class="grid gap-3 sm:grid-cols-2">
            <app-input
              label="Nome"
              [required]="true"
              [ngModel]="name()"
              (ngModelChange)="name.set($event ?? '')"
            />
            @if (!editing()!.id) {
              <app-input
                label="Código"
                [required]="true"
                hint="Minúsculas, números e _"
                [ngModel]="code()"
                (ngModelChange)="code.set($event ?? '')"
              />
            }
            <div class="sm:col-span-2">
              <app-input
                label="Descrição"
                [ngModel]="description()"
                (ngModelChange)="description.set($event ?? '')"
              />
            </div>
          </div>
        </app-card>

        <app-card title="Gatilho">
          <div class="grid gap-3 sm:grid-cols-2">
            <app-select
              label="Quando"
              [ngModel]="triggerKind()"
              (ngModelChange)="triggerKind.set($event === 'schedule' ? 'schedule' : 'event')"
              [options]="triggers"
            />
            @if (triggerKind() === 'event') {
              <app-select
                label="Evento"
                [ngModel]="eventType()"
                (ngModelChange)="changeEvent($event ?? '')"
                [options]="eventOptions()"
              />
            } @else {
              <app-input
                label="Calendário"
                hint="Cinco campos: minuto hora dia mês dia-da-semana (ex.: 0 9 * * 1-5). Mínimo 5 minutos."
                [ngModel]="schedule()"
                (ngModelChange)="schedule.set($event ?? '')"
              />
              <app-input
                label="Fuso horário"
                hint="Vazio = o do tenant. Ex.: Africa/Luanda"
                [ngModel]="timezone()"
                (ngModelChange)="timezone.set($event ?? '')"
              />
            }
            <app-input
              label="Máximo de execuções por hora"
              type="number"
              [min]="1"
              [ngModel]="maxRuns()"
              (ngModelChange)="maxRuns.set(asNumber($event))"
            />
          </div>
          @if (triggerKind() === 'event') {
            <div class="mt-3">
              <app-state-guard-editor
                testId="condition"
                [guard]="condition()"
                [fields]="conditionFields()"
                (changed)="condition.set($event); touch()"
              />
              <p class="mt-1 text-xs text-fg-muted">
                A condição lê os campos do evento. Sem condição, todos os eventos deste tipo
                executam a automação.
              </p>
            </div>
          }
        </app-card>

        <app-card title="Acções">
          <ol class="space-y-3" data-testid="action-list">
            @for (action of actionDrafts(); track $index; let i = $index) {
              <li class="rounded-lg border border-line p-3" [attr.data-testid]="'action-' + i">
                <app-select
                  label="Acção"
                  [ngModel]="action.type"
                  (ngModelChange)="changeAction(i, $event ?? '')"
                  [options]="actionOptions()"
                />
                @if (descriptorOf(action.type); as d) {
                  <p class="mt-1 text-xs text-fg-muted">{{ d.description }}</p>
                  <div class="mt-2 space-y-2">
                    @for (param of d.params; track param.name) {
                      <div class="grid items-end gap-2 sm:grid-cols-[10rem_1fr]">
                        @if (triggerKind() === 'event') {
                          <app-select
                            [label]="param.name + (param.required ? ' *' : '')"
                            [ngModel]="paramOf(action, param.name).mode"
                            (ngModelChange)="
                              patchParam(i, param.name, {
                                mode: $event === 'event' ? 'event' : 'fixed',
                                value: '',
                              })
                            "
                            [options]="modeOptions"
                          />
                          @if (paramOf(action, param.name).mode === 'event') {
                            <app-select
                              label="Campo do evento"
                              [ngModel]="paramOf(action, param.name).value"
                              (ngModelChange)="patchParam(i, param.name, { value: $event ?? '' })"
                              [options]="payloadOptions()"
                            />
                          } @else {
                            <app-input
                              label="Valor"
                              [hint]="param.description"
                              [ngModel]="paramOf(action, param.name).value"
                              (ngModelChange)="
                                patchParam(i, param.name, { value: ($event ?? '').toString() })
                              "
                            />
                          }
                        } @else {
                          <span class="text-sm font-medium"
                            >{{ param.name }}{{ param.required ? ' *' : '' }}</span
                          >
                          <app-input
                            label="Valor"
                            [hint]="param.description"
                            [ngModel]="paramOf(action, param.name).value"
                            (ngModelChange)="
                              patchParam(i, param.name, { value: ($event ?? '').toString() })
                            "
                          />
                        }
                      </div>
                    }
                  </div>
                }
                <div class="mt-2 flex justify-end">
                  <app-button size="sm" variant="secondary" (click)="dropAction(i)"
                    >Remover acção</app-button
                  >
                </div>
              </li>
            } @empty {
              <li class="text-sm text-fg-muted">Sem acções.</li>
            }
          </ol>
          <div class="mt-3">
            <app-button size="sm" variant="secondary" (click)="newAction()"
              >Adicionar acção</app-button
            >
          </div>
        </app-card>

        @if (issues().length > 0) {
          <app-alert tone="danger" title="O servidor encontrou problemas">
            <ul class="list-disc ps-4" data-testid="issues">
              @for (issue of issues(); track $index) {
                <li>
                  <code class="text-xs">{{ issue.path }}</code
                  >: {{ issue.message }}
                </li>
              }
            </ul>
          </app-alert>
        }
        @if (clientError(); as text) {
          <app-alert tone="danger">{{ text }}</app-alert>
        }

        <app-card title="Simulação">
          <app-textarea
            label="Evento de exemplo (JSON)"
            [rows]="4"
            [ngModel]="sample()"
            (ngModelChange)="sample.set($event ?? '')"
          />
          <div class="mt-2">
            <app-button size="sm" variant="secondary" [loading]="busy()" (click)="simulate()"
              >Simular</app-button
            >
          </div>
          @if (simulation(); as result) {
            <div class="mt-3 text-sm" data-testid="simulation">
              @if (result.conditionError) {
                <p class="text-red-600 dark:text-red-400">Condição: {{ result.conditionError }}</p>
              } @else if (result.conditionPassed === null) {
                <p>Sem condição: executaria.</p>
              } @else {
                <p>
                  Condição:
                  <strong>{{
                    result.conditionPassed
                      ? 'verifica-se (executaria)'
                      : 'não se verifica (não executaria)'
                  }}</strong>
                </p>
              }
              <ul class="mt-1 list-disc ps-4">
                @for (a of result.actions; track $index) {
                  <li>
                    {{ a.type }}:
                    @if (a.error) {
                      <span class="text-red-600 dark:text-red-400">{{ a.error }}</span>
                    } @else {
                      <code class="text-xs">{{ stringify(a.params) }}</code>
                    }
                  </li>
                }
              </ul>
              @if (result.nextRuns.length > 0) {
                <p class="mt-1">
                  Próximas execuções ({{ timezone() || 'fuso do tenant' }}):
                  {{ nextRunsText(result) }}
                </p>
              }
            </div>
          }
          <p class="mt-2 text-xs text-fg-muted">
            A simulação guarda o rascunho e avalia a condição e os parâmetros; não executa nada.
          </p>
        </app-card>

        <div class="flex flex-wrap gap-2">
          <app-button [loading]="busy()" (click)="save()">Guardar rascunho</app-button>
          <app-button variant="secondary" [loading]="busy()" (click)="saveAndActivate()"
            >Guardar e activar</app-button
          >
          <app-button variant="secondary" (click)="closeEditor()">Fechar</app-button>
        </div>
      </div>
    }
  `,
})
export class AutomationsPage {
  private readonly api = inject(AutomationsApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly runColumns = RUN_COLUMNS;
  protected readonly triggers = TRIGGERS;
  protected readonly modeOptions: readonly SelectOption[] = [
    { value: 'fixed', label: 'Valor fixo' },
    { value: 'event', label: 'Campo do evento' },
  ];

  protected readonly canManage = computed(() => this.permissions.can('automation.manage'));

  protected readonly catalog = rxResource({ stream: () => this.api.catalog() });
  private readonly events = computed(() =>
    this.catalog.hasValue() ? this.catalog.value().events : [],
  );
  private readonly actionTypes = computed(() =>
    this.catalog.hasValue() ? this.catalog.value().actions : [],
  );

  private readonly reload = signal(0);
  protected readonly automations = rxResource({
    params: () => ({ reload: this.reload() }),
    stream: () => this.api.list(),
  });
  protected readonly loadError = computed(() => errorMessage(this.automations.error()));

  protected readonly runsOf = signal<AutomationDto | null>(null);
  protected readonly runs = rxResource({
    params: () => ({ automationId: this.runsOf()?.id, reload: this.reload() }),
    stream: ({ params }) => this.api.runs(params.automationId),
  });
  protected readonly runsError = computed(() => errorMessage(this.runs.error()));

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  // ------------------------------------------------------------------- editor
  protected readonly editing = signal<Editing | null>(null);
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly description = signal('');
  protected readonly triggerKind = signal<'event' | 'schedule'>('event');
  protected readonly eventType = signal('');
  protected readonly schedule = signal('');
  protected readonly timezone = signal('');
  protected readonly maxRuns = signal<number | null>(60);
  protected readonly condition = signal<unknown>(undefined);
  protected readonly actionDrafts = signal<readonly ActionDraft[]>([]);
  protected readonly issues = signal<readonly { path: string; message: string }[]>([]);
  protected readonly clientError = signal<string | null>(null);
  protected readonly sample = signal('{}');
  protected readonly simulation = signal<SimulationDto | null>(null);

  protected readonly eventOptions = computed<readonly SelectOption[]>(() =>
    this.events().map((e) => ({ value: e.type, label: e.label })),
  );
  protected readonly actionOptions = computed<readonly SelectOption[]>(() =>
    this.actionTypes().map((a) => ({ value: a.type, label: a.label })),
  );
  private readonly payloadFields = computed(
    () => this.events().find((e) => e.type === this.eventType())?.fields ?? [],
  );
  protected readonly payloadOptions = computed<readonly SelectOption[]>(() =>
    this.payloadFields().map((f) => ({ value: f.name, label: f.name })),
  );
  protected readonly conditionFields = computed<readonly GuardField[]>(() =>
    this.payloadFields().map((f) => ({
      code: f.name,
      label: f.name,
      kind: eventFieldKind(f.kind),
    })),
  );

  protected trigger(row: AutomationDto): string {
    return describeTrigger(row, this.events());
  }

  protected statusOf(row: AutomationDto) {
    return AUTOMATION_STATUS[row.status];
  }

  protected runStatus(row: RunDto) {
    return RUN_STATUS[row.status];
  }

  protected retriable(row: RunDto): boolean {
    return canRetry(row);
  }

  protected errorText(row: RunDto): string {
    if (!row.error && !row.errorCode) return '—';
    return (row.errorCode && ERROR_LABEL[row.errorCode]) || row.error || row.errorCode || '—';
  }

  protected descriptorOf(type: string) {
    return this.actionTypes().find((a) => a.type === type);
  }

  protected paramOf(action: ActionDraft, name: string): ParamDraft {
    return action.params[name] ?? { mode: 'fixed', value: '' };
  }

  protected asNumber(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    return value === null || value === '' || !Number.isInteger(n) ? null : n;
  }

  protected stringify(value: unknown): string {
    return JSON.stringify(value);
  }

  protected nextRunsText(result: SimulationDto): string {
    return result.nextRuns.map((r) => r.replace('T', ' ').slice(0, 16) + ' UTC').join('; ');
  }

  protected touch(): void {
    this.simulation.set(null);
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
    this.issues.set([]);
    this.simulation.set(null);
  }

  protected showRuns(row: AutomationDto): void {
    this.runsOf.set(row);
  }

  protected startNew(): void {
    this.clearMessages();
    this.name.set('');
    this.code.set('');
    this.description.set('');
    this.triggerKind.set('event');
    this.eventType.set('');
    this.schedule.set('');
    this.timezone.set('');
    this.maxRuns.set(60);
    this.condition.set(undefined);
    this.actionDrafts.set([]);
    this.sample.set('{}');
    this.editing.set({ id: null, version: 0, status: 'DRAFT' });
  }

  protected edit(row: AutomationDto): void {
    this.clearMessages();
    this.name.set(row.name);
    this.code.set(row.code);
    this.description.set(row.description ?? '');
    this.triggerKind.set(row.schedule ? 'schedule' : 'event');
    this.eventType.set(row.eventType ?? '');
    this.schedule.set(row.schedule ?? '');
    this.timezone.set(row.timezone);
    this.maxRuns.set(row.maxRunsPerPeriod);
    this.condition.set(row.condition ?? undefined);
    this.actionDrafts.set(row.actions.map((a) => toActionDraft(a, this.descriptorOf(a.type))));
    this.sample.set('{}');
    this.editing.set({ id: row.id, version: row.version, status: row.status });
  }

  protected closeEditor(): void {
    this.editing.set(null);
    this.reload.update((n) => n + 1);
  }

  protected changeEvent(type: string): void {
    this.eventType.set(type);
    this.condition.set(undefined);
    this.touch();
  }

  protected newAction(): void {
    this.actionDrafts.update((list) => [...list, emptyAction(this.actionTypes()[0])]);
    this.touch();
  }

  protected changeAction(index: number, type: string): void {
    this.actionDrafts.update((list) =>
      list.map((a, i) => (i === index ? emptyAction(this.descriptorOf(type)) : a)),
    );
    this.touch();
  }

  protected patchParam(index: number, name: string, patch: Partial<ParamDraft>): void {
    this.actionDrafts.update((list) =>
      list.map((a, i) =>
        i === index
          ? { ...a, params: { ...a.params, [name]: { ...this.paramOf(a, name), ...patch } } }
          : a,
      ),
    );
    this.touch();
  }

  protected dropAction(index: number): void {
    this.actionDrafts.update((list) => list.filter((_, i) => i !== index));
    this.touch();
  }

  // ---------------------------------------------------------------- servidor
  private body(): AutomationBody | null {
    this.clientError.set(null);
    if (!this.name().trim()) {
      this.clientError.set('Indique o nome da automação.');
      return null;
    }
    const event = this.triggerKind() === 'event';
    return {
      name: this.name().trim(),
      description: this.description().trim() || null,
      eventType: event ? this.eventType() || null : null,
      schedule: event ? null : this.schedule().trim() || null,
      timezone: this.timezone().trim(),
      condition: event ? (this.condition() ?? null) : null,
      actions: this.actionDrafts().map(toActionDto),
      maxRunsPerPeriod: this.maxRuns() ?? 60,
    };
  }

  private fail(error: ApiError): void {
    const details = error.fieldErrors ?? [];
    if (details.length > 0) {
      this.issues.set(details.map((d) => ({ path: d.path, message: d.message })));
    } else {
      this.actionError.set(error.message);
    }
  }

  private saveDraft(then: (saved: AutomationDto) => void): void {
    const body = this.body();
    const state = this.editing();
    if (!body || !state) return;
    // O fuso vazio é o do tenant: o servidor aplica-o.
    const payload = body.timezone
      ? body
      : ({ ...body, timezone: undefined } as unknown as AutomationBody);
    this.issues.set([]);
    this.busy.set(true);
    const call = state.id
      ? this.api.update(state.id, state.version, payload)
      : this.api.create(this.code().trim(), payload);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: (saved) => {
        this.editing.set({ id: saved.id, version: saved.version, status: saved.status });
        this.timezone.set(saved.timezone);
        then(saved);
      },
      error: (error: ApiError) => this.fail(error),
    });
  }

  protected save(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.saveDraft(() => this.notice.set('Rascunho guardado.'));
  }

  protected saveAndActivate(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.saveDraft((saved) => {
      this.busy.set(true);
      this.api
        .activate(saved.id, saved.version)
        .pipe(finalize(() => this.busy.set(false)))
        .subscribe({
          next: () => {
            this.editing.set(null);
            this.notice.set('Automação activada.');
            this.reload.update((n) => n + 1);
          },
          error: (error: ApiError) => this.fail(error),
        });
    });
  }

  protected simulate(): void {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(this.sample() || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      this.clientError.set('O evento de exemplo tem de ser um objecto JSON.');
      return;
    }
    this.notice.set(null);
    this.actionError.set(null);
    this.saveDraft((saved) => {
      this.busy.set(true);
      this.api
        .simulate(saved.id, payload)
        .pipe(finalize(() => this.busy.set(false)))
        .subscribe({
          next: (result) => this.simulation.set(result),
          error: (error: ApiError) => this.fail(error),
        });
    });
  }

  protected activate(row: AutomationDto): void {
    this.run(this.api.activate(row.id, row.version), 'Automação activada.');
  }

  protected pause(row: AutomationDto): void {
    this.run(this.api.pause(row.id, row.version), 'Automação pausada.');
  }

  protected retry(row: RunDto): void {
    this.run(this.api.retry(row.id, row.version), 'Execução devolvida à fila.');
  }

  private run(call: Observable<unknown>, done: string): void {
    this.clearMessages();
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.notice.set(done);
        this.reload.update((n) => n + 1);
      },
      error: (error: ApiError) => {
        const details = error.fieldErrors ?? [];
        this.actionError.set(
          details.length > 0
            ? `${error.message} ${details.map((d) => `${d.path}: ${d.message}`).join(' ')}`
            : error.message,
        );
        this.reload.update((n) => n + 1);
      },
    });
  }
}
