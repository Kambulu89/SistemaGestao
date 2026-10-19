import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { diffDefinitions } from '../../../core/dynamic/engine/definition-compat';
import { ENTITY_OPERATIONS } from '../../../core/dynamic/engine/entity-permissions';
import { resolveForm } from '../../../core/dynamic/engine/form-resolver';
import {
  describeCondition,
  describeRule,
  FIELD_TYPE_LABELS,
} from '../../../core/dynamic/engine/summaries';
import type {
  DefinitionState,
  EntityOperation,
} from '../../../core/dynamic/models/entity-definition.model';
import { hasOptions } from '../../../core/dynamic/models/field-definition.model';
import type { FormItem, FormMode } from '../../../core/dynamic/models/form-definition.model';
import { DynamicFormRenderer } from '../../../shared/dynamic/dynamic-form-renderer';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';

const STATE_LABELS: Record<
  DefinitionState,
  { label: string; tone: 'success' | 'neutral' | 'warning' }
> = {
  published: { label: 'Publicada', tone: 'success' },
  draft: { label: 'Rascunho', tone: 'warning' },
  archived: { label: 'Arquivada', tone: 'neutral' },
};

const MODE_LABELS: Record<FormMode, string> = {
  create: 'Criação',
  edit: 'Edição',
  read: 'Leitura',
};

const OPERATION_LABELS: Record<EntityOperation, string> = {
  read: 'Visualizar',
  create: 'Criar',
  update: 'Editar',
  delete: 'Eliminar',
  export: 'Exportar',
  approve: 'Aprovar',
  transition: 'Executar transições',
};

const yesNo = (value: boolean): string => (value ? 'Sim' : 'Não');

/**
 * Configuração → Core Dinâmico → entidade. Mostra a definição em linguagem legível: é a base
 * sobre a qual os futuros builders visuais (campos, formulários, workflows) vão escrever.
 */
