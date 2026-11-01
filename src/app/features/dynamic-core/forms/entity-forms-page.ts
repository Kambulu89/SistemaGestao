import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import type { FormDto, FormSectionDto } from '../../../core/dynamic/http/dynamic-dto';
import { entityCodeOf, fieldCodeOf, formFromDto } from '../../../core/dynamic/http/dynamic-mapper';
import type { FieldDefinition } from '../../../core/dynamic/models/field-definition.model';
import type { FormMode } from '../../../core/dynamic/models/form-definition.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { DynamicFormRenderer } from '../../../shared/dynamic/dynamic-form-renderer';
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
import { FormConditionEditor, type ConditionField } from './form-condition-editor';
import type { ConditionKind } from './form-condition';
import {
  addItem,
  addSection,
  moveItem,
  moveSection,
  removeItem,
  removeSection,
  unassignedFields,
  updateItem,
  updateSection,
  type ItemRef,
  type Sections,
} from './form-layout';
import { FormsApi, type FormBody } from './forms.api';

const MODES: readonly { value: FormMode; label: string }[] = [
  { value: 'create', label: 'Criação' },
  { value: 'edit', label: 'Edição' },
  { value: 'read', label: 'Consulta' },
];

const STATUS: Record<
  FormDto['status'],
  { label: string; tone: 'success' | 'neutral' | 'warning' }
> = {
  DRAFT: { label: 'Rascunho', tone: 'warning' },
  PUBLISHED: { label: 'Publicado', tone: 'success' },
  RETIRED: { label: 'Retirado', tone: 'neutral' },
};

const COLUMN_OPTIONS: readonly SelectOption[] = [
  { value: '1', label: '1 coluna' },
  { value: '2', label: '2 colunas' },
  { value: '3', label: '3 colunas' },
];

