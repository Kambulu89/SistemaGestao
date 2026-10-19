import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { startWith } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { CustomFieldRegistryService } from '../../../core/dynamic/custom-field-registry.service';
import type { DefinitionFailure } from '../../../core/dynamic/data-access/custom-field.gateway';
import { validateCustomFieldDefinition } from '../../../core/dynamic/engine/custom-fields';
import type { DefinitionIssue } from '../../../core/dynamic/engine/definition-integrity';
import {
  buildField,
  codeFromName,
  EMPTY_DRAFT,
  draftOf,
  type FieldDraft,
} from '../../../core/dynamic/engine/field-draft';
import { FIELD_TYPE_CATALOG, fieldCapabilities } from '../../../core/dynamic/engine/field-types';
import {
  type CustomFieldDefinition,
  entityRefOf,
} from '../../../core/dynamic/models/custom-definition.model';
import type { EntityDefinition } from '../../../core/dynamic/models/entity-definition.model';
import type { FieldType, FieldValue } from '../../../core/dynamic/models/field-definition.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { DynamicField } from '../../../shared/dynamic/dynamic-field';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Input } from '../../../shared/ui/input/input';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Textarea } from '../../../shared/ui/textarea/textarea';

const READY_TYPES: readonly SelectOption[] = FIELD_TYPE_CATALOG.filter(
  (t) => t.status === 'ready',
).map((t) => ({ value: t.type, label: t.label }));

const PREVIEW_TYPES = FIELD_TYPE_CATALOG.filter((t) => t.status === 'preview');

const optionGroup = (value = '', label = '', active = true) =>
  new FormGroup({
    value: new FormControl(value, { nonNullable: true }),
    label: new FormControl(label, { nonNullable: true }),
    active: new FormControl(active, { nonNullable: true }),
  });

/**
 * Designer de um campo personalizado. É reutilizável: recebe a entidade (a definição nativa) e,
 * opcionalmente, o campo a editar; a configuração adapta-se ao tipo escolhido e a pré-visualização
 * usa o mesmo `DynamicField` dos formulários reais. Guardar passa sempre pelo servidor.
 */
