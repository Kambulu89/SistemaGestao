import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { detailedErrorMessage, errorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge, type Tone } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import {
  IamApi,
  type FieldRuleDto,
  type PolicyDto,
  type PolicyEffect,
  type PolicyStatus,
} from '../data-access/iam.api';
import {
  buildPolicyCondition,
  describePolicyCondition,
  OPERATORS,
  parsePolicyCondition,
  ROOTS,
  VALUE_TYPES,
  type Clause,
  type Operator,
  type Root,
  type ValueType,
} from './policy-condition';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Política' },
  { key: 'target', label: 'Aplica-se a' },
  { key: 'effect', label: 'Efeito' },
  { key: 'condition', label: 'Quando' },
  { key: 'status', label: 'Estado' },
  { key: 'actions', label: '', align: 'end' },
];

const STATUS: Readonly<Record<PolicyStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  ACTIVE: { label: 'Activa', tone: 'success' },
  DISABLED: { label: 'Desactivada', tone: 'warning' },
};

const EFFECTS: readonly SelectOption[] = [
  { value: 'ALLOW', label: 'Permitir (só quando a condição se cumpre)' },
  { value: 'DENY', label: 'Negar (sempre que a condição se cumpre)' },
];

const MODES: readonly SelectOption[] = [
  { value: 'HIDDEN', label: 'Esconder o campo' },
  { value: 'READ_ONLY', label: 'Só leitura' },
];

const EMPTY_CLAUSE: Clause = {
  root: 'resource',
  path: '',
  operator: 'eq',
  type: 'text',
  value: '',
};

/**
 * Políticas de acesso (ABAC): restringem ou condicionam uma permissão que um perfil já concede. Qualquer «negar» que se
 * cumpra prevalece; um «permitir» exige que pelo menos uma se cumpra. A condição é declarativa — nunca código — e o
 * servidor verifica-a. Só as políticas **activas** produzem efeito; o simulador mostra o resultado antes de activar.
 */
