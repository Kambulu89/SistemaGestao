import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { entityCodeOf, fieldCodeOf } from '../../../core/dynamic/http/dynamic-mapper';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import type { FieldDefinition } from '../../../core/dynamic/models/field-definition.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import {
  buildCondition,
  CLAUSE_OPERATORS,
  literalOf,
  parseCondition,
  type ClauseOperator,
  type ValueKind,
} from './rule-condition';
import {
  RulesApi,
  type EvaluationDto,
  type RuleDto,
  type RuleStatus,
  type SimulationDto,
} from './rules.api';

const STATUS: Record<RuleStatus, { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
  DRAFT: { label: 'Rascunho', tone: 'warning' },
  PUBLISHED: { label: 'Publicada', tone: 'success' },
  DISABLED: { label: 'Desactivada', tone: 'neutral' },
};

const RESULT_LABEL: Record<SimulationDto['result'], string> = {
  PASS: 'A regra não bloqueia estes dados.',
  FAIL: 'A regra bloquearia a gravação.',
  SKIPPED: 'A regra não se aplica (fora do período de vigência).',
  ERROR: 'A condição não pôde ser avaliada (a gravação seria bloqueada).',
};

/** Tipos de campo que o motor de regras compara; os restantes não aparecem no construtor. */
function kindOf(field: FieldDefinition): ValueKind | null {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'decimal':
    case 'formula':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'url':
    case 'date':
    case 'datetime':
    case 'select':
    case 'radio':
      return 'text';
    default:
      return null;
  }
}

interface EditorState {
  readonly mode: 'create' | 'edit';
  readonly rule: RuleDto | null;
  /** Condição existente que o construtor não sabe representar: mostra-se, e só muda se for refeita. */
  readonly opaqueCondition: unknown | null;
}

/**
 * Regras de validação de uma entidade (C12). O servidor avalia-as ao gravar um registo e bloqueia com a
 * mensagem de negócio; aqui escrevem-se, simulam-se, publicam-se e consultam-se as avaliações recusadas.
 */