@Component({
  selector: 'app-custom-field-designer',
  imports: [
    ReactiveFormsModule,
    Input,
    Textarea,
    Select,
    Checkbox,
    Button,
    Alert,
    Badge,
    Card,
    DynamicField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <form [formGroup]="form" (ngSubmit)="save('active')" class="grid gap-6 lg:grid-cols-3">
      <div class="space-y-6 lg:col-span-2">
        <app-card title="Identificação">
          <div class="grid gap-4 sm:grid-cols-2">
            <app-input formControlName="name" label="Nome" [required]="true" />
            <app-input
              formControlName="code"
              label="Código"
              hint="Identificador técnico estável (camelCase). Não muda depois de publicado."
              [required]="true"
              (input)="codeTouched.set(true)"
            />
            <app-select
              formControlName="type"
              label="Tipo de campo"
              [required]="true"
              [options]="typeOptions()"
            />
            <app-input formControlName="placeholder" label="Texto de ajuda no campo" />
          </div>
          <div class="mt-4">
            <app-textarea formControlName="description" label="Descrição" [rows]="2" />
          </div>
          @if (locked()) {
            <p class="mt-3 text-sm text-fg-muted">
              Campo publicado: o código e o tipo já não se alteram.
            </p>
          }
          <div class="mt-3 text-sm text-fg-muted" data-testid="preview-types">
            <p class="mb-1">Tipos avançados ainda em preparação (não podem ser criados):</p>
            <div class="flex flex-wrap gap-1.5">
              @for (t of previewTypes; track t.type) {
                <app-badge [title]="t.description">{{ t.label }}</app-badge>
              }
            </div>
          </div>
        </app-card>

        @if (kind().options) {
          <app-card title="Opções">
            <p class="mb-3 text-sm text-fg-muted">
              O valor é estável e fica gravado nos registos; só a etiqueta se pode mudar. Uma opção
              já usada desactiva-se em vez de se apagar.
            </p>
            <div class="space-y-2" formArrayName="options" data-testid="options-editor">
              @for (row of options.controls; track row; let i = $index) {
                <div
                  class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
                  [formGroupName]="i"
                >
                  <app-input formControlName="value" label="Valor" />
                  <app-input formControlName="label" label="Etiqueta" />
                  <app-checkbox formControlName="active" label="Activa" />
                  <app-button variant="ghost" size="sm" (click)="removeOption(i)"
                    >Remover</app-button
                  >
                </div>
              }
            </div>
            <app-button class="mt-3" variant="secondary" size="sm" (click)="addOption()"
              >Adicionar opção</app-button
            >
          </app-card>
        }

        @if (hasTypeSettings()) {
          <app-card title="Definições do tipo">
            <div class="grid gap-4 sm:grid-cols-2">
              @if (type() === 'currency') {
                <app-input
                  formControlName="currency"
                  label="Moeda (ISO 4217)"
                  hint="Ex.: EUR, AOA"
                />
              }
              @if (type() === 'decimal' || type() === 'currency') {
                <app-input
                  formControlName="scale"
                  type="number"
                  label="Casas decimais"
                  hint="Sem aritmética de vírgula flutuante: o valor respeita esta precisão."
                />
              }
              @if (isNumeric()) {
                <app-input formControlName="min" type="number" label="Valor mínimo" />
                <app-input formControlName="max" type="number" label="Valor máximo" />
              }
              @if (isText()) {
                <app-input formControlName="minLength" type="number" label="Comprimento mínimo" />
                <app-input formControlName="maxLength" type="number" label="Comprimento máximo" />
              }
              @if (isFile()) {
                <app-input
                  formControlName="accept"
                  label="Tipos MIME aceites"
                  hint="Separados por vírgula, ex.: application/pdf, image/*"
                />
                <app-input formControlName="maxSizeMb" type="number" label="Tamanho máximo (MB)" />
                <app-checkbox formControlName="multiple" label="Permitir vários ficheiros" />
              }
            </div>
          </app-card>
        }

        <app-card title="Regras e listagem">
          <div class="grid gap-3 sm:grid-cols-2">
            @if (kind().required) {
              <app-checkbox formControlName="required" label="Obrigatório" />
            }
            @if (kind().unique) {
              <app-checkbox
                formControlName="unique"
                label="Único por tenant"
                hint="Verificado no servidor."
              />
            }
            @if (kind().searchable) {
              <app-checkbox formControlName="searchable" label="Entra na pesquisa" />
            }
            @if (kind().filterable) {
              <app-checkbox formControlName="filterable" label="Disponível como filtro" />
            }
            @if (kind().sortable) {
              <app-checkbox formControlName="sortable" label="Ordenável" />
            }
            @if (kind().listable) {
              <app-checkbox formControlName="showInList" label="Mostrar como coluna da listagem" />
            }
            <app-checkbox
              formControlName="sensitive"
              label="Dado sensível"
              hint="Exige permissões próprias de leitura e escrita; sem elas o valor nunca é devolvido."
            />
          </div>
        </app-card>
      </div>

      <div class="space-y-6">
        <app-card title="Pré-visualização">
          @for (field of [previewField()]; track field?.type) {
            @if (field) {
              <app-dynamic-field
                [field]="field"
                [control]="previewControl"
                [state]="{ visible: true, editable: true, required: field.required }"
              />
            } @else {
              <p class="text-sm text-fg-muted">Indique o nome para ver o campo.</p>
            }
          }
        </app-card>

        @if (issues().length > 0) {
          <app-alert tone="danger" title="Corrija antes de guardar">
            <ul class="list-disc ps-4" data-testid="designer-issues">
              @for (issue of issues(); track $index) {
                <li>{{ issue.message }}</li>
              }
            </ul>
          </app-alert>
        }
        @if (error(); as message) {
          <app-alert tone="danger" title="Não foi possível guardar">{{ message }}</app-alert>
        }

        <div class="flex flex-wrap gap-2">
          @if (!canManage()) {
            <p class="text-sm text-fg-muted">Não tem permissão para gerir campos personalizados.</p>
          } @else {
            <app-button type="submit" [loading]="saving()" [disabled]="issues().length > 0">{{
              published() ? 'Guardar alterações' : 'Publicar campo'
            }}</app-button>
            @if (!published()) {
              <app-button
                variant="secondary"
                [disabled]="saving() || issues().length > 0"
                (click)="save('draft')"
                >Guardar rascunho</app-button
              >
            }
          }
          <app-button variant="ghost" (click)="cancelled.emit()">Cancelar</app-button>
        </div>
      </div>
    </form>
  `,
})
export class CustomFieldDesigner {
  private readonly registry = inject(CustomFieldRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  /** A definição nativa (sem campos personalizados) da entidade que se está a estender. */
  readonly entity = input.required<EntityDefinition>();
  /** O campo a editar; sem valor, cria-se um novo. */
  readonly definition = input<CustomFieldDefinition | null>(null);

  readonly saved = output<CustomFieldDefinition>();
  readonly cancelled = output<void>();

  protected readonly previewTypes = PREVIEW_TYPES;
  protected readonly codeTouched = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly serverIssues = signal<readonly DefinitionIssue[]>([]);
  protected readonly previewControl = new FormControl<FieldValue>(null);

  protected readonly form = new FormGroup({
    type: new FormControl<FieldType>('text', { nonNullable: true }),
    name: new FormControl('', { nonNullable: true }),
    code: new FormControl('', { nonNullable: true }),
    description: new FormControl('', { nonNullable: true }),
    placeholder: new FormControl('', { nonNullable: true }),
    required: new FormControl(false, { nonNullable: true }),
    searchable: new FormControl(false, { nonNullable: true }),
    filterable: new FormControl(false, { nonNullable: true }),
    sortable: new FormControl(false, { nonNullable: true }),
    unique: new FormControl(false, { nonNullable: true }),
    sensitive: new FormControl(false, { nonNullable: true }),
    showInList: new FormControl(false, { nonNullable: true }),
    options: new FormArray<ReturnType<typeof optionGroup>>([]),
    scale: new FormControl<number | null>(null),
    currency: new FormControl('EUR', { nonNullable: true }),
    min: new FormControl<number | null>(null),
    max: new FormControl<number | null>(null),
    minLength: new FormControl<number | null>(null),
    maxLength: new FormControl<number | null>(null),
    accept: new FormControl('', { nonNullable: true }),
    maxSizeMb: new FormControl<number | null>(null),
    multiple: new FormControl(false, { nonNullable: true }),
  });
  protected readonly options = this.form.controls.options;

  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(null)), {
    initialValue: null,
  });

  protected readonly type = computed<FieldType>(
    () => (this.value(), this.form.controls.type.value),
  );
  protected readonly kind = computed(() => fieldCapabilities(this.type()));
  protected readonly published = computed(() => {
    const d = this.definition();
    return !!d && d.state !== 'draft';
  });
  protected readonly locked = this.published;
  protected readonly canManage = computed(() => this.permissions.can('configuration.forms.manage'));
  protected readonly typeOptions = computed(() => {
    const d = this.definition();
    if (!d) return READY_TYPES;
    // Um campo já existente mantém o seu tipo visível mesmo que o tipo ainda esteja em preparação.
    return READY_TYPES.some((o) => o.value === d.field.type)
      ? READY_TYPES
      : [...READY_TYPES, { value: d.field.type, label: d.field.type }];
  });

  protected readonly isNumeric = computed(() =>
    ['number', 'decimal', 'currency'].includes(this.type()),
  );
  protected readonly isText = computed(() => ['text', 'textarea'].includes(this.type()));
  protected readonly isFile = computed(() => ['file', 'image'].includes(this.type()));
  protected readonly hasTypeSettings = computed(
    () => this.isNumeric() || this.isText() || this.isFile(),
  );

  private readonly draft = computed<FieldDraft>(() => {
    this.value();
    const v = this.form.getRawValue();
    return { ...EMPTY_DRAFT, ...v, options: v.options };
  });

  /** O campo tal como ficaria; `null` enquanto não houver nome. */
  protected readonly previewField = computed(() => {
    const draft = this.draft();
    if (!draft.name.trim()) return null;
    return buildField(
      { ...draft, code: draft.code || 'preview' },
      { entityKey: this.entity().key },
    );
  });

  private readonly candidate = computed<CustomFieldDefinition | null>(() => {
    const field = this.previewField();
    const tenantId = this.tenant()?.id;
    if (!field || !tenantId) return null;
    const previous = this.definition();
    return {
      id: previous?.id ?? `cf-new-${field.key}`,
      tenantId,
      entity: entityRefOf(this.entity()),
      field: { ...field, origin: 'custom' },
      displayOrder: previous?.displayOrder ?? 9999,
      showInList: this.form.controls.showInList.value,
      state: 'active',
      version: previous?.version ?? 1,
      audit: previous?.audit ?? { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
    };
  });

  /** Verificação local imediata; o servidor volta sempre a validar. */
  protected readonly issues = computed<readonly DefinitionIssue[]>(() => {
    const candidate = this.candidate();
    const local: DefinitionIssue[] = [];
    if (!this.draft().name.trim()) return local;
    if (!/^[a-z][A-Za-z0-9]{1,39}$/.test(this.draft().code))
      local.push({
        severity: 'error',
        path: 'code',
        message: 'O código começa por minúscula e tem 2 a 40 letras ou dígitos (camelCase).',
      });
    if (candidate)
      local.push(
        ...validateCustomFieldDefinition(this.entity(), candidate, this.registry.all()).filter(
          (i) => i.severity === 'error',
        ),
      );
    return [...local, ...this.serverIssues()];
  });

  constructor() {
    // Carrega o campo a editar (ou limpa para um novo).
    effect(() => {
      const d = this.definition();
      this.codeTouched.set(!!d);
      this.fill(d ? draftOf(d.field) : EMPTY_DRAFT, d?.showInList ?? false);
    });

    // O código acompanha o nome enquanto o utilizador não o tocar e o campo ainda não existe.
    this.form.controls.name.valueChanges.subscribe((name) => {
      if (!this.codeTouched() && !this.definition())
        this.form.controls.code.setValue(codeFromName(name), { emitEvent: true });
    });

    // Ao mudar o tipo, os parâmetros específicos do tipo anterior deixam de fazer sentido.
    this.form.controls.type.valueChanges.subscribe((type) => {
      this.previewControl.setValue(null);
      if (fieldCapabilities(type).options && this.options.length === 0) this.addOption();
    });

    effect(() => {
      const locked = this.locked();
      const { code, type } = this.form.controls;
      for (const c of [code, type]) {
        if (locked) c.disable({ emitEvent: false });
        else c.enable({ emitEvent: false });
      }
    });
  }

  protected addOption(): void {
    this.options.push(optionGroup());
  }

  protected removeOption(index: number): void {
    this.options.removeAt(index);
  }

  protected save(state: 'draft' | 'active'): void {
    if (!this.canManage() || this.saving() || this.issues().length > 0) return;
    const previous = this.definition();
    const field = buildField(this.draft(), {
      entityKey: this.entity().key,
      order: previous?.field.order,
    });
    this.saving.set(true);
    this.error.set(null);
    this.serverIssues.set([]);

    this.registry
      .save({
        id: previous?.id ?? null,
        entity: entityRefOf(this.entity()),
        field,
        showInList: this.form.controls.showInList.value,
        state,
        expectedVersion: previous?.version ?? null,
      })
      .subscribe({
        next: (saved) => {
          this.saving.set(false);
          this.saved.emit(saved);
        },
        error: (e: ApiError) => {
          this.saving.set(false);
          const issues = (e.details as DefinitionFailure | undefined)?.issues;
          if (issues?.length) this.serverIssues.set(issues);
          else this.error.set(errorMessage(e));
        },
      });
  }

  private fill(draft: FieldDraft, showInList: boolean): void {
    this.options.clear({ emitEvent: false });
    for (const o of draft.options)
      this.options.push(optionGroup(o.value, o.label, o.active !== false));
    this.form.patchValue({ ...draft, options: undefined, showInList });
    if (fieldCapabilities(draft.type).options && this.options.length === 0) this.addOption();
  }
}
