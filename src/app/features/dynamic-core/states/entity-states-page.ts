import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
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
import { ruleValueKind } from '../rules/value-kind';
import {
  addState,
  addTransition,
  nextCode,
  reachable,
  removeState,
  removeTransition,
  setInitial,
  slug,
  toggleFrom,
  updateState,
  updateTransition,
  type Machine,
} from './state-machine-model';
import { StateGuardEditor, type GuardField } from './state-guard-editor';
import {
  StatesApi,
  type MachineBody,
  type MachineDto,
  type StateCategory,
  type StateDto,
  type TransitionDto,
} from './states.api';

const STATUS: Record<
  MachineDto['status'],
  { label: string; tone: 'success' | 'neutral' | 'warning' }
> = {
  DRAFT: { label: 'Rascunho', tone: 'warning' },
  PUBLISHED: { label: 'Publicada', tone: 'success' },
  RETIRED: { label: 'Retirada', tone: 'neutral' },
};

const CATEGORY_LABEL: Record<StateCategory, string> = {
  INITIAL: 'Inicial',
  ACTIVE: 'Activo',
  FINAL: 'Final',
  CANCELLED: 'Cancelado',
};
const CATEGORIES: readonly SelectOption[] = (
  ['ACTIVE', 'FINAL', 'CANCELLED', 'INITIAL'] as const
).map((value) => ({ value, label: CATEGORY_LABEL[value] }));

const COLORS: readonly SelectOption[] = [
  { value: 'neutral', label: 'Neutro' },
  { value: 'brand', label: 'Destaque' },
  { value: 'success', label: 'Sucesso' },
  { value: 'warning', label: 'Atenção' },
  { value: 'danger', label: 'Perigo' },
];

const AUTO_CODE = /^(estado|transicao)(_\d+)?$/;

interface Editing {
  /** `null` numa máquina nova (ainda sem revisão no servidor). */
  readonly id: string | null;
  readonly version: number;
}

/**
 * Designer de máquinas de estados (C13): estados com categoria e edição, transições com origens, destino, permissão,
 * guarda e motivo, e um mapa que mostra o que cada estado alcança. O servidor verifica a máquina (um estado inicial,
 * estados alcançáveis, guardas contra a entidade) antes de a publicar; uma máquina publicada nunca se altera.
 */