@Component({
  selector: 'app-entity-rules-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    DatePipe,
    PageHeader,
    Card,
    Table,
    Badge,
    Alert,
    Button,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      <app-page-header
        [title]="'Regras de ' + entity.names.plural"
        description="Bloqueiam a gravação de um registo quando a condição se verifica."
      >
        <div pageActions class="flex flex-wrap items-center gap-3">
          <a routerLink=".." class="text-sm text-brand-700 hover:underline dark:text-brand-300"
            >Definição da entidade</a
          >
          @if (canManage()) {
            <app-button (click)="openCreate()">Nova regra</app-button>
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

      <app-card [flush]="true">
        @if (rules.isLoading() && !rules.hasValue()) {
          <app-loading-state label="A carregar regras…" />
        } @else if (rules.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as regras">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (rules.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="cube" title="Esta entidade ainda não tem regras" />
          } @else {
            <app-table caption="Regras da entidade" [columns]="columns" [rows]="list">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                    <span class="block text-xs text-fg-muted"
                      >{{ row.code }} · revisão {{ row.revision }}</span
                    >
                  }
                  @case ('status') {
                    <app-badge [tone]="statusOf(row).tone">{{ statusOf(row).label }}</app-badge>
                  }
                  @case ('message') {
                    {{ row.actionAst.message }}
                  }
                  @case ('period') {
                    {{ periodOf(row) }}
                  }
                  @case ('actions') {
                    <span class="flex flex-wrap justify-end gap-2">
                      @if (canManage() && row.status === 'DRAFT') {
                        <app-button size="sm" variant="secondary" (click)="openEdit(row)"
                          >Editar</app-button
                        >
                        <app-button size="sm" (click)="publish(row)">Publicar</app-button>
                      }
                      @if (canManage() && row.status === 'PUBLISHED') {
                        <app-button size="sm" variant="secondary" (click)="disable(row)"
                          >Desactivar</app-button
                        >
                      }
                      @if (canManage() && row.status !== 'DRAFT' && isLatest(row)) {
                        <app-button size="sm" variant="secondary" (click)="revise(row)"
                          >Nova revisão</app-button
                        >
                      }
                      @if (canManage()) {
                        <app-button size="sm" variant="secondary" (click)="openSimulate(row)"
                          >Simular</app-button
                        >
                      }
                      <app-button size="sm" variant="secondary" (click)="openEvaluations(row)"
                        >Avaliações</app-button
                      >
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
        Uma regra publicada não se altera: abre-se uma nova revisão, que substitui a anterior ao ser
        publicada. Todas as regras em vigor são avaliadas e todas as mensagens são mostradas.
      </p>

      <app-dialog
        [open]="editor() !== null"
        [wide]="true"
        [title]="editor()?.mode === 'edit' ? 'Editar regra' : 'Nova regra'"
        (closed)="closeEditor()"
      >
        <form [formGroup]="form" (ngSubmit)="save()" novalidate class="space-y-3 text-fg">
          <div class="grid grid-cols-2 gap-3">
            <app-input
              label="Código"
              formControlName="code"
              [required]="true"
              hint="Minúsculas, números e _"
            />
            <app-input label="Nome" formControlName="name" [required]="true" />
          </div>

          <fieldset class="space-y-2 rounded-lg border border-line p-3">
            <legend class="px-1 text-sm font-medium">Bloquear quando…</legend>
            @if (editor()?.opaqueCondition; as opaque) {
              <app-alert tone="warning" title="Condição avançada">
                Esta condição é mais rica do que o construtor representa e mantém-se como está.
                Adicione condições abaixo para a substituir.
              </app-alert>
              <pre
                class="max-h-32 overflow-auto rounded bg-surface-muted p-2 text-xs"
                data-testid="opaque-condition"
                >{{ pretty(opaque) }}</pre>
            }
            @if (clauses.length > 1) {
              <app-select label="Ligar as condições com" formControlName="join" [options]="joins" />
            }
            @for (clause of clauses.controls; track $index; let i = $index) {
              <div [formGroup]="clause" class="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                <app-select
                  label="Campo"
                  formControlName="field"
                  [options]="fieldOptions()"
                  [required]="true"
                />
                <app-select
                  label="Condição"
                  formControlName="operator"
                  [options]="operators"
                  [required]="true"
                />
                @if (needsValue(clause.getRawValue().operator)) {
                  <app-input label="Valor" formControlName="value" [required]="true" />
                } @else {
                  <span></span>
                }
                <app-button
                  size="sm"
                  variant="secondary"
                  [label]="'Remover condição ' + (i + 1)"
                  (click)="removeClause(i)"
                  >Remover</app-button
                >
              </div>
            }
            <app-button size="sm" variant="secondary" (click)="addClause()"
              >Adicionar condição</app-button
            >
          </fieldset>

          <app-input
            label="Mensagem ao utilizador"
            formControlName="message"
            [required]="true"
            hint="Explica porque a gravação foi recusada."
          />
          <app-select
            label="Associar a um campo (opcional)"
            formControlName="messageField"
            placeholder="Ao registo"
            [options]="fieldOptions()"
          />
          <div class="grid grid-cols-3 gap-3">
            <app-input
              label="Prioridade"
              type="number"
              formControlName="priority"
              min="0"
              max="1000"
            />
            <app-input label="Em vigor desde" type="datetime-local" formControlName="from" />
            <app-input label="Até" type="datetime-local" formControlName="to" />
          </div>
          @if (formError(); as text) {
            <app-alert tone="danger">{{ text }}</app-alert>
          }
          <div class="flex justify-end gap-2 pt-2">
            <app-button variant="secondary" (click)="closeEditor()">Cancelar</app-button>
            <app-button type="submit" [loading]="busy()">Guardar rascunho</app-button>
          </div>
        </form>
      </app-dialog>

      <app-dialog
        [open]="simulating() !== null"
        [title]="'Simular ' + (simulating()?.name ?? '')"
        (closed)="closeSimulation()"
      >
        <form [formGroup]="simForm" (ngSubmit)="simulate()" novalidate class="space-y-3 text-fg">
          <p class="text-sm text-fg-muted">
            Indique valores de exemplo. Nada é gravado nem registado.
          </p>
          @for (field of simFields(); track field.code) {
            <app-input [label]="field.label" [formControlName]="field.code" />
          }
          @if (simulationError(); as text) {
            <app-alert tone="danger">{{ text }}</app-alert>
          }
          @if (simulation(); as sim) {
            <app-alert [tone]="sim.result === 'PASS' ? 'success' : 'warning'" title="Resultado">
              <span data-testid="simulation-result">{{ resultLabel(sim) }}</span>
              @if (sim.message) {
                <span class="block">«{{ sim.message }}»</span>
              }
              @if (sim.reason) {
                <span class="block">{{ sim.reason }}</span>
              }
            </app-alert>
          }
          <div class="flex justify-end gap-2 pt-2">
            <app-button variant="secondary" (click)="closeSimulation()">Fechar</app-button>
            <app-button type="submit" [loading]="busy()">Simular</app-button>
          </div>
        </form>
      </app-dialog>

      <app-dialog
        [open]="evaluating() !== null"
        [wide]="true"
        [title]="'Avaliações de ' + (evaluating()?.name ?? '')"
        (closed)="evaluating.set(null)"
      >
        <p class="mb-2 text-sm text-fg-muted">
          Só ficam registadas as avaliações que bloquearam ou falharam (as últimas 50).
        </p>
        @if (evaluationError(); as text) {
          <app-alert tone="danger">{{ text }}</app-alert>
        } @else if (evaluationRows().length === 0) {
          <p class="text-sm" data-testid="no-evaluations">Sem avaliações registadas.</p>
        } @else {
          <app-table
            caption="Avaliações registadas"
            [columns]="evaluationColumns"
            [rows]="evaluationRows()"
          >
            <ng-template let-row let-column="column">
              @if (column.key === 'createdAt') {
                {{ row.createdAt | date: 'short' }}
              } @else {
                {{ row[column.key] }}
              }
            </ng-template>
          </app-table>
        }
        <div class="mt-4 flex justify-end">
          <app-button variant="secondary" (click)="evaluating.set(null)">Fechar</app-button>
        </div>
      </app-dialog>
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada ou ainda não publicada" />
    }
  `,
})
export class EntityRulesPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly api = inject(RulesApi);
  private readonly fb = inject(NonNullableFormBuilder);

  /** Parâmetro de rota `:entityKey`. */
  readonly entityKey = input.required<string>();

  protected readonly entity = computed(() => this.registry.find(this.entityKey()));
  private readonly entityCode = computed(() => entityCodeOf(this.entityKey()));
  protected readonly canManage = computed(() => this.permissions.can('configuration.rules.manage'));

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Regra' },
    { key: 'message', label: 'Mensagem' },
    { key: 'priority', label: 'Prioridade' },
    { key: 'period', label: 'Vigência' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly evaluationColumns: readonly TableColumn[] = [
    { key: 'createdAt', label: 'Quando' },
    { key: 'result', label: 'Resultado' },
    { key: 'errorCode', label: 'Erro' },
    { key: 'durationMs', label: 'ms' },
  ];

  protected readonly rules = rxResource({
    params: () => (this.entity() ? this.entityCode() : undefined),
    stream: ({ params }) => this.api.list(params),
  });
  protected readonly loadError = computed(() => errorMessage(this.rules.error()));
  private readonly all = computed(() => (this.rules.hasValue() ? this.rules.value() : []));

  // Campos comparáveis: não sensíveis, não arquivados e de um tipo que o motor compara.
  private readonly comparable = computed(() =>
    (this.entity()?.fields ?? [])
      .filter((f) => !f.archived && f.sensitivity !== 'sensitive')
      .flatMap((f) => {
        const kind = kindOf(f);
        return kind ? [{ code: fieldCodeOf(f.key), label: f.label, kind }] : [];
      }),
  );
  protected readonly fieldOptions = computed<readonly SelectOption[]>(() =>
    this.comparable().map((f) => ({ value: f.code, label: f.label })),
  );
  private readonly kinds = computed(
    () => new Map(this.comparable().map((f) => [f.code, f.kind] as const)),
  );

  protected readonly operators: readonly SelectOption[] = CLAUSE_OPERATORS;
  protected readonly joins: readonly SelectOption[] = [
    { value: 'and', label: 'todas (e)' },
    { value: 'or', label: 'qualquer uma (ou)' },
  ];

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  // ----------------------------------------------------------------- editor
  protected readonly editor = signal<EditorState | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly form = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[a-z][a-z0-9_]{1,49}$/)]],
    name: ['', [Validators.required, Validators.maxLength(160)]],
    join: ['and'],
    clauses: this.fb.array([this.newClause()]),
    message: ['', [Validators.required, Validators.maxLength(240)]],
    messageField: [''],
    priority: [100, [Validators.min(0), Validators.max(1000)]],
    from: [''],
    to: [''],
  });

  protected get clauses() {
    return this.form.controls.clauses;
  }

  private newClause(field = '', operator: ClauseOperator = 'eq', value = '') {
    return this.fb.group({ field: [field], operator: [operator], value: [value] });
  }

  protected needsValue(operator: ClauseOperator): boolean {
    return operator !== 'filled' && operator !== 'empty';
  }

  protected addClause(): void {
    this.clauses.push(this.newClause());
  }

  protected removeClause(index: number): void {
    this.clauses.removeAt(index);
  }

  protected openCreate(): void {
    this.clearMessages();
    this.form.reset({ join: 'and', priority: 100 });
    this.form.controls.code.enable();
    this.clauses.clear();
    this.clauses.push(this.newClause());
    this.editor.set({ mode: 'create', rule: null, opaqueCondition: null });
  }

  protected openEdit(rule: RuleDto): void {
    this.clearMessages();
    const draft = parseCondition(rule.conditionAst);
    this.form.reset({
      code: rule.code,
      name: rule.name,
      join: draft?.join ?? 'and',
      message: rule.actionAst.message,
      messageField: rule.actionAst.field ?? '',
      priority: rule.priority,
      from: rule.effectiveFrom ?? '',
      to: rule.effectiveTo ?? '',
    });
    this.form.controls.code.disable();
    this.clauses.clear();
    for (const c of draft?.clauses ?? [])
      this.clauses.push(this.newClause(c.field, c.operator, c.value));
    this.editor.set({
      mode: 'edit',
      rule,
      opaqueCondition: draft ? null : rule.conditionAst,
    });
  }

  protected closeEditor(): void {
    this.editor.set(null);
    this.formError.set(null);
  }

  protected save(): void {
    const state = this.editor();
    if (!state) return;
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const draft = { join: (v.join === 'or' ? 'or' : 'and') as 'and' | 'or', clauses: v.clauses };
    let conditionAst: unknown;
    if (draft.clauses.length === 0 && state.opaqueCondition) {
      conditionAst = state.opaqueCondition;
    } else {
      const built = buildCondition(draft, (field) => this.kinds().get(field));
      if (!built.ok) {
        this.formError.set(built.message);
        return;
      }
      conditionAst = built.ast;
    }
    const body = {
      name: v.name.trim(),
      description: state.rule?.description ?? null,
      priority: v.priority,
      conditionAst,
      actionAst: {
        type: 'BLOCK' as const,
        message: v.message.trim(),
        ...(v.messageField ? { field: v.messageField } : {}),
      },
      effectiveFrom: v.from || null,
      effectiveTo: v.to || null,
    };
    this.busy.set(true);
    const call =
      state.mode === 'edit' && state.rule
        ? this.api.update(state.rule.id, state.rule.version, body)
        : this.api.create(this.entityCode(), v.code.trim(), body);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.closeEditor();
        this.notice.set('Rascunho guardado.');
        this.rules.reload();
      },
      error: (error: ApiError) => this.formError.set(this.describe(error)),
    });
  }

  // ------------------------------------------------------------ ciclo de vida
  protected publish(rule: RuleDto): void {
    this.run(this.api.publish(rule.id, rule.version), 'Regra publicada.');
  }

  protected disable(rule: RuleDto): void {
    this.run(this.api.disable(rule.id, rule.version), 'Regra desactivada.');
  }

  protected revise(rule: RuleDto): void {
    this.run(this.api.createRevision(rule.id), 'Nova revisão em rascunho.');
  }

  private run(call: ReturnType<RulesApi['publish']>, done: string): void {
    this.clearMessages();
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.notice.set(done);
        this.rules.reload();
      },
      error: (error: ApiError) => this.actionError.set(this.describe(error)),
    });
  }

  /** A revisão mais recente de cada código (só dela se abre uma nova). */
  protected isLatest(rule: RuleDto): boolean {
    return !this.all().some((r) => r.code === rule.code && r.revision > rule.revision);
  }

  protected statusOf(rule: RuleDto) {
    return STATUS[rule.status];
  }

  protected periodOf(rule: RuleDto): string {
    if (!rule.effectiveFrom && !rule.effectiveTo) return 'Sempre';
    const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-PT') : '…');
    return `${fmt(rule.effectiveFrom)} → ${fmt(rule.effectiveTo)}`;
  }

  protected pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  // --------------------------------------------------------------- simulação
  protected readonly simulating = signal<RuleDto | null>(null);
  protected readonly simulation = signal<SimulationDto | null>(null);
  protected readonly simulationError = signal<string | null>(null);
  protected readonly simFields = signal<
    readonly { code: string; label: string; kind: ValueKind }[]
  >([]);
  protected simForm = this.fb.group<Record<string, string>>({});

  protected openSimulate(rule: RuleDto): void {
    this.clearMessages();
    const used = new Set(variablesOf(rule.conditionAst));
    const fields = this.comparable().filter((f) => used.has(f.code));
    this.simFields.set(fields);
    this.simForm = this.fb.group(Object.fromEntries(fields.map((f) => [f.code, ''])));
    this.simulation.set(null);
    this.simulationError.set(null);
    this.simulating.set(rule);
  }

  protected closeSimulation(): void {
    this.simulating.set(null);
  }

  protected resultLabel(sim: SimulationDto): string {
    return RESULT_LABEL[sim.result];
  }

  protected simulate(): void {
    const rule = this.simulating();
    if (!rule) return;
    this.simulationError.set(null);
    const values: Record<string, unknown> = {};
    for (const field of this.simFields()) {
      const text = String(this.simForm.getRawValue()[field.code] ?? '').trim();
      if (text === '') continue;
      const literal = literalOf(text, field.kind);
      if (literal === undefined) {
        this.simulationError.set(`Valor inválido para «${field.label}».`);
        return;
      }
      values[field.code] = literal;
    }
    this.busy.set(true);
    this.api
      .simulate(rule.id, values)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (result) => this.simulation.set(result),
        error: (error: ApiError) => this.simulationError.set(this.describe(error)),
      });
  }

  // ---------------------------------------------------------------- avaliações
  protected readonly evaluating = signal<RuleDto | null>(null);
  protected readonly evaluationRows = signal<readonly EvaluationDto[]>([]);
  protected readonly evaluationError = signal<string | null>(null);

  protected openEvaluations(rule: RuleDto): void {
    this.clearMessages();
    this.evaluationRows.set([]);
    this.evaluationError.set(null);
    this.evaluating.set(rule);
    this.api.evaluations(rule.id).subscribe({
      next: (rows) => this.evaluationRows.set(rows),
      error: (error: ApiError) => this.evaluationError.set(this.describe(error)),
    });
  }

  // ------------------------------------------------------------------ erros
  private describe(error: ApiError): string {
    const detail = error.fieldErrors?.map((d) => d.message).join(' ');
    switch (error.code) {
      case 'RULE_CODE_TAKEN':
        return 'Já existe uma regra com esse código: abra uma nova revisão.';
      case 'RULE_DRAFT_EXISTS':
        return 'Já existe um rascunho desta regra.';
      case 'RULE_NOT_DRAFT':
        return 'Só um rascunho se altera ou publica.';
      default:
        return detail ? `${error.message} ${detail}` : error.message;
    }
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}

/** Códigos dos campos do registo que uma condição lê. */
function variablesOf(ast: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      const v = (node as { var?: unknown }).var;
      if (typeof v === 'string' && v.startsWith('resource.'))
        found.push(v.slice('resource.'.length));
      Object.values(node).forEach(walk);
    }
  };
  walk(ast);
  return found;
}