@Component({
  selector: 'app-entity-admin-detail-page',
  imports: [
    PageHeader,
    Card,
    Table,
    Badge,
    Alert,
    EmptyState,
    DynamicFormRenderer,
    RouterLink,
    DatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entity(); as entity) {
      <app-page-header [title]="entity.names.plural" [description]="entity.description">
        <div pageActions class="flex flex-wrap items-center gap-2">
          <app-badge [tone]="entity.scope === 'global' ? 'brand' : 'neutral'">{{
            entity.scope === 'global' ? 'Global' : 'Do tenant'
          }}</app-badge>
          <app-badge>v{{ entity.version }}</app-badge>
          <app-badge [tone]="state().tone">{{ state().label }}</app-badge>
          @if (entity.extensible) {
            <a
              routerLink="campos"
              class="text-sm text-brand-700 hover:underline dark:text-brand-300"
              >Campos personalizados</a
            >
          }
          @if (canOpenRecords()) {
            <a
              [routerLink]="['../../data', entity.key]"
              class="text-sm text-brand-700 hover:underline dark:text-brand-300"
              >Ver registos</a
            >
          }
        </div>
      </app-page-header>

      @if (issues().length > 0) {
        <app-alert
          class="mb-6"
          [tone]="hasErrors() ? 'danger' : 'warning'"
          title="Integridade da definição"
        >
          <ul class="list-disc ps-4">
            @for (issue of issues(); track $index) {
              <li>
                <code class="text-xs">{{ issue.path }}</code
                >: {{ issue.message }}
              </li>
            }
          </ul>
        </app-alert>
      }

      <div class="space-y-8">
        <section aria-labelledby="sec-fields">
          <h2 id="sec-fields" class="mb-2 text-lg font-semibold">Campos</h2>
          <app-card [flush]="true">
            <app-table caption="Campos da entidade" [columns]="fieldColumns" [rows]="fieldRows()" />
          </app-card>
        </section>

        <section aria-labelledby="sec-forms">
          <h2 id="sec-forms" class="mb-2 text-lg font-semibold">Formulários</h2>
          <div class="grid gap-4 lg:grid-cols-3">
            @for (form of forms(); track form.mode) {
              <app-card [title]="form.mode">
                <p class="mb-2 text-xs text-fg-muted">
                  {{
                    form.auto
                      ? 'Gerado automaticamente a partir dos campos.'
                      : 'Definido pela entidade.'
                  }}
                </p>
                @for (section of form.sections; track section.title) {
                  <p class="mt-2 text-sm font-medium">
                    {{ section.title }}
                    <span class="text-fg-muted">· {{ section.columns }} col.</span>
                  </p>
                  <p class="text-sm text-fg-muted">{{ section.fields.join(', ') }}</p>
                }
              </app-card>
            }
          </div>
        </section>

        <section aria-labelledby="sec-list">
          <h2 id="sec-list" class="mb-2 text-lg font-semibold">Listagem</h2>
          <app-card>
            <dl class="grid gap-3 text-sm sm:grid-cols-2">
              @for (item of listSummary(); track item.label) {
                <div>
                  <dt class="font-medium text-fg-muted">{{ item.label }}</dt>
                  <dd>{{ item.value }}</dd>
                </div>
              }
            </dl>
          </app-card>
        </section>

        <section aria-labelledby="sec-workflow">
          <h2 id="sec-workflow" class="mb-2 text-lg font-semibold">Estados e workflow</h2>
          @if (entity.statuses.length === 0) {
            <app-card><p class="text-sm text-fg-muted">Esta entidade não tem estados.</p></app-card>
          } @else {
            <app-card class="mb-4" title="Estados">
              <ul class="flex flex-wrap gap-2">
                @for (status of entity.statuses; track status.code) {
                  <li>
                    <app-badge [tone]="status.color">{{ status.name }}</app-badge>
                    @if (initialCode() === status.code) {
                      <span class="ms-1 text-xs text-fg-muted">(inicial)</span>
                    }
                  </li>
                }
              </ul>
            </app-card>
            @if (entity.workflow) {
              <app-card [flush]="true">
                <app-table
                  [caption]="'Transições do workflow ' + entity.workflow.name"
                  [columns]="transitionColumns"
                  [rows]="transitionRows()"
                />
              </app-card>
            } @else {
              <app-card
                ><p class="text-sm text-fg-muted">
                  Sem workflow: qualquer mudança entre estados é permitida a quem tem permissão.
                </p></app-card
              >
            }
          }
        </section>

        <section aria-labelledby="sec-permissions">
          <h2 id="sec-permissions" class="mb-2 text-lg font-semibold">Permissões</h2>
          <div class="grid gap-4 lg:grid-cols-2">
            <app-card [flush]="true">
              <app-table
                caption="Permissões por operação"
                [columns]="permissionColumns"
                [rows]="permissionRows()"
              />
            </app-card>
            <app-card title="Políticas (ABAC)">
              @if (policyRows().length === 0) {
                <p class="text-sm text-fg-muted">
                  Sem políticas: só contam as permissões do papel.
                </p>
              } @else {
                <ul class="space-y-2 text-sm">
                  @for (policy of policyRows(); track $index) {
                    <li>
                      <strong>Negar «{{ policy.operation }}»</strong> quando {{ policy.when }}.
                      <span class="text-fg-muted">{{ policy.message }}</span>
                    </li>
                  }
                </ul>
              }
            </app-card>
          </div>
        </section>

        <section aria-labelledby="sec-versions">
          <h2 id="sec-versions" class="mb-2 text-lg font-semibold">Versões</h2>
          <app-card [flush]="true">
            <app-table
              caption="Histórico de versões"
              [columns]="versionColumns"
              [rows]="versionRows()"
            >
              <ng-template let-row let-column="column">
                @if (column.key === 'state') {
                  <app-badge [tone]="row.tone">{{ row.state }}</app-badge>
                } @else if (column.key === 'publishedAt') {
                  {{ row.publishedAt ? (row.publishedAt | date: 'mediumDate') : '—' }}
                } @else {
                  {{ row[column.key] }}
                }
              </ng-template>
            </app-table>
          </app-card>
          <p class="mt-2 text-sm text-fg-muted">
            Publicar uma nova versão exige integridade e nenhuma alteração destrutiva; nada é
            migrado automaticamente.
          </p>
        </section>

        <section aria-labelledby="sec-preview">
          <h2 id="sec-preview" class="mb-1 text-lg font-semibold">Pré-visualização</h2>
          <p class="mb-3 text-sm text-fg-muted">
            O formulário de criação gerado a partir desta definição. Nada é guardado.
          </p>
          <app-dynamic-form
            [entity]="entity"
            mode="create"
            [showActions]="false"
            [access]="fieldAccess"
          />
        </section>
      </div>
    } @else {
      <app-empty-state icon="cube" title="Entidade não encontrada" />
    }
  `,
})
export class EntityAdminDetailPage {
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly access = inject(EntityAccessService);
  protected readonly fieldAccess = this.access.fieldAccess;

  /** Parâmetro de rota `:entityKey`. */
  readonly entityKey = input.required<string>();

  protected readonly entity = computed(() => this.registry.find(this.entityKey()));
  protected readonly state = computed(() => STATE_LABELS[this.entity()?.state ?? 'published']);
  protected readonly issues = computed(() => this.registry.issues().get(this.entityKey()) ?? []);
  protected readonly hasErrors = computed(() => this.issues().some((i) => i.severity === 'error'));
  protected readonly canOpenRecords = computed(() => {
    const entity = this.entity();
    return !!entity && this.access.can(entity, 'read');
  });

  protected readonly initialCode = computed(() => {
    const entity = this.entity();
    return (
      entity?.workflow?.initialStatus ??
      entity?.statuses.find((s) => s.initial)?.code ??
      entity?.statuses[0]?.code
    );
  });

  // ----------------------------------------------------------------- campos
  protected readonly fieldColumns: readonly TableColumn[] = [
    { key: 'label', label: 'Campo' },
    { key: 'key', label: 'Chave' },
    { key: 'type', label: 'Tipo' },
    { key: 'required', label: 'Obrigatório' },
    { key: 'rules', label: 'Regras' },
    { key: 'usage', label: 'Listagem' },
  ];

  protected readonly fieldRows = computed(() => {
    const entity = this.entity();
    if (!entity) return [];
    return [...entity.fields]
      .sort((a, b) => a.order - b.order)
      .map((f) => {
        const rules = [...f.validations, ...entity.rules.filter((r) => r.field === f.key)].map(
          (r) => describeRule(entity, r),
        );
        const extra = hasOptions(f)
          ? [`Opções: ${f.options.map((o) => o.label).join(', ')}`]
          : f.type === 'entity-reference'
            ? [`Referência a «${f.entityKey}»`]
            : [];
        const required = f.requiredWhen
          ? `Quando ${describeCondition(entity, f.requiredWhen)}`
          : yesNo(f.required);
        return {
          label: f.archived ? `${f.label} (arquivado)` : f.label,
          key: f.key,
          type: FIELD_TYPE_LABELS[f.type],
          required,
          rules: [...extra, ...rules].join(' · ') || '—',
          usage:
            [
              f.searchable ? 'Pesquisa' : '',
              f.filterable ? 'Filtro' : '',
              f.sortable ? 'Ordenação' : '',
            ]
              .filter(Boolean)
              .join(', ') || '—',
        };
      });
  });

  // ------------------------------------------------------------- formulários
  protected readonly forms = computed(() => {
    const entity = this.entity();
    if (!entity) return [];
    const labelOf = (key: string) => entity.fields.find((f) => f.key === key)?.label ?? key;
    const keys = (items: readonly FormItem[]): string[] =>
      items.flatMap((i) => (i.kind === 'field' ? [labelOf(i.field)] : keys(i.items)));
    return (['create', 'edit', 'read'] as const).map((mode) => ({
      mode: MODE_LABELS[mode],
      auto: !entity.forms.some((f) => f.modes.includes(mode)),
      sections: resolveForm(entity, mode).sections.map((s) => ({
        title: s.title,
        columns: s.columns,
        fields: keys(s.items),
      })),
    }));
  });

  protected readonly listSummary = computed(() => {
    const entity = this.entity();
    if (!entity) return [];
    const labelOf = (key: string) =>
      entity.fields.find((f) => f.key === key)?.label ?? (key === 'status' ? 'Estado' : key);
    const sort = entity.list.defaultSort;
    return [
      {
        label: 'Colunas',
        value: entity.list.columns.map((c) => c.label ?? labelOf(c.field)).join(', '),
      },
      { label: 'Pesquisa em', value: entity.list.searchFields.map(labelOf).join(', ') || '—' },
      { label: 'Filtros', value: entity.list.filters.map(labelOf).join(', ') || '—' },
      {
        label: 'Ordenação por omissão',
        value: sort
          ? `${labelOf(sort.field)} (${sort.direction === 'asc' ? 'crescente' : 'decrescente'})`
          : '—',
      },
      { label: 'Registos por página', value: String(entity.list.pageSize) },
      {
        label: 'Auditoria',
        value: entity.audit.enabled
          ? entity.audit.trackedFields === 'all'
            ? 'Todos os campos'
            : entity.audit.trackedFields.map(labelOf).join(', ')
          : 'Desactivada',
      },
    ];
  });

  // ---------------------------------------------------------------- workflow
  protected readonly transitionColumns: readonly TableColumn[] = [
    { key: 'name', label: 'Transição' },
    { key: 'from', label: 'De' },
    { key: 'to', label: 'Para' },
    { key: 'requires', label: 'Exige' },
    { key: 'condition', label: 'Condição' },
    { key: 'events', label: 'Eventos' },
  ];

  protected readonly transitionRows = computed(() => {
    const entity = this.entity();
    if (!entity?.workflow) return [];
    const name = (code: string) => entity.statuses.find((s) => s.code === code)?.name ?? code;
    return entity.workflow.transitions.map((t) => ({
      name: t.name,
      from: t.from.map(name).join(', '),
      to: name(t.to),
      requires:
        [
          t.permission ? `permissão ${t.permission}` : '',
          t.approval ? `aprovação (${t.approval.permission})` : '',
        ]
          .filter(Boolean)
          .join(' + ') || 'permissão de transição',
      condition: t.condition ? describeCondition(entity, t.condition) : '—',
      events: t.events?.join(', ') || '—',
    }));
  });

  // -------------------------------------------------------------- permissões
  protected readonly permissionColumns: readonly TableColumn[] = [
    { key: 'operation', label: 'Operação' },
    { key: 'key', label: 'Permissão (IAM)' },
  ];

  protected readonly permissionRows = computed(() => {
    const entity = this.entity();
    return entity
      ? ENTITY_OPERATIONS.map((op) => ({
          operation: OPERATION_LABELS[op],
          key: entity.permissions.operations[op],
        }))
      : [];
  });

  protected readonly policyRows = computed(() => {
    const entity = this.entity();
    return (entity?.permissions.policies ?? []).map((p) => ({
      operation: OPERATION_LABELS[p.operation].toLowerCase(),
      when: describeCondition(entity!, p.when),
      message: p.message ?? '',
    }));
  });

  // ----------------------------------------------------------------- versões
  protected readonly versionColumns: readonly TableColumn[] = [
    { key: 'version', label: 'Versão' },
    { key: 'state', label: 'Estado' },
    { key: 'publishedAt', label: 'Publicada em' },
    { key: 'changes', label: 'Alterações face à anterior' },
  ];

  protected readonly versionRows = computed(() => {
    const versions = this.registry.versionsOf(this.entityKey()); // da mais recente para a mais antiga
    return versions.map((v, index) => {
      const previous = versions[index + 1];
      const changes = previous ? diffDefinitions(previous, v) : [];
      return {
        version: `v${v.version}`,
        state: STATE_LABELS[v.state].label,
        tone: STATE_LABELS[v.state].tone,
        publishedAt: v.publishedAt ?? null,
        changes: previous
          ? changes.map((c) => c.message).join(' ') || 'Sem alterações de estrutura.'
          : 'Versão inicial.',
      };
    });
  });
}
