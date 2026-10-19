import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { CustomFieldRegistryService } from '../../../core/dynamic/custom-field-registry.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { fieldTypeDefinition } from '../../../core/dynamic/engine/field-types';
import type {
  CustomFieldDefinition,
  CustomFieldState,
} from '../../../core/dynamic/models/custom-definition.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { CustomFieldDesigner } from './custom-field-designer';

const STATE: Record<CustomFieldState, { label: string; tone: 'success' | 'warning' | 'neutral' }> =
  {
    active: { label: 'Activo', tone: 'success' },
    draft: { label: 'Rascunho', tone: 'warning' },
    archived: { label: 'Arquivado', tone: 'neutral' },
  };

interface Row {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  readonly origin: 'core' | 'custom';
  readonly state: CustomFieldState | null;
  readonly flags: string;
  readonly definition: CustomFieldDefinition | null;
}

/**
 * Configuração → Core Dinâmico → entidade → Campos personalizados. Lista os campos nativos
 * (só de leitura) e os do tenant, e abre o designer para criar ou alterar.
 */
@Component({
  selector: 'app-custom-fields-page',
  imports: [
    PageHeader,
    Card,
    Table,
    Badge,
    Alert,
    Button,
    EmptyState,
    RouterLink,
    CustomFieldDesigner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      <app-page-header
        [title]="'Campos personalizados · ' + entity.names.plural"
        description="Campos que este tenant acrescenta à entidade nativa. Outros tenants não os veem e a definição da plataforma não é alterada."
      >
        <div pageActions class="flex items-center gap-2">
          <a
            [routerLink]="['..', entity.key]"
            class="text-sm text-brand-700 hover:underline dark:text-brand-300"
            >Definição</a
          >
          @if (canManage() && extensible() && !editing()) {
            <app-button (click)="startNew()">Novo campo</app-button>
          }
        </div>
      </app-page-header>

      @if (!extensible()) {
        <app-empty-state
          icon="cube"
          title="Esta entidade não aceita campos personalizados"
          description="Só as entidades marcadas como extensíveis permitem campos adicionais."
        />
      } @else {
        @if (message(); as text) {
          <app-alert class="mb-4" [tone]="messageTone()" (click)="message.set(null)">{{
            text
          }}</app-alert>
        }

        @if (editing()) {
          <app-custom-field-designer
            [entity]="entity"
            [definition]="editing() === 'new' ? null : $any(editing())"
            (saved)="onSaved()"
            (cancelled)="editing.set(null)"
          />
        } @else {
          <app-card [flush]="true">
            <app-table caption="Campos da entidade" [columns]="columns" [rows]="rows()">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                    <code class="ms-2 text-xs text-fg-muted">{{ row.key }}</code>
                  }
                  @case ('origin') {
                    <app-badge [tone]="row.origin === 'core' ? 'brand' : 'neutral'">{{
                      row.origin === 'core' ? 'Nativo' : 'Personalizado'
                    }}</app-badge>
                  }
                  @case ('state') {
                    @if (row.state; as state) {
                      <app-badge [tone]="stateInfo(state).tone">{{
                        stateInfo(state).label
                      }}</app-badge>
                    } @else {
                      —
                    }
                  }
                  @case ('actions') {
                    @if (row.definition && canManage()) {
                      <div class="flex justify-end gap-1">
                        @if (row.state !== 'archived') {
                          <app-button variant="ghost" size="sm" (click)="edit(row.definition)"
                            >Editar</app-button
                          >
                        }
                        @if (row.state === 'active' && canPublish()) {
                          <app-button
                            variant="ghost"
                            size="sm"
                            (click)="setState(row.definition, 'archived')"
                            >Arquivar</app-button
                          >
                        } @else if (row.state === 'archived' && canPublish()) {
                          <app-button
                            variant="ghost"
                            size="sm"
                            (click)="setState(row.definition, 'active')"
                            >Reactivar</app-button
                          >
                        }
                      </div>
                    }
                  }
                  @default {
                    {{ row[column.key] }}
                  }
                }
              </ng-template>
            </app-table>
          </app-card>
        }
      }
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada" />
    }
  `,
})
export class CustomFieldsPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly customFields = inject(CustomFieldRegistryService);
  private readonly permissions = inject(PermissionService);

  readonly entityKey = input.required<string>();

  protected readonly editing = signal<CustomFieldDefinition | 'new' | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly messageTone = signal<'success' | 'danger'>('success');

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Campo' },
    { key: 'type', label: 'Tipo' },
    { key: 'origin', label: 'Origem' },
    { key: 'state', label: 'Estado' },
    { key: 'flags', label: 'Comportamento' },
    { key: 'actions', label: '', align: 'end' },
  ];

  /** A definição nativa, sem campos personalizados (é a base do designer). */
  protected readonly entity = computed(() =>
    this.registry.base().find((d) => d.key === this.entityKey()),
  );
  protected readonly extensible = computed(() => this.entity()?.extensible === true);
  protected readonly canManage = computed(() => this.permissions.can('configuration.forms.manage'));
  protected readonly canPublish = computed(() =>
    this.permissions.can('configuration.forms.publish'),
  );

  protected readonly rows = computed<readonly Row[]>(() => {
    const entity = this.entity();
    if (!entity) return [];
    const native = entity.fields
      .filter((f) => !f.archived)
      .map<Row>((f) => ({
        key: f.key,
        name: f.label,
        type: fieldTypeDefinition(f.type).label,
        origin: 'core',
        state: null,
        flags: this.flags(f),
        definition: null,
      }));
    const custom = this.customFields.forEntity({ kind: 'core', key: entity.key }).map<Row>((c) => ({
      key: c.field.key,
      name: c.field.label,
      type: fieldTypeDefinition(c.field.type).label,
      origin: 'custom',
      state: c.state,
      flags: this.flags(c.field, c.showInList),
      definition: c,
    }));
    return [...native, ...custom];
  });

  protected stateInfo(state: CustomFieldState) {
    return STATE[state];
  }

  protected startNew(): void {
    this.message.set(null);
    this.editing.set('new');
  }

  protected edit(definition: CustomFieldDefinition): void {
    this.message.set(null);
    this.editing.set(definition);
  }

  protected onSaved(): void {
    this.editing.set(null);
    this.messageTone.set('success');
    this.message.set('Campo guardado.');
  }

  protected setState(definition: CustomFieldDefinition, state: 'active' | 'archived'): void {
    this.customFields.setState(definition.id, state).subscribe({
      next: () => {
        this.messageTone.set('success');
        this.message.set(
          state === 'archived'
            ? 'Campo arquivado. Os dados já gravados são preservados.'
            : 'Campo reactivado.',
        );
      },
      error: (e: unknown) => {
        this.messageTone.set('danger');
        this.message.set(errorMessage(e));
      },
    });
  }

  private flags(
    field: {
      required: boolean;
      searchable: boolean;
      filterable: boolean;
      sensitivity?: string;
      validations: readonly { type: string }[];
    },
    showInList = false,
  ): string {
    return [
      field.required && 'obrigatório',
      field.validations.some((r) => r.type === 'unique') && 'único',
      field.sensitivity === 'sensitive' && 'sensível',
      field.searchable && 'pesquisável',
      field.filterable && 'filtro',
      showInList && 'na listagem',
    ]
      .filter(Boolean)
      .join(', ');
  }
}