/** Tipos de campo cujo valor uma condição de apresentação sabe comparar. */
function conditionKind(field: FieldDefinition): ConditionKind | null {
  switch (field.type) {
    case 'number':
    case 'decimal':
    case 'formula':
      return 'number';
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

interface Editing {
  /** `null` num formulário novo (ainda sem revisão no servidor). */
  readonly id: string | null;
  readonly version: number;
  readonly revision: number;
}

/**
 * Form Builder (C11): organiza os campos de uma entidade em secções, com ajuda, largura e condições de
 * apresentação. O formulário só refere campos por código; o servidor verifica-o contra a entidade ao publicar e
 * os registos continuam a escrever-se na entidade, com a sua validação e autorização.
 */
@Component({
  selector: 'app-entity-forms-page',
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
    DynamicFormRenderer,
    FormConditionEditor,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      <app-page-header
        [title]="'Formulários de ' + entity.names.plural"
        description="Organizam a criação, a edição e a consulta dos registos. Não alteram os dados nem as regras da entidade."
      >
        <div pageActions class="flex flex-wrap items-center gap-3">
          <a routerLink=".." class="text-sm text-brand-700 hover:underline dark:text-brand-300"
            >Definição da entidade</a
          >
          @if (canManage() && !editing()) {
            <app-button (click)="startNew()">Novo formulário</app-button>
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
          @if (forms.isLoading() && !forms.hasValue()) {
            <app-loading-state label="A carregar formulários…" />
          } @else if (forms.error()) {
            <div class="p-5">
              <app-alert tone="danger" title="Não foi possível carregar os formulários">{{
                loadError()
              }}</app-alert>
            </div>
          } @else if (forms.value(); as list) {
            @if (list.length === 0) {
              <app-empty-state icon="cube" title="Esta entidade ainda não tem formulários" />
            } @else {
              <app-table caption="Formulários da entidade" [columns]="columns" [rows]="list">
                <ng-template let-row let-column="column">
                  @switch (column.key) {
                    @case ('name') {
                      <span class="font-medium">{{ row.name }}</span>
                      <span class="block text-xs text-fg-muted"
                        >{{ row.code }} · revisão {{ row.revision }}</span
                      >
                    }
                    @case ('modes') {
                      {{ modesOf(row) }}{{ row.isDefault ? ' · por omissão' : '' }}
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
          Um formulário publicado não se altera: abre-se uma nova revisão, que substitui a anterior
          ao ser publicada. Sem formulário publicado, a entidade usa o formulário gerado a partir
          dos campos.
        </p>
      } @else {
        <div class="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div class="space-y-4">
            <app-card [title]="editing()!.id ? 'Editar rascunho' : 'Novo formulário'">
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
              <fieldset class="mt-3">
                <legend class="mb-1 text-sm font-medium">Onde se usa</legend>
                <div class="flex flex-wrap gap-4">
                  @for (mode of modeOptions; track mode.value) {
                    <app-checkbox
                      [label]="mode.label"
                      [ngModel]="modes().includes(mode.value)"
                      (ngModelChange)="toggleMode(mode.value, $event === true)"
                    />
                  }
                  <app-checkbox
                    label="Formulário por omissão"
                    [ngModel]="isDefault()"
                    (ngModelChange)="isDefault.set($event === true)"
                  />
                </div>
              </fieldset>
            </app-card>

            @for (section of sections(); track section.key; let s = $index) {
              <app-card>
                <div class="flex flex-wrap items-end gap-3" [attr.data-testid]="'section-' + s">
                  <div class="min-w-48 flex-1">
                    <app-input
                      label="Título da secção"
                      [ngModel]="section.title"
                      (ngModelChange)="patchSection(s, { title: $event ?? '' })"
                    />
                  </div>
                  <div class="w-36">
                    <app-select
                      label="Colunas"
                      [ngModel]="'' + section.columns"
                      (ngModelChange)="patchSection(s, { columns: +($event ?? 2) })"
                      [options]="columnOptions"
                    />
                  </div>
                  <div class="flex gap-1">
                    <app-button size="sm" variant="secondary" (click)="moveSectionBy(s, -1)"
                      >Subir</app-button
                    >
                    <app-button size="sm" variant="secondary" (click)="moveSectionBy(s, 1)"
                      >Descer</app-button
                    >
                    <app-button size="sm" variant="secondary" (click)="dropSection(s)"
                      >Remover secção</app-button
                    >
                  </div>
                </div>
                <div class="mt-3">
                  <app-form-condition-editor
                    label="Mostrar a secção quando"
                    [testId]="'section-condition-' + s"
                    [condition]="section.visibleWhen"
                    [fields]="conditionFields()"
                    (changed)="patchSection(s, { visibleWhen: $event })"
                  />
                </div>

                <ul
                  class="mt-3 min-h-10 space-y-2 rounded-lg border border-dashed border-line p-2"
                  [attr.aria-label]="'Campos de ' + section.title"
                  (dragover)="allowDrop($event)"
                  (drop)="dropOnSection($event, s)"
                >
                  @for (item of section.items; track item.field; let i = $index) {
                    <li
                      draggable="true"
                      class="rounded-lg border border-line bg-surface p-2"
                      [attr.data-testid]="'item-' + s + '-' + i"
                      (dragstart)="dragStart({ section: s, item: i })"
                      (dragover)="allowDrop($event)"
                      (drop)="dropOnItem($event, s, i)"
                    >
                      <div class="flex flex-wrap items-center gap-2">
                        <span aria-hidden="true" class="cursor-grab text-fg-muted">⠿</span>
                        <span class="font-medium">{{ labelOf(item.field) }}</span>
                        <span class="text-xs text-fg-muted">{{ item.field }}</span>
                        @if (item.visible === false) {
                          <app-badge tone="neutral">Escondido</app-badge>
                        }
                        @if (item.editable === false) {
                          <app-badge tone="neutral">Só leitura</app-badge>
                        }
                        @if (item.required) {
                          <app-badge tone="warning">Obrigatório</app-badge>
                        }
                        @if (item.visibleWhen || item.editableWhen || item.requiredWhen) {
                          <app-badge tone="brand">Condições</app-badge>
                        }
                        <span class="ms-auto flex gap-1">
                          <app-button size="sm" variant="secondary" (click)="moveItemBy(s, i, -1)"
                            >Subir</app-button
                          >
                          <app-button size="sm" variant="secondary" (click)="moveItemBy(s, i, 1)"
                            >Descer</app-button
                          >
                          <app-button size="sm" variant="secondary" (click)="toggleItem(s, i)">{{
                            isSelected(s, i) ? 'Fechar' : 'Configurar'
                          }}</app-button>
                          <app-button size="sm" variant="secondary" (click)="dropItem(s, i)"
                            >Remover</app-button
                          >
                        </span>
                      </div>
                      @if (isSelected(s, i)) {
                        <div class="mt-3 space-y-3 border-t border-line pt-3">
                          <div class="grid gap-3 sm:grid-cols-2">
                            <app-input
                              label="Rótulo neste formulário"
                              [ngModel]="item.label ?? ''"
                              (ngModelChange)="patchItem(s, i, { label: $event || undefined })"
                            />
                            <app-input
                              label="Texto de ajuda"
                              [ngModel]="item.help ?? ''"
                              (ngModelChange)="patchItem(s, i, { help: $event || undefined })"
                            />
                            <app-input
                              label="Texto de exemplo"
                              [ngModel]="item.placeholder ?? ''"
                              (ngModelChange)="
                                patchItem(s, i, { placeholder: $event || undefined })
                              "
                            />
                            <app-select
                              label="Largura"
                              placeholder="1 coluna"
                              [ngModel]="item.span ? '' + item.span : null"
                              (ngModelChange)="
                                patchItem(s, i, { span: $event ? +$event : undefined })
                              "
                              [options]="spanOptions(section.columns)"
                            />
                          </div>
                          <div class="flex flex-wrap gap-4">
                            <app-checkbox
                              label="Escondido neste formulário"
                              [ngModel]="item.visible === false"
                              (ngModelChange)="
                                patchItem(s, i, { visible: $event === true ? false : undefined })
                              "
                            />
                            <app-checkbox
                              label="Só de leitura neste formulário"
                              [ngModel]="item.editable === false"
                              (ngModelChange)="
                                patchItem(s, i, { editable: $event === true ? false : undefined })
                              "
                            />
                            <app-checkbox
                              label="Obrigatório neste formulário"
                              [ngModel]="item.required === true"
                              (ngModelChange)="
                                patchItem(s, i, { required: $event === true ? true : undefined })
                              "
                            />
                          </div>
                          <app-form-condition-editor
                            label="Mostrar quando"
                            [testId]="'visible-when-' + s + '-' + i"
                            [condition]="item.visibleWhen"
                            [fields]="conditionFields()"
                            (changed)="patchItem(s, i, { visibleWhen: $event })"
                          />
                          <app-form-condition-editor
                            label="Editável quando"
                            [testId]="'editable-when-' + s + '-' + i"
                            [condition]="item.editableWhen"
                            [fields]="conditionFields()"
                            (changed)="patchItem(s, i, { editableWhen: $event })"
                          />
                          <app-form-condition-editor
                            label="Obrigatório quando"
                            [testId]="'required-when-' + s + '-' + i"
                            [condition]="item.requiredWhen"
                            [fields]="conditionFields()"
                            (changed)="patchItem(s, i, { requiredWhen: $event })"
                          />
                        </div>
                      }
                    </li>
                  } @empty {
                    <li class="px-2 py-1 text-sm text-fg-muted">
                      Sem campos: adicione ou arraste um campo para aqui.
                    </li>
                  }
                </ul>
                <div class="mt-3 flex items-end gap-2">
                  <div class="w-64">
                    <app-select
                      label="Adicionar campo"
                      placeholder="Escolha um campo…"
                      [ngModel]="pending()[s] ?? null"
                      (ngModelChange)="setPending(s, $event)"
                      [options]="freeFieldOptions()"
                    />
                  </div>
                  <app-button size="sm" variant="secondary" (click)="attach(s)"
                    >Adicionar à secção</app-button
                  >
                </div>
              </app-card>
            }

            <div class="flex flex-wrap items-center gap-3">
              <app-button variant="secondary" (click)="newSection()">Adicionar secção</app-button>
              @if (freeFields().length > 0) {
                <span class="text-sm text-fg-muted" data-testid="free-fields"
                  >Sem secção: {{ freeLabels() }}</span
                >
              }
            </div>

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
                >O servidor aceita este formulário: pode ser publicado.</app-alert
              >
            }
          </div>

          <div class="space-y-3 xl:sticky xl:top-4 xl:self-start">
            <app-card title="Pré-visualização">
              <div class="mb-3 flex flex-wrap items-end gap-3">
                <div class="w-44">
                  <app-select
                    label="Modo"
                    [ngModel]="previewMode()"
                    (ngModelChange)="previewMode.set(asMode($event))"
                    [options]="modeSelect"
                  />
                </div>
                <app-checkbox
                  label="Largura de telemóvel"
                  [ngModel]="narrow()"
                  (ngModelChange)="narrow.set($event === true)"
                />
              </div>
              <div [class]="narrow() ? 'mx-auto max-w-sm' : ''" data-testid="preview">
                <app-dynamic-form
                  [entity]="previewEntity()"
                  [mode]="previewMode()"
                  [showActions]="false"
                  [access]="fieldAccess"
                />
              </div>
            </app-card>
          </div>
        </div>
      }
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada ou ainda não publicada" />
    }
  `,
})
export class EntityFormsPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly access = inject(EntityAccessService);
  private readonly tenant = inject(TenantContextService).tenant;
  private readonly api = inject(FormsApi);

  /** Parâmetro de rota `:entityKey`. */
  readonly entityKey = input.required<string>();

  protected readonly fieldAccess = this.access.fieldAccess;
  protected readonly entity = computed(() => this.registry.find(this.entityKey()));
  private readonly entityCode = computed(() => entityCodeOf(this.entityKey()));
  protected readonly canManage = computed(() =>
    this.permissions.can('configuration.form-layouts.manage'),
  );
  protected readonly canPublish = computed(() =>
    this.permissions.can('configuration.form-layouts.publish'),
  );

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Formulário' },
    { key: 'modes', label: 'Modos' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly modeOptions = MODES;
  protected readonly modeSelect: readonly SelectOption[] = MODES;
  protected readonly columnOptions = COLUMN_OPTIONS;

  protected readonly forms = rxResource({
    params: () => (this.entity() ? this.entityCode() : undefined),
    stream: ({ params }) => this.api.list(params),
  });
  protected readonly loadError = computed(() => errorMessage(this.forms.error()));
  private readonly all = computed(() => (this.forms.hasValue() ? this.forms.value() : []));

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  // ---------------------------------------------------------- campos da entidade
  /** Todos os campos activos, por código (a ordem da entidade). */
  private readonly fieldList = computed(() =>
    (this.entity()?.fields ?? [])
      .filter((f) => !f.archived)
      .map((f) => ({ code: fieldCodeOf(f.key), label: f.label, field: f })),
  );
  private readonly labels = computed(() => new Map(this.fieldList().map((f) => [f.code, f.label])));
  protected readonly conditionFields = computed<readonly ConditionField[]>(() =>
    this.fieldList().flatMap((f) => {
      const kind = conditionKind(f.field);
      return kind && f.field.sensitivity !== 'sensitive'
        ? [{ code: f.code, label: f.label, kind }]
        : [];
    }),
  );
  protected labelOf(code: string): string {
    return this.labels().get(code) ?? code;
  }

  // ------------------------------------------------------------------- editor
  protected readonly editing = signal<Editing | null>(null);
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly description = signal('');
  protected readonly modes = signal<readonly FormMode[]>(['create', 'edit', 'read']);
  protected readonly isDefault = signal(false);
  protected readonly sections = signal<Sections>([]);
  protected readonly selected = signal<ItemRef | null>(null);
  protected readonly pending = signal<Readonly<Record<number, string | null>>>({});
  protected readonly issues = signal<readonly { path: string; message: string }[]>([]);
  protected readonly clientError = signal<string | null>(null);
  protected readonly verified = signal(false);
  protected readonly previewMode = signal<FormMode>('create');
  protected readonly narrow = signal(false);

  protected readonly freeFields = computed(() =>
    unassignedFields(
      this.sections(),
      this.fieldList().map((f) => f.code),
    ),
  );
  protected readonly freeFieldOptions = computed<readonly SelectOption[]>(() =>
    this.freeFields().map((code) => ({ value: code, label: this.labelOf(code) })),
  );
  protected readonly freeLabels = computed(() =>
    this.freeFields()
      .map((c) => this.labelOf(c))
      .join(', '),
  );

  /** A entidade com o formulário em edição como único formulário (o que a pré-visualização desenha). */
  protected readonly previewEntity = computed(() => {
    const entity = this.entity();
    if (!entity) throw new Error('Sem entidade.');
    const tenantId = this.tenant()?.id ?? '';
    const form = formFromDto(tenantId, {
      id: 'preview',
      entityCode: this.entityCode(),
      code: this.code() || 'preview',
      name: this.name() || 'Pré-visualização',
      description: null,
      revision: 1,
      version: 1,
      status: 'PUBLISHED',
      modes: ['create', 'edit', 'read'],
      isDefault: true,
      sections: this.sections(),
      publishedAt: null,
      issues: [],
    });
    return { ...entity, forms: [form] };
  });

  protected statusOf(form: FormDto) {
    return STATUS[form.status];
  }

  protected modesOf(form: FormDto): string {
    return MODES.filter((m) => form.modes.includes(m.value))
      .map((m) => m.label)
      .join(', ');
  }

  protected isLatest(form: FormDto): boolean {
    return !this.all().some((f) => f.code === form.code && f.revision > form.revision);
  }

  protected asMode(value: string | null): FormMode {
    return MODES.find((m) => m.value === value)?.value ?? 'create';
  }

  protected toggleMode(mode: FormMode, on: boolean): void {
    this.modes.update((list) =>
      MODES.map((m) => m.value).filter((m) => (m === mode ? on : list.includes(m))),
    );
  }

  protected spanOptions(columns: number): readonly SelectOption[] {
    return COLUMN_OPTIONS.slice(0, columns).map((o) => ({
      value: o.value,
      label: o.value === '1' ? '1 coluna' : `${o.value} colunas`,
    }));
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
    this.modes.set(['create', 'edit', 'read']);
    this.isDefault.set(false);
    this.sections.set([{ key: 'dados', title: 'Dados', columns: 2, items: [] }]);
    this.selected.set(null);
    this.pending.set({});
    this.editing.set({ id: null, version: 0, revision: 1 });
  }

  protected edit(form: FormDto): void {
    this.clearMessages();
    this.name.set(form.name);
    this.code.set(form.code);
    this.description.set(form.description ?? '');
    this.modes.set([...form.modes]);
    this.isDefault.set(form.isDefault);
    this.sections.set(form.sections);
    this.selected.set(null);
    this.pending.set({});
    this.editing.set({ id: form.id, version: form.version, revision: form.revision });
  }

  protected closeEditor(): void {
    this.editing.set(null);
    this.forms.reload();
  }

  // ------------------------------------------------------------- secções e itens
  protected newSection(): void {
    this.sections.update(addSection);
  }

  protected patchSection(index: number, patch: Partial<Omit<FormSectionDto, 'items'>>): void {
    this.sections.update((s) => updateSection(s, index, patch));
    this.verified.set(false);
  }

  protected moveSectionBy(index: number, delta: -1 | 1): void {
    this.sections.update((s) => moveSection(s, index, delta));
    this.selected.set(null);
  }

  protected dropSection(index: number): void {
    this.sections.update((s) => removeSection(s, index));
    this.selected.set(null);
  }

  protected setPending(section: number, value: string | null): void {
    this.pending.update((p) => ({ ...p, [section]: value }));
  }

  protected attach(section: number): void {
    const field = this.pending()[section];
    if (!field) return;
    this.sections.update((s) => addItem(s, section, field));
    this.setPending(section, null);
    this.verified.set(false);
  }

  protected isSelected(section: number, item: number): boolean {
    const current = this.selected();
    return current?.section === section && current.item === item;
  }

  protected toggleItem(section: number, item: number): void {
    this.selected.set(this.isSelected(section, item) ? null : { section, item });
  }

  protected patchItem(
    section: number,
    item: number,
    patch: Parameters<typeof updateItem>[2],
  ): void {
    this.sections.update((s) => updateItem(s, { section, item }, patch));
    this.verified.set(false);
  }

  protected dropItem(section: number, item: number): void {
    this.sections.update((s) => removeItem(s, { section, item }));
    this.selected.set(null);
    this.verified.set(false);
  }

  protected moveItemBy(section: number, item: number, delta: -1 | 1): void {
    const count = this.sections()[section]?.items.length ?? 0;
    const target = item + delta;
    if (target < 0 || target >= count) return;
    // Mover para a posição seguinte significa inserir depois do vizinho.
    this.sections.update((s) =>
      moveItem(s, { section, item }, { section, item: delta === 1 ? target + 1 : target }),
    );
    this.selected.set(null);
    this.verified.set(false);
  }

  // ------------------------------------------------------------ arrastar e largar
  private dragged: ItemRef | null = null;

  protected dragStart(ref: ItemRef): void {
    this.dragged = ref;
  }

  protected allowDrop(event: Event): void {
    if (this.dragged) event.preventDefault();
  }

  protected dropOnItem(event: Event, section: number, item: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.dropAt({ section, item });
  }

  protected dropOnSection(event: Event, section: number): void {
    event.preventDefault();
    this.dropAt({ section, item: this.sections()[section]?.items.length ?? 0 });
  }

  private dropAt(to: ItemRef): void {
    const from = this.dragged;
    this.dragged = null;
    if (!from) return;
    this.sections.update((s) => moveItem(s, from, to));
    this.selected.set(null);
    this.verified.set(false);
  }

  // ---------------------------------------------------------------- servidor
  private body(): FormBody | null {
    this.clientError.set(null);
    if (!this.name().trim()) {
      this.clientError.set('Indique o nome do formulário.');
      return null;
    }
    if (this.modes().length === 0) {
      this.clientError.set('Escolha pelo menos um modo.');
      return null;
    }
    return {
      name: this.name().trim(),
      description: this.description().trim() || null,
      modes: this.modes(),
      isDefault: this.isDefault(),
      sections: this.sections(),
    };
  }

  private fail(error: ApiError): void {
    const details = error.fieldErrors ?? [];
    if (details.length > 0)
      this.issues.set(details.map((d) => ({ path: d.path, message: d.message })));
    else this.actionError.set(this.describe(error));
  }

  private describe(error: ApiError): string {
    switch (error.code) {
      case 'FORM_CODE_TAKEN':
        return 'Já existe um formulário com esse código: abra uma nova revisão.';
      case 'FORM_DRAFT_EXISTS':
        return 'Já existe um rascunho deste formulário.';
      case 'FORM_NOT_DRAFT':
        return 'Só um rascunho se altera ou publica.';
      case 'FORM_DEFAULT_TAKEN':
        return error.message;
      default:
        return error.message;
    }
  }

  /** Guarda o rascunho (cria o formulário ou actualiza a revisão) e devolve-o. */
  private saveDraft(then: (saved: FormDto) => void): void {
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
        this.editing.set({ id: saved.id, version: saved.version, revision: saved.revision });
        then(saved);
      },
      error: (error: ApiError) => this.fail(error),
    });
  }

  protected save(): void {
    this.clearMessagesKeepEditing();
    this.saveDraft(() => this.notice.set('Rascunho guardado.'));
  }

  protected check(): void {
    this.clearMessagesKeepEditing();
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
    this.clearMessagesKeepEditing();
    this.saveDraft((saved) => {
      this.busy.set(true);
      this.api
        .publish(saved.id, saved.version)
        .pipe(finalize(() => this.busy.set(false)))
        .subscribe({
          next: () => {
            this.editing.set(null);
            this.notice.set('Formulário publicado.');
            this.forms.reload();
          },
          error: (error: ApiError) => this.fail(error),
        });
    });
  }

  private clearMessagesKeepEditing(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }

  // ------------------------------------------------------------ ciclo de vida
  protected publishFromList(form: FormDto): void {
    this.run(this.api.publish(form.id, form.version), 'Formulário publicado.');
  }

  protected retire(form: FormDto): void {
    this.run(this.api.retire(form.id, form.version), 'Formulário retirado.');
  }

  protected revise(form: FormDto): void {
    this.clearMessages();
    this.busy.set(true);
    this.api
      .createRevision(form.id)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (draft) => {
          this.forms.reload();
          this.edit(draft);
        },
        error: (error: ApiError) => this.actionError.set(this.describe(error)),
      });
  }

  private run(call: ReturnType<FormsApi['publish']>, done: string): void {
    this.clearMessages();
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.notice.set(done);
        this.forms.reload();
      },
      error: (error: ApiError) => {
        const details = error.fieldErrors ?? [];
        this.actionError.set(
          details.length > 0
            ? `${error.message} ${details.map((d) => d.message).join(' ')}`
            : this.describe(error),
        );
      },
    });
  }
}
