import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, of } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { entityCodeOf, fieldCodeOf } from '../../../core/dynamic/http/dynamic-mapper';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { IamApi, type MemberDto, type RoleDto } from '../../tenant/data-access/iam.api';
import { ruleValueKind } from '../rules/value-kind';
import { nextCode, slug } from '../states/state-machine-model';
import { StateGuardEditor, type GuardField } from '../states/state-guard-editor';
import {
  addApprover,
  addStage,
  CRITERIA_LABEL,
  describeStage,
  localProblems,
  moveStage,
  removeApprover,
  removeStage,
  setCriteria,
  updateStage,
} from './workflow-model';
import {
  WorkflowsApi,
  type ApproverType,
  type Criteria,
  type GraphDto,
  type StageDto,
  type WorkflowBody,
  type WorkflowDto,
} from './workflows.api';

const STATUS: Record<
  WorkflowDto['status'],
  { label: string; tone: 'success' | 'neutral' | 'warning' }
> = {
  DRAFT: { label: 'Rascunho', tone: 'warning' },
  PUBLISHED: { label: 'Publicado', tone: 'success' },
  RETIRED: { label: 'Retirado', tone: 'neutral' },
};

const CRITERIA: readonly SelectOption[] = (['ALL', 'ANY', 'QUORUM'] as const).map((value) => ({
  value,
  label: CRITERIA_LABEL[value],
}));

const APPROVER_TYPES: readonly SelectOption[] = [
  { value: 'MEMBERSHIP', label: 'Pessoa' },
  { value: 'ROLE', label: 'Papel (tarefa de grupo)' },
];

const AUTO_CODE = /^etapa(_\d+)?$/;

interface Editing {
  /** `null` num workflow novo (ainda sem revisão no servidor). */
  readonly id: string | null;
  readonly version: number;
}

/**
 * Designer de workflows de aprovação (C14): etapas em sequência, cada uma com responsáveis (pessoas ou papéis), critério
 * ALL/ANY/QUORUM, prazo, condição de aplicação e proibição de auto-aprovação. O servidor verifica o workflow (condições
 * e campos contra a entidade, responsáveis resolvíveis) antes de o publicar; um workflow publicado nunca se altera.
 */