@Component({
  selector: 'app-policies-manager',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }

    @if (!editing()) {
      @if (canManage()) {
        <div class="mb-3 flex justify-end">
          <app-button (click)="startNew()">Nova política</app-button>
        </div>
      }
      <app-card [flush]="true">
        @if (policies.isLoading() && !policies.hasValue()) {
          <app-loading-state label="A carregar políticas…" />
        } @else if (policies.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as políticas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (policies.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="shield" title="Ainda não há políticas de acesso" />
          } @else {
            <app-table
              caption="Políticas de acesso"
              [columns]="columns"
              [rows]="list"
              data-testid="policies"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                    <span class="block text-xs text-fg-muted">prioridade {{ row.priority }}</span>
                  }
                  @case ('target') {
                    <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs"
                      >{{ row.resource }}.{{ row.action }}</code
                    >
                    @if (row.fieldRules.length > 0) {
                      <span class="block text-xs text-fg-muted"
                        >{{ row.fieldRules.length }} regra(s) de campo</span
                      >
                    }
                  }
                  @case ('effect') {
                    <app-badge [tone]="row.effect === 'DENY' ? 'danger' : 'brand'">{{
                      row.effect === 'DENY' ? 'Negar' : 'Permitir'
                    }}</app-badge>
                  }
                  @case ('condition') {
                    <span class="text-xs">{{ describe(row.condition) }}</span>
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row.status).tone">{{
                      status(row.status).label
                    }}</app-badge>
                  }
                  @case ('actions') {
                    <span class="flex justify-end gap-2">
                      <app-button size="sm" variant="secondary" (click)="open(row)">{{
                        canManage() ? 'Editar' : 'Ver'
                      }}</app-button>
                      @if (canManage() && row.status !== 'ACTIVE') {
                        <app-button size="sm" [disabled]="busy()" (click)="setStatus(row, 'ACTIVE')"
                          >Activar</app-button
                        >
                      }
                      @if (canManage() && row.status === 'ACTIVE') {
                        <app-button
                          size="sm"
                          variant="secondary"
                          [disabled]="busy()"
                          (click)="setStatus(row, 'DISABLED')"
                          >Desactivar</app-button
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
    } @else {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">{{ editing()!.id ? name() : 'Nova política' }}</h2>
        @if (clientError(); as text) {
          <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
        }
        <div class="grid gap-4 sm:grid-cols-2">
          <app-input
            label="Nome"
            [required]="true"
            [disabled]="!canManage()"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <app-select
            label="Efeito"
            [options]="effects"
            [disabled]="!canManage()"
            [ngModel]="effect()"
            (ngModelChange)="effect.set($event === 'DENY' ? 'DENY' : 'ALLOW')"
          />
          <app-select
            label="Recurso"
            [required]="true"
            [options]="resourceOptions()"
            [disabled]="!canManage()"
            [ngModel]="resource()"
            (ngModelChange)="changeResource($event ?? '')"
          />
          <app-select
            label="Acção"
            [required]="true"
            [options]="actionOptions()"
            [disabled]="!canManage()"
            [ngModel]="action()"
            (ngModelChange)="action.set($event ?? '')"
          />
          <app-input
            label="Prioridade"
            type="number"
            hint="Mais alta primeiro (informativo: qualquer «negar» prevalece)."
            [disabled]="!canManage()"
            [ngModel]="priority()"
            (ngModelChange)="priority.set(asInt($event))"
          />
        </div>

        <h3 class="mb-2 mt-6 text-sm font-semibold">Condição</h3>
        @if (advanced()) {
          <p class="text-sm text-fg-muted" data-testid="advanced">
            Esta política tem uma condição avançada (aninhada ou com negações), que o construtor não
            edita:
            <code class="mt-1 block overflow-x-auto rounded bg-surface-muted p-2 text-xs">{{
              advancedJson()
            }}</code>
          </p>
          @if (canManage()) {
            <app-button class="mt-2" size="sm" variant="secondary" (click)="replaceAdvanced()"
              >Substituir por uma condição simples</app-button
            >
          }
        } @else {
          @if (clauses().length === 0) {
            <p class="text-sm text-fg-muted">Sem condição: aplica-se sempre.</p>
          }
          @if (clauses().length > 1) {
            <div class="mb-2 max-w-xs">
              <app-select
                label="Ligar as condições com"
                [options]="joinOptions"
                [disabled]="!canManage()"
                [ngModel]="join()"
                (ngModelChange)="join.set($event === 'or' ? 'or' : 'and')"
              />
            </div>
          }
          @for (clause of clauses(); track $index; let i = $index) {
            <div
              class="mb-2 grid items-end gap-2 sm:grid-cols-[9rem_1fr_12rem_7rem_1fr_auto]"
              data-testid="clause"
            >
              <app-select
                label="De onde"
                [options]="rootOptions"
                [disabled]="!canManage()"
                [ngModel]="clause.root"
                (ngModelChange)="patchClause(i, { root: asRoot($event) })"
              />
              <app-input
                label="Caminho"
                placeholder="unitId, amount…"
                [disabled]="!canManage()"
                [ngModel]="clause.path"
                (ngModelChange)="patchClause(i, { path: $event ?? '' })"
              />
              <app-select
                label="Compara"
                [options]="operatorOptions"
                [disabled]="!canManage()"
                [ngModel]="clause.operator"
                (ngModelChange)="patchClause(i, { operator: asOperator($event) })"
              />
              <app-select
                label="Tipo"
                [options]="typeOptions"
                [disabled]="!canManage()"
                [ngModel]="clause.type"
                (ngModelChange)="patchClause(i, { type: asType($event) })"
              />
              @if (clause.operator !== 'filled' && clause.operator !== 'empty') {
                <app-input
                  label="Valor"
                  [disabled]="!canManage()"
                  [ngModel]="clause.value"
                  (ngModelChange)="patchClause(i, { value: $event ?? '' })"
                />
              } @else {
                <span></span>
              }
              @if (canManage()) {
                <app-button size="sm" variant="secondary" (click)="removeClause(i)"
                  >Retirar</app-button
                >
              }
            </div>
          }
          @if (canManage()) {
            <app-button size="sm" variant="secondary" (click)="addClause()"
              >Acrescentar condição</app-button
            >
          }
        }

        <h3 class="mb-2 mt-6 text-sm font-semibold">Regras de campo</h3>
        <p class="mb-2 text-xs text-fg-muted">
          Quando a política permite, estes campos do recurso ficam escondidos ou só de leitura
          (prevalece a regra mais restritiva).
        </p>
        @for (rule of fieldRules(); track $index; let i = $index) {
          <div
            class="mb-2 grid items-end gap-2 sm:grid-cols-[1fr_14rem_auto]"
            data-testid="field-rule"
          >
            <app-input
              label="Campo"
              [disabled]="!canManage()"
              [ngModel]="rule.field"
              (ngModelChange)="patchRule(i, { field: $event ?? '' })"
            />
            <app-select
              label="Modo"
              [options]="modes"
              [disabled]="!canManage()"
              [ngModel]="rule.mode"
              (ngModelChange)="
                patchRule(i, { mode: $event === 'READ_ONLY' ? 'READ_ONLY' : 'HIDDEN' })
              "
            />
            @if (canManage()) {
              <app-button size="sm" variant="secondary" (click)="removeRule(i)">Retirar</app-button>
            }
          </div>
        }
        @if (canManage()) {
          <app-button size="sm" variant="secondary" (click)="addRule()"
            >Acrescentar regra de campo</app-button
          >
        }

        <div class="mt-6 flex gap-2">
          @if (canManage()) {
            <app-button [loading]="busy()" (click)="save()">Guardar como rascunho</app-button>
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
        <p class="mt-2 text-xs text-fg-muted">
          Uma política só produz efeito depois de activada (na lista). Experimente-a antes no
          simulador.
        </p>
      </app-card>
    }
  `,
})
export class PoliciesManager {
  private readonly api = inject(IamApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantContext = inject(TenantContextService);

  protected readonly columns = COLUMNS;
  protected readonly effects = EFFECTS;
  protected readonly modes = MODES;
  protected readonly rootOptions: readonly SelectOption[] = ROOTS;
  protected readonly operatorOptions: readonly SelectOption[] = OPERATORS;
  protected readonly typeOptions: readonly SelectOption[] = VALUE_TYPES;
  protected readonly joinOptions: readonly SelectOption[] = [
    { value: 'and', label: 'e (todas)' },
    { value: 'or', label: 'ou (qualquer)' },
  ];
  protected readonly canManage = computed(() => this.permissions.can('iam.manage'));

  private readonly reload = signal(0);
  protected readonly policies = rxResource({
    params: () => ({ tenant: this.tenantContext.tenant()?.id, reload: this.reload() }),
    stream: () => this.api.policies(),
  });
  protected readonly loadError = computed(() => errorMessage(this.policies.error()));

  private readonly catalog = rxResource({
    params: () => this.tenantContext.tenant()?.id,
    stream: () => this.api.permissions(),
  });
  private readonly pairs = computed(() =>
    (this.catalog.hasValue() ? this.catalog.value() : []).map((p) => {
      const [resource = '', action = ''] = p.code.split('.');
      return { resource, action };
    }),
  );
  protected readonly resourceOptions = computed<readonly SelectOption[]>(() => [
    { value: '*', label: 'Todos os recursos (*)' },
    ...[...new Set(this.pairs().map((p) => p.resource))]
      .sort()
      .map((value) => ({ value, label: value })),
  ]);
  protected readonly actionOptions = computed<readonly SelectOption[]>(() => [
    { value: '*', label: 'Todas as acções (*)' },
    ...[
      ...new Set(
        this.pairs()
          .filter((p) => this.resource() === '*' || p.resource === this.resource())
          .map((p) => p.action),
      ),
    ]
      .sort()
      .map((value) => ({ value, label: value })),
  ]);

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly editing = signal<{ id: string | null; version: number } | null>(null);
  protected readonly name = signal('');
  protected readonly effect = signal<PolicyEffect>('ALLOW');
  protected readonly resource = signal('');
  protected readonly action = signal('');
  protected readonly priority = signal<number | null>(0);
  protected readonly join = signal<'and' | 'or'>('and');
  protected readonly clauses = signal<readonly Clause[]>([]);
  /** Condição que o construtor não representa: mantém-se tal como o servidor a guarda. */
  protected readonly advancedCondition = signal<unknown>(null);
  protected readonly advanced = computed(() => this.advancedCondition() !== null);
  protected readonly advancedJson = computed(() => JSON.stringify(this.advancedCondition()));
  protected readonly fieldRules = signal<
    readonly { field: string; mode: 'HIDDEN' | 'READ_ONLY' }[]
  >([]);
  /** Regras de campo com condição própria (`when`): o editor não as altera, mas não as perde. */
  private keptRules: readonly FieldRuleDto[] = [];

  protected status(status: PolicyStatus) {
    return STATUS[status];
  }

  protected describe(condition: unknown): string {
    return describePolicyCondition(condition);
  }

  protected asInt(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    return value === null || value === '' || !Number.isInteger(n) ? null : n;
  }

  protected asRoot(value: string | null): Root {
    return value === 'subject' || value === 'env' ? value : 'resource';
  }

  protected asOperator(value: string | null): Operator {
    return (OPERATORS.find((o) => o.value === value)?.value ?? 'eq') as Operator;
  }

  protected asType(value: string | null): ValueType {
    return value === 'number' || value === 'boolean' ? value : 'text';
  }

  private reset(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: done,
      error: (error: unknown) => this.actionError.set(detailedErrorMessage(error)),
    });
  }

  protected startNew(): void {
    this.reset();
    this.name.set('');
    this.effect.set('DENY');
    this.resource.set('');
    this.action.set('');
    this.priority.set(0);
    this.join.set('and');
    this.clauses.set([]);
    this.advancedCondition.set(null);
    this.fieldRules.set([]);
    this.keptRules = [];
    this.editing.set({ id: null, version: 0 });
  }

  protected open(policy: PolicyDto): void {
    this.reset();
    this.name.set(policy.name);
    this.effect.set(policy.effect);
    this.resource.set(policy.resource);
    this.action.set(policy.action);
    this.priority.set(policy.priority);
    const draft =
      policy.condition === null
        ? { join: 'and' as const, clauses: [] }
        : parsePolicyCondition(policy.condition);
    if (draft) {
      this.join.set(draft.join);
      this.clauses.set(draft.clauses);
      this.advancedCondition.set(null);
    } else {
      this.join.set('and');
      this.clauses.set([]);
      this.advancedCondition.set(policy.condition);
    }
    this.fieldRules.set(
      policy.fieldRules
        .filter((r) => r.when === undefined)
        .map((r) => ({ field: r.field, mode: r.mode })),
    );
    this.keptRules = policy.fieldRules.filter((r) => r.when !== undefined);
    this.editing.set({ id: policy.id, version: policy.version });
  }

  protected close(): void {
    this.editing.set(null);
    this.reload.update((n) => n + 1);
  }

  protected changeResource(value: string): void {
    this.resource.set(value);
    this.action.set('');
  }

  protected addClause(): void {
    this.clauses.update((list) => [...list, EMPTY_CLAUSE]);
  }

  protected removeClause(index: number): void {
    this.clauses.update((list) => list.filter((_, i) => i !== index));
  }

  protected patchClause(index: number, patch: Partial<Clause>): void {
    this.clauses.update((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  protected replaceAdvanced(): void {
    this.advancedCondition.set(null);
    this.clauses.set([EMPTY_CLAUSE]);
  }

  protected addRule(): void {
    this.fieldRules.update((list) => [...list, { field: '', mode: 'HIDDEN' }]);
  }

  protected removeRule(index: number): void {
    this.fieldRules.update((list) => list.filter((_, i) => i !== index));
  }

  protected patchRule(
    index: number,
    patch: Partial<{ field: string; mode: 'HIDDEN' | 'READ_ONLY' }>,
  ): void {
    this.fieldRules.update((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  /** A condição a enviar: a avançada tal como está, a construída, ou `null` (sempre). */
  private conditionToSend(): { ok: true; value: unknown } | { ok: false; message: string } {
    if (this.advanced()) return { ok: true, value: this.advancedCondition() };
    if (this.clauses().length === 0) return { ok: true, value: null };
    const built = buildPolicyCondition({ join: this.join(), clauses: this.clauses() });
    return built.ok ? { ok: true, value: built.ast } : built;
  }

  protected save(): void {
    const state = this.editing();
    if (!state) return;
    this.reset();
    if (!this.name().trim()) return void this.clientError.set('O nome é obrigatório.');
    if (!this.resource() || !this.action()) {
      return void this.clientError.set('Escolha o recurso e a acção a que a política se aplica.');
    }
    const priority = this.priority();
    if (priority === null) return void this.clientError.set('A prioridade é um número inteiro.');
    const condition = this.conditionToSend();
    if (!condition.ok) return void this.clientError.set(condition.message);
    const rules = this.fieldRules();
    if (rules.some((r) => !r.field.trim())) {
      return void this.clientError.set('Cada regra de campo precisa do nome do campo.');
    }
    const body = {
      name: this.name().trim(),
      resource: this.resource(),
      action: this.action(),
      effect: this.effect(),
      condition: condition.value,
      priority,
      fieldRules: [
        ...rules.map((r) => ({ field: r.field.trim(), mode: r.mode })),
        ...this.keptRules,
      ],
    };
    if (state.id) {
      this.run(this.api.updatePolicy(state.id, state.version, body), (saved) => {
        this.editing.set({ id: saved.id, version: saved.version });
        this.notice.set('Política guardada.');
      });
    } else {
      this.run(this.api.createPolicy({ ...body, status: 'DRAFT' }), (saved) => {
        this.editing.set({ id: saved.id, version: saved.version });
        this.notice.set('Política criada em rascunho. Active-a na lista quando estiver pronta.');
      });
    }
  }

  protected setStatus(policy: PolicyDto, status: PolicyStatus): void {
    this.reset();
    this.run(this.api.updatePolicy(policy.id, policy.version, { status }), () => {
      this.notice.set(status === 'ACTIVE' ? 'Política activada.' : 'Política desactivada.');
      this.reload.update((n) => n + 1);
    });
  }
}
