import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { type Observable, startWith, switchMap } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import type { DefinitionFailure } from '../../../core/dynamic/data-access/custom-field.gateway';
import { defineEntity } from '../../../core/dynamic/engine/define-entity';
import {
  type DefinitionIssue,
  integrityContext,
  validateEntityDefinition,
} from '../../../core/dynamic/engine/definition-integrity';
import { ENTITY_KEY_PATTERN, entityKeyFromName } from '../../../core/dynamic/engine/field-draft';
import { fieldAccessFromPermissions } from '../../../core/dynamic/engine/field-state';
import { fieldTypeDefinition } from '../../../core/dynamic/engine/field-types';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import type { EntityDefinition } from '../../../core/dynamic/models/entity-definition.model';
import type { FieldDefinition } from '../../../core/dynamic/models/field-definition.model';
import { moduleId } from '../../../core/modules/define-module';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { DynamicFormRenderer } from '../../../shared/dynamic/dynamic-form-renderer';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { CustomFieldDesigner } from '../custom-fields/custom-field-designer';

const ICONS: readonly SelectOption[] = [
  { value: 'cube', label: 'Objecto' },
  { value: 'users', label: 'Pessoas' },
  { value: 'building', label: 'Edifício' },
  { value: 'document', label: 'Documento' },
  { value: 'card', label: 'Cartão' },
  { value: 'shield', label: 'Escudo' },
  { value: 'bolt', label: 'Energia' },
  { value: 'heart', label: 'Saúde' },
  { value: 'academic', label: 'Formação' },
];

/** `-1` = campo novo; caso contrário, o índice do campo em edição. */
type Editing = number | null;

/**
 * Configuração → Core Dinâmico → Nova entidade / Editar. Define uma entidade do tenant só com
 * metadados: os formulários, listagens, pesquisa, validação, permissões e auditoria são gerados
 * pelo motor existente. Não há componentes Angular por entidade.
 */