@Component({
  selector: 'app-entity-workflows-page',
  imports: [
    FormsModule,
    RouterLink,
    PageHeader,
    Card,
    Table,
    Badge,
    Alert,
    Button,
    Checkbox,
    EmptyState,
    Input,
    LoadingState,
    Select,
    StateGuardEditor,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      <app-page-header
        [title]="'Aprovações de ' + entity.names.plural"
        description="Etapas de aprovação por que um registo passa. A decisão é do servidor; o workflow nunca altera o registo."
      >
        <div pageActions class="flex flex-wrap items-center gap-3">
          <a routerLink=".." class="text-sm text-brand-700 hover:underline dark:text-brand-300"
            >Definição da entidade</a
          >
          @if (canManage() && !editing()) {
            <app-button (click)="startNew()">Novo workflow</app-button>
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
          @if (workflows.isLoading() && !workflows.hasValue()) {
            <app-loading-state label="A carregar workflows…" />
          } @else if (workflows.error()) {
            <div class="p-5">
              <app-alert tone="danger" title="Não foi possível carregar os workflows">{{
                loadError()
              }}</app-alert>
            </div>
          } @else if (workflows.value(); as list) {
            @if (list.length === 0) {
              <app-empty-state icon="check" title="Esta entidade ainda não tem workflows" />
            } @else {
              <app-table caption="Workflows" [columns]="columns" [rows]="list">
                <ng-template let-row let-column="column">
                  @switch (column.key) {
                    @case ('name') {
                      <span class="font-medium">{{ row.name }}</span>
                      <span class="block text-xs text-fg-muted"
                        >{{ row.code }} · revisão {{ row.revision }}</span
                      >
                    }
                    @case ('summary') {
                      {{ row.graph.stages.length }} etapa(s)
                    }
                    @case ('status') {
                      <app-badge [tone]="statusOf(row).tone">{{ statusOf(row).label }}</app-badge>
                      @if (row.issues.length > 0) {
                        <app-badge tone="danger" class="ms-1">Com problemas</app-badge>
                      }
                    }
                    @case ('actions') {
                      <span class="flex flex-wrap justify-end gap-2">
                        @if (canManage() && row.status === 'DRAFT') {
                          <app-button size="sm" variant="secondary" (click)="edit(row)"
                            >Editar</app-button
                          >
                        }
                        @if (canManage() && row.status !== 'DRAFT' && isLatest(row)) {
                          <app-button size="sm" variant="secondary" (click)="revise(row)"
                            >Nova revisão</app-button
                          >
                        }
                        @if (canPublish() && row.status === 'DRAFT') {
                          <app-button size="sm" (click)="publishFromList(row)">Publicar</app-button>
                        }
                        @if (canPublish() && row.status === 'PUBLISHED') {
                          <app-button size="sm" variant="secondary" (click)="retire(row)"
                            >Retirar</app-button
                          >
                        }
                      </span>
                    }
                    @default {
                      {{ row[column.key] }}
                    }
                  }
                </ng-template>
              </app-table>
            }
          }
        </app-card>
        <p class="mt-2 text-sm text-fg-muted">
          Um workflow publicado não se altera: abre-se uma nova revisão. Os processos em curso
          mantêm a revisão com que foram submetidos.
        </p>
      } @else {
        <div class="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div class="space-y-4">
            <app-card [title]="editing()!.id ? 'Editar rascunho' : 'Novo workflow'">
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
                <app-select
                  label="Campo do montante"
                  placeholder="Sem montante"
                  [ngModel]="graph().amountField ?? null"
                  (ngModelChange)="patchGraph({ amountField: $event || undefined })"
                  [options]="amountOptions()"
                />
                <app-select
                  label="Campo da moeda"
                  placeholder="Sem moeda"
                  [ngModel]="graph().currencyField ?? null"
                  (ngModelChange)="patchGraph({ currencyField: $event || undefined })"
                  [options]="currencyOptions()"
                />
              </div>
              <p class="mt-2 text-sm text-fg-muted">
                O montante aparece na caixa de aprovações e limita as delegações.
              </p>
            </app-card>

            <app-card title="Etapas">
              <ol class="space-y-3" data-testid="stages">
                @for (stage of graph().stages; track $index; let i = $index) {
                  <li class="rounded-lg border border-line p-3" [attr.data-testid]="'stage-' + i">
                    <div class="grid gap-3 sm:grid-cols-[1fr_1fr_14rem]">
                      <app-input
                        label="Nome da etapa"
                        [ngModel]="stage.label"
                        (ngModelChange)="relabel(i, $event ?? '')"
                      />
                      <app-input
                        label="Código"
                        [ngModel]="stage.code"
                        (ngModelChange)="patchStage(i, { code: $event ?? '' })"
                      />
                      <app-select
                        label="Critério"
                        [ngModel]="stage.criteria"
                        (ngModelChange)="changeCriteria(i, $event)"
                        [options]="criteriaOptions"
                      />
                    </div>

                    <div class="mt-3">
                      <p class="mb-1 text-sm font-medium">Responsáveis</p>
                      <ul class="flex flex-wrap gap-2" [attr.data-testid]="'approvers-' + i">
                        @for (approver of stage.approvers; track $index; let j = $index) {
                          <li
                            class="inline-flex items-center gap-1 rounded-full bg-surface-muted px-3 py-1 text-sm"
                          >
                            {{ approverName(approver.type, approver.id) }}
                            @if (approver.type === 'ROLE') {
                              <app-badge tone="brand">grupo</app-badge>
                            }
                            <button
                              type="button"
                              class="ms-1 text-fg-muted hover:text-fg"
                              [attr.aria-label]="
                                'Retirar ' + approverName(approver.type, approver.id)
                              "
                              (click)="dropApprover(i, j)"
                            >
                              ×
                            </button>
                          </li>
                        } @empty {
                          <li class="text-sm text-fg-muted">Ainda sem responsáveis.</li>
                        }
                      </ul>
                      <div class="mt-2 grid items-end gap-2 sm:grid-cols-[12rem_1fr_auto]">
                        <app-select
                          label="Tipo"
                          [ngModel]="pickType()"
                          (ngModelChange)="pickType.set($event === 'ROLE' ? 'ROLE' : 'MEMBERSHIP')"
                          [options]="approverTypes"
                        />
                        <app-select
                          label="Responsável"
                          [ngModel]="pickId()"
                          (ngModelChange)="pickId.set($event ?? '')"
                          [options]="pickOptions()"
                        />
                        <app-button
                          size="sm"
                          variant="secondary"
                          [disabled]="pickId() === ''"
                          (click)="appendApprover(i)"
                          >Adicionar</app-button
                        >
                      </div>
                      @if (pickOptions().length === 0) {
                        <p class="mt-1 text-xs text-fg-muted">
                          Sem permissão para listar
                          {{ pickType() === 'ROLE' ? 'papéis' : 'membros' }}.
                        </p>
                      }
                    </div>

                    <div class="mt-3 grid gap-3 sm:grid-cols-3">
                      @if (stage.criteria === 'QUORUM') {
                        <app-input
                          label="Aprovações necessárias"
                          type="number"
                          [min]="1"
                          [max]="Math.max(stage.approvers.length, 1)"
                          [ngModel]="stage.quorum ?? null"
                          (ngModelChange)="patchStage(i, { quorum: asInteger($event) })"
                        />
                      }
                      <app-input
                        label="Prazo (horas)"
                        type="number"
                        [min]="1"
                        hint="Vazio = sem prazo. Um prazo vencido não aprova nada."
                        [ngModel]="stage.dueInHours ?? null"
                        (ngModelChange)="patchStage(i, { dueInHours: asInteger($event) })"
                      />
                      <div class="self-end">
                        <app-checkbox
                          label="Quem submete pode decidir"
                          [ngModel]="stage.allowSelfApproval"
                          (ngModelChange)="patchStage(i, { allowSelfApproval: $event === true })"
                        />
                      </div>
                    </div>

                    <div class="mt-3">
                      <app-state-guard-editor
                        [testId]="'condition-' + i"
                        [guard]="stage.condition"
                        [fields]="conditionFields()"
                        (changed)="patchStage(i, { condition: $event })"
                      />
                      <p class="mt-1 text-xs text-fg-muted">
                        A etapa é dispensada quando a condição, avaliada sobre o registo submetido,
                        não se verifica.
                      </p>
                    </div>

                    <div class="mt-3 flex justify-end gap-2">
                      <app-button
                        size="sm"
                        variant="secondary"
                        [disabled]="i === 0"
                        (click)="shift(i, -1)"
                        >Subir</app-button
                      >
                      <app-button
                        size="sm"
                        variant="secondary"
                        [disabled]="i === graph().stages.length - 1"
                        (click)="shift(i, 1)"
                        >Descer</app-button
                      >
                      <app-button size="sm" variant="secondary" (click)="dropStage(i)"
                        >Remover etapa</app-button
                      >
                    </div>
                  </li>
                } @empty {
                  <li class="text-sm text-fg-muted">Sem etapas.</li>
                }
              </ol>
              <div class="mt-3">
                <app-button size="sm" variant="secondary" (click)="newStage()"
                  >Adicionar etapa</app-button
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
            <div class="flex flex-wrap gap-2">
              <app-button [loading]="busy()" (click)="save()">Guardar rascunho</app-button>
              <app-button variant="secondary" [loading]="busy()" (click)="check()"
                >Verificar com o servidor</app-button
              >
              @if (canPublish()) {
                <app-button variant="secondary" [loading]="busy()" (click)="publishEditing()"
                  >Publicar</app-button
                >
              }
              <app-button variant="secondary" (click)="closeEditor()">Fechar</app-button>
            </div>
            @if (verified()) {
              <app-alert tone="success" data-testid="verified"
                >O servidor aceita este workflow: pode ser publicado.</app-alert
              >
            }
          </div>

          <div class="xl:sticky xl:top-4 xl:self-start">
            <app-card title="Fluxo">
              <ol class="space-y-3 text-sm" data-testid="flow">
                <li class="text-fg-muted">Submissão do registo (congela os valores e a versão)</li>
                @for (stage of graph().stages; track $index; let i = $index) {
                  <li>
                    <strong>{{ i + 1 }}. {{ stage.label || 'Etapa sem nome' }}</strong>
                    <span class="block text-fg-muted">{{ summary(stage) }}</span>
                  </li>
                }
                <li class="text-fg-muted">
                  Aprovado: o evento sai por outbox, sem alterar o registo
                </li>
              </ol>
              @if (problems().length > 0) {
                <ul
                  class="mt-3 list-disc ps-4 text-sm text-amber-700 dark:text-amber-300"
                  data-testid="problems"
                >
                  @for (problem of problems(); track $index) {
                    <li>{{ problem }}</li>
                  }
                </ul>
              }
            </app-card>
          </div>
        </div>
      }
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada ou ainda não publicada" />
    }
  `,
})
export class EntityWorkflowsPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly api = inject(WorkflowsApi);
  private readonly iam = inject(IamApi);

  protected readonly Math = Math;

  /** Parâmetro de rota `:entityKey`. */
  readonly entityKey = input.required<string>();

  protected readonly entity = computed(() => this.registry.find(this.entityKey()));
  private readonly entityCode = computed(() => entityCodeOf(this.entityKey()));
  protected readonly canManage = computed(() =>
    this.permissions.can('configuration.workflows.manage'),
  );
  protected readonly canPublish = computed(() =>
    this.permissions.can('configuration.workflows.publish'),
  );

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Workflow' },
    { key: 'summary', label: 'Conteúdo' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly criteriaOptions = CRITERIA;
  protected readonly approverTypes = APPROVER_TYPES;

  protected readonly workflows = rxResource({
    params: () => (this.entity() ? this.entityCode() : undefined),
    stream: ({ params }) => this.api.list(params),
  });
  protected readonly loadError = computed(() => errorMessage(this.workflows.error()));
  private readonly all = computed(() => (this.workflows.hasValue() ? this.workflows.value() : []));

  /** Membros e papéis para escolher responsáveis; sem permissão para os listar, a lista fica vazia. */
  private readonly members = rxResource({
    stream: () => this.iam.listMembers().pipe(catchError(() => of([] as readonly MemberDto[]))),
  });
  private readonly roles = rxResource({
    stream: () => this.iam.listRoles().pipe(catchError(() => of([] as readonly RoleDto[]))),
  });

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  private readonly fields = computed(() =>
    (this.entity()?.fields ?? []).filter((f) => !f.archived && f.sensitivity !== 'sensitive'),
  );
  protected readonly amountOptions = computed<readonly SelectOption[]>(() =>
    this.fields()
      .filter((f) => f.type === 'decimal')
      .map((f) => ({ value: fieldCodeOf(f.key), label: f.label })),
  );
  protected readonly currencyOptions = computed<readonly SelectOption[]>(() =>
    this.fields()
      .filter((f) => f.type === 'text' || f.type === 'select')
      .map((f) => ({ value: fieldCodeOf(f.key), label: f.label })),
  );
  /** Campos que a condição de uma etapa pode ler. */
  protected readonly conditionFields = computed<readonly GuardField[]>(() =>
    this.fields().flatMap((f) => {
      const kind = ruleValueKind(f);
      return kind ? [{ code: fieldCodeOf(f.key), label: f.label, kind }] : [];
    }),
  );

  // ------------------------------------------------------------------- editor
  protected readonly editing = signal<Editing | null>(null);
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly description = signal('');
  protected readonly graph = signal<GraphDto>({ stages: [] });
  protected readonly issues = signal<readonly { path: string; message: string }[]>([]);
  protected readonly clientError = signal<string | null>(null);
  protected readonly verified = signal(false);
  protected readonly problems = computed(() => localProblems(this.graph()));

  protected readonly pickType = signal<ApproverType>('MEMBERSHIP');
  protected readonly pickId = signal('');
  protected readonly pickOptions = computed<readonly SelectOption[]>(() =>
    this.pickType() === 'ROLE'
      ? (this.roles.value() ?? []).map((r) => ({ value: r.id, label: r.name }))
      : (this.members.value() ?? [])
          .filter((m) => m.status === 'ACTIVE')
          .map((m) => ({ value: m.id, label: m.displayName ?? m.email ?? m.id })),
  );

  protected statusOf(workflow: WorkflowDto) {
    return STATUS[workflow.status];
  }

  protected summary(stage: StageDto): string {
    return describeStage(stage);
  }

  protected approverName(type: ApproverType, id: string): string {
    if (type === 'ROLE') return this.roles.value()?.find((r) => r.id === id)?.name ?? 'Papel';
    const member = this.members.value()?.find((m) => m.id === id);
    return member?.displayName ?? member?.email ?? `Membro ${id.slice(0, 8)}`;
  }

  protected asInteger(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : Number(value);
    return value === null || value === '' || !Number.isInteger(n) ? undefined : n;
  }

  protected isLatest(workflow: WorkflowDto): boolean {
    return !this.all().some((w) => w.code === workflow.code && w.revision > workflow.revision);
  }

  private touch(): void {
    this.verified.set(false);
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
    this.issues.set([]);
    this.verified.set(false);
  }

  protected startNew(): void {
    this.clearMessages();
    this.name.set('');
    this.code.set('');
    this.description.set('');
    this.graph.set(addStage({ stages: [] }));
    this.editing.set({ id: null, version: 0 });
  }

  protected edit(workflow: WorkflowDto): void {
    this.clearMessages();
    this.name.set(workflow.name);
    this.code.set(workflow.code);
    this.description.set(workflow.description ?? '');
    this.graph.set(workflow.graph);
    this.editing.set({ id: workflow.id, version: workflow.version });
  }

  protected closeEditor(): void {
    this.editing.set(null);
    this.workflows.reload();
  }

  // ------------------------------------------------------------------ etapas
  protected patchGraph(patch: Partial<GraphDto>): void {
    this.graph.update((g) => {
      const next = { ...g, ...patch } as Record<string, unknown>;
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return next as unknown as GraphDto;
    });
    this.touch();
  }

  protected newStage(): void {
    this.graph.update(addStage);
    this.touch();
  }

  protected patchStage(index: number, patch: Partial<StageDto>): void {
    this.graph.update((g) => updateStage(g, index, patch));
    this.touch();
  }

  /** Uma etapa com código gerado acompanha o nome; um código escolhido à mão não se mexe. */
  protected relabel(index: number, label: string): void {
    const current = this.graph().stages[index];
    if (!current) return;
    const generated = current.code === slug(current.label) || AUTO_CODE.test(current.code);
    const suggestion = slug(label);
    const taken = this.graph()
      .stages.filter((_, i) => i !== index)
      .map((s) => s.code);
    this.patchStage(index, {
      label,
      code: generated && suggestion ? nextCode(suggestion, taken) : current.code,
    });
  }

  protected changeCriteria(index: number, value: string | null): void {
    const criteria = (['ALL', 'ANY', 'QUORUM'] as const).find((c) => c === value) as Criteria;
    this.graph.update((g) => setCriteria(g, index, criteria ?? 'ALL'));
    this.touch();
  }

  protected shift(index: number, direction: -1 | 1): void {
    this.graph.update((g) => moveStage(g, index, direction));
    this.touch();
  }

  protected dropStage(index: number): void {
    this.graph.update((g) => removeStage(g, index));
    this.touch();
  }

  protected appendApprover(index: number): void {
    if (this.pickId() === '') return;
    this.graph.update((g) => addApprover(g, index, { type: this.pickType(), id: this.pickId() }));
    this.pickId.set('');
    this.touch();
  }

  protected dropApprover(index: number, approverIndex: number): void {
    this.graph.update((g) => removeApprover(g, index, approverIndex));
    this.touch();
  }

  // ---------------------------------------------------------------- servidor
  private body(): WorkflowBody | null {
    this.clientError.set(null);
    if (!this.name().trim()) {
      this.clientError.set('Indique o nome do workflow.');
      return null;
    }
    return {
      name: this.name().trim(),
      description: this.description().trim() || null,
      graph: this.graph(),
    };
  }

  private fail(error: ApiError): void {
    const details = error.fieldErrors ?? [];
    if (details.length > 0)
      this.issues.set(details.map((d) => ({ path: d.path, message: d.message })));
    else this.actionError.set(error.message);
  }

  private saveDraft(then: (saved: WorkflowDto) => void): void {
    const body = this.body();
    const state = this.editing();
    if (!body || !state) return;
    this.issues.set([]);
    this.verified.set(false);
    this.busy.set(true);
    const call = state.id
      ? this.api.update(state.id, state.version, body)
      : this.api.create(this.entityCode(), this.code().trim(), body);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: (saved) => {
        this.editing.set({ id: saved.id, version: saved.version });
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

  protected check(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.saveDraft((saved) => {
      this.busy.set(true);
      this.api
        .preview(saved.id)
        .pipe(finalize(() => this.busy.set(false)))
        .subscribe({
          next: (result) => {
            this.issues.set(result.issues.map((i) => ({ path: i.path, message: i.message })));
            this.verified.set(result.publishable);
          },
          error: (error: ApiError) => this.fail(error),
        });
    });
  }

  protected publishEditing(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.saveDraft((saved) => {
      this.busy.set(true);
      this.api
        .publish(saved.id, saved.version)
        .pipe(finalize(() => this.busy.set(false)))
        .subscribe({
          next: () => {
            this.editing.set(null);
            this.notice.set('Workflow publicado.');
            this.workflows.reload();
          },
          error: (error: ApiError) => this.fail(error),
        });
    });
  }

  // ------------------------------------------------------------ ciclo de vida
  protected publishFromList(workflow: WorkflowDto): void {
    this.run(this.api.publish(workflow.id, workflow.version), 'Workflow publicado.');
  }

  protected retire(workflow: WorkflowDto): void {
    this.run(this.api.retire(workflow.id, workflow.version), 'Workflow retirado.');
  }

  protected revise(workflow: WorkflowDto): void {
    this.clearMessages();
    this.busy.set(true);
    this.api
      .createRevision(workflow.id)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (draft) => {
          this.workflows.reload();
          this.edit(draft);
        },
        error: (error: ApiError) => this.actionError.set(error.message),
      });
  }

  private run(call: ReturnType<WorkflowsApi['publish']>, done: string): void {
    this.clearMessages();
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.notice.set(done);
        this.workflows.reload();
      },
      error: (error: ApiError) => {
        const details = error.fieldErrors ?? [];
        this.actionError.set(
          details.length > 0
            ? `${error.message} ${details.map((d) => d.message).join(' ')}`
            : error.message,
        );
      },
    });
  }
}