@Component({
  selector: 'app-entity-states-page',
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
        [title]="'Estados de ' + entity.names.plural"
        description="Definem as acções legais de cada registo. Mudar de estado nunca se faz por edição directa."
      >
        <div pageActions class="flex flex-wrap items-center gap-3">
          <a routerLink=".." class="text-sm text-brand-700 hover:underline dark:text-brand-300"
            >Definição da entidade</a
          >
          @if (canManage() && !editing()) {
            <app-button (click)="startNew()">Nova máquina</app-button>
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
          @if (machines.isLoading() && !machines.hasValue()) {
            <app-loading-state label="A carregar máquinas…" />
          } @else if (machines.error()) {
            <div class="p-5">
              <app-alert tone="danger" title="Não foi possível carregar as máquinas">{{
                loadError()
              }}</app-alert>
            </div>
          } @else if (machines.value(); as list) {
            @if (list.length === 0) {
              <app-empty-state icon="cube" title="Esta entidade ainda não tem máquina de estados" />
            } @else {
              <app-table caption="Máquinas de estados" [columns]="columns" [rows]="list">
                <ng-template let-row let-column="column">
                  @switch (column.key) {
                    @case ('name') {
                      <span class="font-medium">{{ row.name }}</span>
                      <span class="block text-xs text-fg-muted"
                        >{{ row.code }} · revisão {{ row.revision }}</span
                      >
                    }
                    @case ('summary') {
                      {{ row.states.length }} estados · {{ row.transitions.length }} transições
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
          Uma máquina publicada não se altera: abre-se uma nova revisão. Os registos criados antes
          de haver máquina ficam sem estado, e um estado em uso por registos não pode ser retirado.
        </p>
      } @else {
        <div class="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div class="space-y-4">
            <app-card [title]="editing()!.id ? 'Editar rascunho' : 'Nova máquina'">
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

            <app-card title="Estados">
              <ul class="space-y-3" data-testid="states">
                @for (state of machine().states; track $index; let i = $index) {
                  <li class="rounded-lg border border-line p-3" [attr.data-testid]="'state-' + i">
                    <div class="grid gap-3 sm:grid-cols-[1fr_1fr_10rem]">
                      <app-input
                        label="Rótulo"
                        [ngModel]="state.label"
                        (ngModelChange)="relabelState(i, $event ?? '')"
                      />
                      <app-input
                        label="Código"
                        [ngModel]="state.code"
                        (ngModelChange)="patchState(i, { code: $event ?? '' })"
                      />
                      <app-select
                        label="Categoria"
                        [ngModel]="state.category"
                        (ngModelChange)="changeCategory(i, $event)"
                        [options]="categoryOptions"
                      />
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-4">
                      <app-checkbox
                        label="Aceita alterações de valores"
                        [ngModel]="state.editable"
                        (ngModelChange)="patchState(i, { editable: $event === true })"
                      />
                      <div class="w-40">
                        <app-select
                          label="Cor"
                          placeholder="Por categoria"
                          [ngModel]="state.color ?? null"
                          (ngModelChange)="patchState(i, { color: $event || undefined })"
                          [options]="colorOptions"
                        />
                      </div>
                      <span class="ms-auto flex gap-2">
                        @if (state.category !== 'INITIAL') {
                          <app-button size="sm" variant="secondary" (click)="makeInitial(i)"
                            >Tornar inicial</app-button
                          >
                        }
                        <app-button size="sm" variant="secondary" (click)="dropState(i)"
                          >Remover</app-button
                        >
                      </span>
                    </div>
                  </li>
                }
              </ul>
              <div class="mt-3">
                <app-button size="sm" variant="secondary" (click)="newState()"
                  >Adicionar estado</app-button
                >
              </div>
            </app-card>

            <app-card title="Transições">
              <ul class="space-y-3" data-testid="transitions">
                @for (transition of machine().transitions; track $index; let i = $index) {
                  <li
                    class="rounded-lg border border-line p-3"
                    [attr.data-testid]="'transition-' + i"
                  >
                    <div class="grid gap-3 sm:grid-cols-3">
                      <app-input
                        label="Rótulo (o que o botão diz)"
                        [ngModel]="transition.label"
                        (ngModelChange)="relabelTransition(i, $event ?? '')"
                      />
                      <app-input
                        label="Código"
                        [ngModel]="transition.code"
                        (ngModelChange)="patchTransition(i, { code: $event ?? '' })"
                      />
                      <app-select
                        label="Passa a"
                        [ngModel]="transition.to"
                        (ngModelChange)="patchTransition(i, { to: $event ?? '' })"
                        [options]="stateOptions()"
                      />
                    </div>
                    <fieldset class="mt-2">
                      <legend class="mb-1 text-sm font-medium">A partir de</legend>
                      <div class="flex flex-wrap gap-4">
                        @for (option of stateOptions(); track option.value) {
                          <app-checkbox
                            [label]="option.label"
                            [ngModel]="transition.from.includes(option.value)"
                            (ngModelChange)="toggleOrigin(i, option.value, $event === true)"
                          />
                        }
                      </div>
                    </fieldset>
                    <div class="mt-2 grid gap-3 sm:grid-cols-2">
                      <app-input
                        label="Permissão adicional (opcional)"
                        hint="Código do catálogo, ex.: audit.read. Além de dynamic.transition."
                        [ngModel]="transition.permission ?? ''"
                        (ngModelChange)="
                          patchTransition(i, { permission: $event?.trim() || undefined })
                        "
                      />
                      <div class="self-end">
                        <app-checkbox
                          label="Exige um motivo"
                          [ngModel]="transition.reasonRequired"
                          (ngModelChange)="patchTransition(i, { reasonRequired: $event === true })"
                        />
                      </div>
                    </div>
                    <div class="mt-2">
                      <app-state-guard-editor
                        [testId]="'guard-' + i"
                        [guard]="transition.guard"
                        [fields]="guardFields()"
                        (changed)="patchTransition(i, { guard: $event })"
                      />
                    </div>
                    <div class="mt-2 flex justify-end">
                      <app-button size="sm" variant="secondary" (click)="dropTransition(i)"
                        >Remover transição</app-button
                      >
                    </div>
                  </li>
                } @empty {
                  <li class="text-sm text-fg-muted">
                    Sem transições: os registos ficam sempre no estado inicial.
                  </li>
                }
              </ul>
              <div class="mt-3">
                <app-button
                  size="sm"
                  variant="secondary"
                  [disabled]="machine().states.length === 0"
                  (click)="newTransition()"
                  >Adicionar transição</app-button
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
                >O servidor aceita esta máquina: pode ser publicada.</app-alert
              >
            }
          </div>

          <div class="xl:sticky xl:top-4 xl:self-start">
            <app-card title="Mapa de estados">
              <ul class="space-y-3 text-sm" data-testid="map">
                @for (state of machine().states; track $index) {
                  <li>
                    <div class="flex flex-wrap items-center gap-2">
                      <strong>{{ state.label }}</strong>
                      <app-badge [tone]="state.category === 'INITIAL' ? 'brand' : 'neutral'">{{
                        categoryLabel(state.category)
                      }}</app-badge>
                      @if (!reached().has(state.code)) {
                        <app-badge tone="danger">Inalcançável</app-badge>
                      }
                      @if (!state.editable) {
                        <app-badge tone="neutral">Só leitura</app-badge>
                      }
                    </div>
                    <ul class="ms-4 mt-1 list-disc text-fg-muted">
                      @for (out of outgoing(state.code); track out.code) {
                        <li>
                          {{ out.label }} → {{ labelOfState(out.to)
                          }}{{ out.guard !== undefined ? ' (com condição)' : '' }}
                        </li>
                      } @empty {
                        <li class="list-none">
                          {{
                            state.category === 'FINAL' || state.category === 'CANCELLED'
                              ? 'Fim do percurso.'
                              : 'Sem saídas.'
                          }}
                        </li>
                      }
                    </ul>
                  </li>
                }
              </ul>
            </app-card>
          </div>
        </div>
      }
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada ou ainda não publicada" />
    }
  `,
})
export class EntityStatesPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly api = inject(StatesApi);

  /** Parâmetro de rota `:entityKey`. */
  readonly entityKey = input.required<string>();

  protected readonly entity = computed(() => this.registry.find(this.entityKey()));
  private readonly entityCode = computed(() => entityCodeOf(this.entityKey()));
  protected readonly canManage = computed(() =>
    this.permissions.can('configuration.state-machines.manage'),
  );
  protected readonly canPublish = computed(() =>
    this.permissions.can('configuration.state-machines.publish'),
  );

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Máquina' },
    { key: 'summary', label: 'Conteúdo' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly categoryOptions = CATEGORIES;
  protected readonly colorOptions = COLORS;

  protected readonly machines = rxResource({
    params: () => (this.entity() ? this.entityCode() : undefined),
    stream: ({ params }) => this.api.list(params),
  });
  protected readonly loadError = computed(() => errorMessage(this.machines.error()));
  private readonly all = computed(() => (this.machines.hasValue() ? this.machines.value() : []));

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  /** Campos que uma guarda pode ler: activos, não sensíveis e de um tipo que o motor compara. */
  protected readonly guardFields = computed<readonly GuardField[]>(() =>
    (this.entity()?.fields ?? [])
      .filter((f) => !f.archived && f.sensitivity !== 'sensitive')
      .flatMap((f) => {
        const kind = ruleValueKind(f);
        return kind ? [{ code: fieldCodeOf(f.key), label: f.label, kind }] : [];
      }),
  );

  // ------------------------------------------------------------------- editor
  protected readonly editing = signal<Editing | null>(null);
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly description = signal('');
  protected readonly machine = signal<Machine>({ states: [], transitions: [] });
  protected readonly issues = signal<readonly { path: string; message: string }[]>([]);
  protected readonly clientError = signal<string | null>(null);
  protected readonly verified = signal(false);

  protected readonly stateOptions = computed<readonly SelectOption[]>(() =>
    this.machine().states.map((s) => ({ value: s.code, label: s.label })),
  );
  protected readonly reached = computed(() => reachable(this.machine()));

  protected statusOf(machine: MachineDto) {
    return STATUS[machine.status];
  }

  protected categoryLabel(category: StateCategory): string {
    return CATEGORY_LABEL[category];
  }

  protected labelOfState(code: string): string {
    return this.machine().states.find((s) => s.code === code)?.label ?? code;
  }

  protected outgoing(stateCode: string): readonly TransitionDto[] {
    return this.machine().transitions.filter((t) => t.from.includes(stateCode));
  }

  protected isLatest(machine: MachineDto): boolean {
    return !this.all().some((m) => m.code === machine.code && m.revision > machine.revision);
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
    this.machine.set(addState({ states: [], transitions: [] }));
    this.editing.set({ id: null, version: 0 });
  }

  protected edit(machine: MachineDto): void {
    this.clearMessages();
    this.name.set(machine.name);
    this.code.set(machine.code);
    this.description.set(machine.description ?? '');
    this.machine.set({ states: machine.states, transitions: machine.transitions });
    this.editing.set({ id: machine.id, version: machine.version });
  }

  protected closeEditor(): void {
    this.editing.set(null);
    this.machines.reload();
  }

  // -------------------------------------------------------------- estados
  protected newState(): void {
    this.machine.update(addState);
    this.touch();
  }

  protected patchState(index: number, patch: Partial<StateDto>): void {
    this.machine.update((m) => updateState(m, index, patch));
    this.touch();
  }

  /** Um estado com código gerado acompanha o rótulo; um código escolhido à mão não se mexe. */
  protected relabelState(index: number, label: string): void {
    const current = this.machine().states[index];
    if (!current) return;
    const generated = current.code === slug(current.label) || AUTO_CODE.test(current.code);
    const suggestion = slug(label);
    const taken = this.machine()
      .states.filter((_, i) => i !== index)
      .map((s) => s.code);
    const code = generated && suggestion ? nextCode(suggestion, taken) : current.code;
    this.patchState(index, { label, code });
  }

  protected changeCategory(index: number, value: string | null): void {
    if (value === 'INITIAL') this.makeInitial(index);
    else {
      const category =
        (['ACTIVE', 'FINAL', 'CANCELLED'] as const).find((c) => c === value) ?? 'ACTIVE';
      // Um estado final ou cancelado fecha o registo por omissão.
      this.patchState(index, { category, editable: category === 'ACTIVE' });
    }
  }

  protected makeInitial(index: number): void {
    this.machine.update((m) => setInitial(m, index));
    this.touch();
  }

  protected dropState(index: number): void {
    const { machine, affected } = removeState(this.machine(), index);
    this.machine.set(machine);
    this.notice.set(
      affected > 0
        ? `Estado removido; ${affected} transição(ões) foram ajustadas ou removidas.`
        : null,
    );
    this.touch();
  }

  // ------------------------------------------------------------ transições
  protected newTransition(): void {
    this.machine.update(addTransition);
    this.touch();
  }

  protected patchTransition(index: number, patch: Partial<TransitionDto>): void {
    this.machine.update((m) => updateTransition(m, index, patch));
    this.touch();
  }

  protected relabelTransition(index: number, label: string): void {
    const current = this.machine().transitions[index];
    if (!current) return;
    const generated = current.code === slug(current.label) || AUTO_CODE.test(current.code);
    const suggestion = slug(label);
    const taken = this.machine()
      .transitions.filter((_, i) => i !== index)
      .map((t) => t.code);
    this.patchTransition(index, {
      label,
      code: generated && suggestion ? nextCode(suggestion, taken) : current.code,
    });
  }

  protected toggleOrigin(index: number, state: string, on: boolean): void {
    this.machine.update((m) => toggleFrom(m, index, state, on));
    this.touch();
  }

  protected dropTransition(index: number): void {
    this.machine.update((m) => removeTransition(m, index));
    this.touch();
  }

  // ---------------------------------------------------------------- servidor
  private body(): MachineBody | null {
    this.clientError.set(null);
    if (!this.name().trim()) {
      this.clientError.set('Indique o nome da máquina.');
      return null;
    }
    return {
      name: this.name().trim(),
      description: this.description().trim() || null,
      states: this.machine().states,
      transitions: this.machine().transitions,
    };
  }

  private fail(error: ApiError): void {
    const details = error.fieldErrors ?? [];
    if (details.length > 0)
      this.issues.set(details.map((d) => ({ path: d.path, message: d.message })));
    else this.actionError.set(error.message);
  }

  private saveDraft(then: (saved: MachineDto) => void): void {
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
            this.notice.set('Máquina publicada.');
            this.machines.reload();
          },
          error: (error: ApiError) => this.fail(error),
        });
    });
  }

  // ------------------------------------------------------------ ciclo de vida
  protected publishFromList(machine: MachineDto): void {
    this.run(this.api.publish(machine.id, machine.version), 'Máquina publicada.');
  }

  protected retire(machine: MachineDto): void {
    this.run(this.api.retire(machine.id, machine.version), 'Máquina retirada.');
  }

  protected revise(machine: MachineDto): void {
    this.clearMessages();
    this.busy.set(true);
    this.api
      .createRevision(machine.id)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (draft) => {
          this.machines.reload();
          this.edit(draft);
        },
        error: (error: ApiError) => this.actionError.set(error.message),
      });
  }

  private run(call: ReturnType<StatesApi['publish']>, done: string): void {
    this.clearMessages();
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.notice.set(done);
        this.machines.reload();
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