@Component({
  selector: 'app-entity-designer-page',
  imports: [
    ReactiveFormsModule,
    PageHeader,
    Card,
    Alert,
    Badge,
    Button,
    Input,
    Textarea,
    Select,
    EmptyState,
    RouterLink,
    DynamicFormRenderer,
    CustomFieldDesigner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (blocked(); as reason) {
      <app-empty-state
        icon="shield"
        title="Não é possível editar esta entidade"
        [description]="reason"
      />
    } @else {
      <app-page-header
        [title]="currentKey() ? 'Editar · ' + (plural() || currentKey()) : 'Nova entidade'"
        description="Defina os campos e publique. O formulário, a listagem, a pesquisa, as permissões e a auditoria são gerados a partir destes metadados."
      >
        <div pageActions class="flex flex-wrap items-center gap-2">
          @if (draft(); as draft) {
            <app-badge tone="warning">Rascunho v{{ draft.version }}</app-badge>
          }
          @if (published(); as published) {
            <app-badge tone="success">Publicada v{{ published.version }}</app-badge>
          }
          <a routerLink=".." class="text-sm text-brand-700 hover:underline dark:text-brand-300"
            >Voltar</a
          >
        </div>
      </app-page-header>

      @if (message(); as text) {
        <app-alert class="mb-4" tone="success">{{ text }}</app-alert>
      }

      @if (editing() !== null) {
        <app-custom-field-designer
          [owned]="true"
          [entity]="trial()"
          [ownedField]="editedField()"
          [lockIdentity]="editedLocked()"
          (built)="applyField($event)"
          (cancelled)="editing.set(null)"
        />
      } @else {
        <div class="grid gap-6 lg:grid-cols-3">
          <div class="space-y-6 lg:col-span-2">
            <app-card title="Identificação">
              <form [formGroup]="form" class="grid gap-4 sm:grid-cols-2">
                <app-input formControlName="singular" label="Nome (singular)" [required]="true" />
                <app-input formControlName="plural" label="Nome (plural)" [required]="true" />
                <app-input
                  formControlName="key"
                  label="Código"
                  hint="Identificador técnico estável (minúsculas e hífens). Não muda depois de criada."
                  [required]="true"
                  (input)="keyTouched.set(true)"
                />
                <app-select formControlName="icon" label="Ícone" [options]="icons" />
                <div class="sm:col-span-2">
                  <app-textarea formControlName="description" label="Descrição" [rows]="2" />
                </div>
              </form>
            </app-card>

            <app-card title="Campos">
              @if (fields().length === 0) {
                <p class="text-sm text-fg-muted">Ainda não há campos. Adicione o primeiro.</p>
              } @else {
                <ul class="divide-y divide-line" data-testid="field-list">
                  @for (field of fields(); track field.key; let i = $index) {
                    <li class="flex flex-wrap items-center gap-2 py-2">
                      <div class="min-w-0 flex-1">
                        <span class="font-medium" [class.line-through]="field.archived">{{
                          field.label
                        }}</span>
                        <code class="ms-2 text-xs text-fg-muted">{{ field.key }}</code>
                        <span class="ms-2 text-xs text-fg-muted">{{ typeLabel(field) }}</span>
                        @if (field.required) {
                          <app-badge class="ms-2">obrigatório</app-badge>
                        }
                        @if (field.archived) {
                          <app-badge class="ms-2" tone="neutral">arquivado</app-badge>
                        }
                      </div>
                      <div class="flex gap-1">
                        <app-button
                          variant="ghost"
                          size="sm"
                          [disabled]="i === 0"
                          (click)="move(i, -1)"
                          >Subir</app-button
                        >
                        <app-button
                          variant="ghost"
                          size="sm"
                          [disabled]="i === fields().length - 1"
                          (click)="move(i, 1)"
                          >Descer</app-button
                        >
                        <app-button variant="ghost" size="sm" (click)="editing.set(i)"
                          >Editar</app-button
                        >
                        @if (isPublishedField(field)) {
                          <app-button variant="ghost" size="sm" (click)="toggleArchived(i)">{{
                            field.archived ? 'Reactivar' : 'Arquivar'
                          }}</app-button>
                        } @else {
                          <app-button variant="ghost" size="sm" (click)="remove(i)"
                            >Remover</app-button
                          >
                        }
                      </div>
                    </li>
                  }
                </ul>
              }
              <app-button class="mt-3" variant="secondary" (click)="editing.set(-1)"
                >Adicionar campo</app-button
              >
            </app-card>
          </div>

          <div class="space-y-6">
            <app-card title="Formulário gerado">
              @if (activeFieldCount() === 0) {
                <p class="text-sm text-fg-muted">Adicione campos para ver o formulário.</p>
              } @else {
                <app-dynamic-form
                  [entity]="trial()"
                  mode="create"
                  [showActions]="false"
                  [access]="previewAccess"
                />
              }
            </app-card>

            @if (touched() && issues().length > 0) {
              <app-alert tone="danger" title="Corrija antes de publicar">
                <ul class="list-disc ps-4" data-testid="entity-issues">
                  @for (issue of issues(); track $index) {
                    <li>{{ issue.message }}</li>
                  }
                </ul>
              </app-alert>
            }
            @if (error(); as text) {
              <app-alert tone="danger" title="Não foi possível concluir">{{ text }}</app-alert>
            }

            @if (canManage()) {
              <div class="flex flex-wrap gap-2">
                @if (mayPublish()) {
                  <app-button [loading]="saving()" [disabled]="!canPublish()" (click)="run(true)"
                    >Publicar</app-button
                  >
                }
                <app-button
                  variant="secondary"
                  [disabled]="saving() || !canSaveDraft()"
                  (click)="run(false)"
                  >Guardar rascunho</app-button
                >
                @if (draft()) {
                  <app-button variant="ghost" [disabled]="saving()" (click)="discard()"
                    >Descartar rascunho</app-button
                  >
                }
              </div>
            } @else {
              <p class="text-sm text-fg-muted">Não tem permissão para gerir entidades.</p>
            }
          </div>
        </div>
      }
    }
  `,
})
export class EntityDesignerPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  /** Presente ao editar; ausente ao criar. */
  readonly entityKey = input<string>();

  protected readonly icons = ICONS;
  protected readonly previewAccess = fieldAccessFromPermissions(() => true);
  protected readonly keyTouched = signal(false);
  protected readonly editing = signal<Editing>(null);
  protected readonly fields = signal<readonly FieldDefinition[]>([]);
  protected readonly saving = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly serverIssues = signal<readonly DefinitionIssue[]>([]);
  private readonly savedKey = signal<string | null>(null);
  private readonly initializedFor = signal<string | null | undefined>(undefined);

  protected readonly form = new FormGroup({
    singular: new FormControl('', { nonNullable: true }),
    plural: new FormControl('', { nonNullable: true }),
    key: new FormControl('', { nonNullable: true }),
    icon: new FormControl('cube', { nonNullable: true }),
    description: new FormControl('', { nonNullable: true }),
  });
  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(null)), {
    initialValue: null,
  });
  /** Os problemas só se mostram depois de o utilizador começar a preencher. */
  protected readonly touched = computed(() => this.value() !== null || this.fields().length > 0);
  protected readonly plural = computed(() => (this.value(), this.form.controls.plural.value));

  protected readonly currentKey = computed(() => this.entityKey() ?? this.savedKey());
  protected readonly canManage = computed(() => this.permissions.can('configuration.forms.manage'));

  protected readonly draft = computed(() => {
    const key = this.currentKey();
    return key ? this.registry.draftOf(key) : undefined;
  });
  protected readonly published = computed(() => {
    const key = this.currentKey();
    return key
      ? this.registry
          .all()
          .find((d) => d.key === key && d.scope === 'tenant' && d.state === 'published')
      : undefined;
  });

  /** Entidades da plataforma e entidades inexistentes não se editam aqui. */
  protected readonly blocked = computed<string | null>(() => {
    const key = this.entityKey();
    if (!key) return null;
    const global = this.registry.all().some((d) => d.key === key && d.scope === 'global');
    if (global)
      return 'É uma entidade da plataforma. Pode acrescentar-lhe campos personalizados, mas não alterar a sua definição.';
    return this.draft() || this.published() ? null : 'A entidade não existe neste tenant.';
  });

  /** A entidade tal como ficaria (com os campos actuais), usada na pré-visualização e nas verificações. */
  protected readonly trial = computed<EntityDefinition>(() => {
    this.value();
    const v = this.form.getRawValue();
    return defineEntity({
      key: v.key || 'nova-entidade',
      scope: 'tenant',
      tenantId: this.tenant()?.id ?? null,
      moduleId: moduleId('configuration.forms'),
      version: (this.draft() ?? this.published())?.version ?? 1,
      state: 'draft',
      names: { singular: v.singular || 'Entidade', plural: v.plural || 'Entidades' },
      description: v.description || undefined,
      icon: v.icon,
      fields: this.fields().map((f, i) => ({ ...f, order: (i + 1) * 10 })),
    });
  });

  protected readonly activeFieldCount = computed(
    () => this.fields().filter((f) => !f.archived).length,
  );

  protected readonly issues = computed<readonly DefinitionIssue[]>(() => {
    const v = (this.value(), this.form.getRawValue());
    const local: DefinitionIssue[] = [];
    if (!v.singular.trim() || !v.plural.trim())
      local.push({
        severity: 'error',
        path: 'names',
        message: 'Indique o nome no singular e no plural.',
      });
    if (!ENTITY_KEY_PATTERN.test(v.key))
      local.push({
        severity: 'error',
        path: 'key',
        message: 'O código começa por minúscula e tem 2 a 30 minúsculas, números ou hífens.',
      });
    if (this.activeFieldCount() === 0 && this.fields().length === 0)
      local.push({
        severity: 'error',
        path: 'fields',
        message: 'A entidade precisa de pelo menos um campo.',
      });
    const trial = this.trial();
    const context = integrityContext([
      ...this.registry.published().filter((d) => d.key !== trial.key),
      trial,
    ]);
    for (const issue of validateEntityDefinition(trial, context)) {
      if (issue.severity === 'error' && !local.some((l) => l.message === issue.message))
        local.push(issue);
    }
    return [...local, ...this.serverIssues()];
  });

  protected readonly canSaveDraft = computed(() => {
    const v = (this.value(), this.form.getRawValue());
    return !!v.singular.trim() && !!v.plural.trim() && ENTITY_KEY_PATTERN.test(v.key);
  });
  protected readonly mayPublish = computed(() =>
    this.permissions.can('configuration.forms.publish'),
  );
  protected readonly canPublish = computed(
    () => this.canManage() && !this.saving() && this.issues().length === 0,
  );

  protected readonly editedField = computed(() => {
    const index = this.editing();
    return index !== null && index >= 0 ? (this.fields()[index] ?? null) : null;
  });
  protected readonly editedLocked = computed(() => {
    const field = this.editedField();
    return !!field && this.isPublishedField(field);
  });

  constructor() {
    // Carrega a entidade a editar uma única vez por chave; edições locais nunca são sobrepostas.
    effect(() => {
      const key = this.entityKey() ?? null;
      const source = key ? (this.draft() ?? this.published()) : undefined;
      untracked(() => {
        if (this.initializedFor() === key) return;
        if (key && !source) return; // ainda por carregar
        this.initializedFor.set(key);
        if (source) this.fillFrom(source);
      });
    });

    // O código acompanha o nome (singular) enquanto a entidade é nova e o código não foi tocado.
    this.form.controls.singular.valueChanges.subscribe((name) => {
      if (!this.currentKey() && !this.keyTouched())
        this.form.controls.key.setValue(entityKeyFromName(name));
    });

    effect(() => {
      const locked = !!this.currentKey();
      untracked(() => {
        if (locked) this.form.controls.key.disable({ emitEvent: false });
        else this.form.controls.key.enable({ emitEvent: false });
      });
    });

    this.form.valueChanges.subscribe(() => {
      if (this.serverIssues().length > 0) this.serverIssues.set([]);
    });
  }

  protected typeLabel(field: FieldDefinition): string {
    return fieldTypeDefinition(field.type).label;
  }

  /** O campo existe na versão publicada: o código e o tipo ficam fixos e não se remove. */
  protected isPublishedField(field: FieldDefinition): boolean {
    return !!this.published()?.fields.some((f) => f.key === field.key);
  }

  protected applyField(field: FieldDefinition): void {
    const index = this.editing();
    this.fields.update((list) =>
      index !== null && index >= 0
        ? list.map((f, i) => (i === index ? field : f))
        : [...list, field],
    );
    this.editing.set(null);
  }

  protected move(index: number, delta: -1 | 1): void {
    this.fields.update((list) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  protected remove(index: number): void {
    this.fields.update((list) => list.filter((_, i) => i !== index));
  }

  protected toggleArchived(index: number): void {
    this.fields.update((list) =>
      list.map((f, i) => (i === index ? { ...f, archived: f.archived ? undefined : true } : f)),
    );
  }

  protected run(publish: boolean): void {
    if (!this.canManage() || this.saving()) return;
    if (publish && (!this.mayPublish() || this.issues().length > 0)) return;
    const v = this.form.getRawValue();
    const current = this.draft() ?? this.published();

    this.saving.set(true);
    this.error.set(null);
    this.message.set(null);
    this.serverIssues.set([]);

    const request$: Observable<EntityDefinition> = this.registry
      .saveDraft({
        key: v.key,
        names: { singular: v.singular.trim(), plural: v.plural.trim() },
        description: v.description.trim() || undefined,
        icon: v.icon,
        fields: this.fields().map((f, i) => ({ ...f, order: (i + 1) * 10 })),
        expectedVersion: current?.version ?? null,
        ...(current?.rowVersion !== undefined ? { expectedRowVersion: current.rowVersion } : {}),
      })
      .pipe(switchMap((draft) => (publish ? this.registry.publish(draft.key) : [draft])));

    request$.subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.savedKey.set(saved.key);
        this.message.set(
          publish
            ? `Entidade publicada (v${saved.version}). Já está disponível no menu «Dados».`
            : `Rascunho guardado (v${saved.version}). Ainda não está visível aos utilizadores.`,
        );
      },
      error: (e: ApiError) => {
        this.saving.set(false);
        const issues = (e.details as DefinitionFailure | undefined)?.issues;
        if (issues?.length) this.serverIssues.set(issues);
        else this.error.set(errorMessage(e));
      },
    });
  }

  protected discard(): void {
    const key = this.currentKey();
    if (!key || this.saving()) return;
    this.saving.set(true);
    this.registry.discardDraft(key).subscribe({
      next: () => {
        this.saving.set(false);
        const published = this.published();
        if (published) this.fillFrom(published);
        this.message.set('Rascunho descartado.');
      },
      error: (e: unknown) => {
        this.saving.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  private fillFrom(entity: EntityDefinition): void {
    this.fields.set(entity.fields);
    this.form.patchValue({
      singular: entity.names.singular,
      plural: entity.names.plural,
      key: entity.key,
      icon: entity.icon,
      description: entity.description ?? '',
    });
    this.keyTouched.set(true);
  }
}
