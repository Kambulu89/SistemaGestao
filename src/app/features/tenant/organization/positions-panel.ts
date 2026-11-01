import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type WritableSignal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import {
  OrganizationApi,
  type PositionDto,
  type PositionInput,
  type UnitDto,
} from '../data-access/organization.api';

/** Tipos de unidade onde um cargo pode ter o seu departamento por omissão (o servidor volta a verificar). */
const DEPARTMENT_TYPES = new Set(['DEPARTMENT', 'SECTION', 'TEAM']);

interface Draft {
  code: string;
  name: string;
  departmentId: string;
  parentId: string;
  hierarchyLevel: string;
  jobFamily: string;
  category: string;
  description: string;
  responsibilities: string;
  competencies: string;
  academicRequirements: string;
  recommendedExperience: string;
}

const EMPTY: Draft = {
  code: '',
  name: '',
  departmentId: '',
  parentId: '',
  hierarchyLevel: '',
  jobFamily: '',
  category: '',
  description: '',
  responsibilities: '',
  competencies: '',
  academicRequirements: '',
  recommendedExperience: '',
};

/** Converte o rascunho do formulário no corpo do pedido; devolve a mensagem do primeiro problema. */
export function positionBody(draft: Draft): { body: PositionInput; error: string | null } {
  const text = (value: string) => (value.trim() ? value.trim() : null);
  let hierarchyLevel: number | null = null;
  if (draft.hierarchyLevel.trim()) {
    const level = Number(draft.hierarchyLevel);
    if (!Number.isInteger(level) || level < 1 || level > 20) {
      return { body: {}, error: 'O nível hierárquico é um inteiro de 1 a 20.' };
    }
    hierarchyLevel = level;
  }
  if (!draft.name.trim()) return { body: {}, error: 'Indique a designação do cargo.' };
  return {
    body: {
      name: draft.name.trim(),
      departmentId: draft.departmentId || null,
      parentId: draft.parentId || null,
      hierarchyLevel,
      jobFamily: text(draft.jobFamily),
      category: text(draft.category),
      description: text(draft.description),
      responsibilities: text(draft.responsibilities),
      competencies: draft.competencies
        .split(/[\n,;]/)
        .map((c) => c.trim())
        .filter(Boolean),
      academicRequirements: text(draft.academicRequirements),
      recommendedExperience: text(draft.recommendedExperience),
    },
    error: null,
  };
}

/** Cargos e funções do tenant: lista com pesquisa e estado, criação e edição, activar/desactivar (sem eliminar). */
@Component({
  selector: 'app-positions-panel',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
    Textarea,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3">
      <h2 class="text-base font-semibold">Cargos e funções</h2>
      <div class="flex flex-wrap items-end gap-2">
        <app-input
          label="Pesquisar"
          [ngModel]="query()"
          (ngModelChange)="query.set($event ?? '')"
        />
        <app-select
          label="Estado"
          [options]="statusOptions"
          [ngModel]="status()"
          (ngModelChange)="status.set($event ?? '')"
        />
        @if (canManage()) {
          <app-button (click)="openEditor(null)">Novo cargo</app-button>
        }
      </div>
    </div>
    @if (error(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (positions.isLoading() && !positions.hasValue()) {
        <app-loading-state label="A carregar cargos…" />
      } @else if (positions.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os cargos">
            {{ describe(positions.error()) }}
          </app-alert>
        </div>
      } @else if (positions.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state
            icon="users"
            [title]="
              query() || status() ? 'Nenhum cargo corresponde aos filtros' : 'Ainda não há cargos'
            "
          />
        } @else {
          <app-table caption="Cargos" [columns]="columns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('code') {
                  <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{{ row.code }}</code>
                }
                @case ('department') {
                  {{ unitName(row.departmentId) }}
                }
                @case ('parent') {
                  {{ positionCode(row.parentId) }}
                }
                @case ('level') {
                  {{ row.hierarchyLevel ?? '—' }}
                }
                @case ('status') {
                  <app-badge [tone]="row.status === 'ACTIVE' ? 'success' : 'neutral'">{{
                    row.status === 'ACTIVE' ? 'Activo' : 'Inactivo'
                  }}</app-badge>
                }
                @case ('actions') {
                  @if (canManage()) {
                    <span class="flex justify-end gap-2">
                      <app-button size="sm" variant="secondary" (click)="openEditor(row)"
                        >Editar</app-button
                      >
                      <app-button size="sm" variant="secondary" (click)="toggle(row)">
                        {{ row.status === 'ACTIVE' ? 'Desactivar' : 'Reactivar' }}
                      </app-button>
                    </span>
                  }
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

    <app-dialog
      [open]="editorOpen()"
      [wide]="true"
      [title]="editing() ? 'Editar cargo ' + editing()!.code : 'Novo cargo'"
      (closed)="editorOpen.set(false)"
    >
      <div class="grid gap-3 sm:grid-cols-2" data-testid="position-form">
        @if (formError(); as text) {
          <app-alert tone="danger" class="sm:col-span-2">{{ text }}</app-alert>
        }
        @if (!editing()) {
          <app-input
            label="Código"
            [required]="true"
            [ngModel]="draft().code"
            (ngModelChange)="patch('code', $event)"
          />
        }
        <app-input
          label="Designação"
          [required]="true"
          [ngModel]="draft().name"
          (ngModelChange)="patch('name', $event)"
        />
        <app-select
          label="Departamento"
          placeholder="Sem departamento"
          [options]="departmentOptions()"
          [ngModel]="draft().departmentId"
          (ngModelChange)="patch('departmentId', $event)"
        />
        <app-select
          label="Cargo superior"
          placeholder="Nenhum"
          [options]="parentOptions()"
          [ngModel]="draft().parentId"
          (ngModelChange)="patch('parentId', $event)"
        />
        <app-input
          label="Nível hierárquico (1–20)"
          [ngModel]="draft().hierarchyLevel"
          (ngModelChange)="patch('hierarchyLevel', $event)"
        />
        <app-input
          label="Família profissional"
          [ngModel]="draft().jobFamily"
          (ngModelChange)="patch('jobFamily', $event)"
        />
        <app-input
          label="Categoria"
          [ngModel]="draft().category"
          (ngModelChange)="patch('category', $event)"
        />
        <app-input
          label="Experiência recomendada"
          [ngModel]="draft().recommendedExperience"
          (ngModelChange)="patch('recommendedExperience', $event)"
        />
        <div class="sm:col-span-2">
          <app-textarea
            label="Descrição"
            [ngModel]="draft().description"
            (ngModelChange)="patch('description', $event)"
          />
        </div>
        <div class="sm:col-span-2">
          <app-textarea
            label="Responsabilidades"
            [ngModel]="draft().responsibilities"
            (ngModelChange)="patch('responsibilities', $event)"
          />
        </div>
        <div class="sm:col-span-2">
          <app-textarea
            label="Competências (uma por linha ou separadas por vírgulas)"
            [ngModel]="draft().competencies"
            (ngModelChange)="patch('competencies', $event)"
          />
        </div>
        <div class="sm:col-span-2">
          <app-textarea
            label="Requisitos académicos"
            [ngModel]="draft().academicRequirements"
            (ngModelChange)="patch('academicRequirements', $event)"
          />
        </div>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="editorOpen.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class PositionsPanel {
  /** Unidades da organização escolhida: os departamentos possíveis. */
  readonly units = input.required<readonly UnitDto[]>();

  private readonly organization = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  protected readonly canManage = computed(() => this.permissions.can('organization.manage'));

  protected readonly columns: readonly TableColumn[] = [
    { key: 'code', label: 'Código' },
    { key: 'name', label: 'Designação' },
    { key: 'department', label: 'Departamento' },
    { key: 'parent', label: 'Superior' },
    { key: 'level', label: 'Nível' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly statusOptions: readonly SelectOption[] = [
    { value: '', label: 'Todos' },
    { value: 'ACTIVE', label: 'Activos' },
    { value: 'INACTIVE', label: 'Inactivos' },
  ];

  protected readonly query = signal('');
  protected readonly status = signal('');
  // A pesquisa e o estado filtram no servidor.
  protected readonly positions = rxResource({
    params: () => ({ q: this.query().trim(), status: this.status() }),
    stream: ({ params }) =>
      this.organization.listPositions({
        q: params.q || undefined,
        status: (params.status || undefined) as 'ACTIVE' | 'INACTIVE' | undefined,
      }),
  });
  private readonly reloads = signal(0);
  // Todos os cargos (sem filtro), para nomes e escolha do superior.
  private readonly all = rxResource({
    params: () => this.reloads(),
    stream: () => this.organization.listPositions({}),
  });

  protected readonly editorOpen = signal(false);
  protected readonly editing = signal<PositionDto | null>(null);
  protected readonly draft = signal<Draft>(EMPTY);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly departmentOptions = computed<readonly SelectOption[]>(() =>
    this.units()
      .filter((u) => DEPARTMENT_TYPES.has(u.type))
      .map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` })),
  );
  protected readonly parentOptions = computed<readonly SelectOption[]>(() =>
    (this.all.hasValue() ? this.all.value() : [])
      .filter((p) => p.id !== this.editing()?.id && p.status === 'ACTIVE')
      .map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
  );

  protected describe(error: unknown): string {
    return detailedErrorMessage(error, 'Pedido falhado.');
  }

  protected unitName(id: string | null): string {
    if (!id) return '—';
    return this.units().find((u) => u.id === id)?.name ?? '—';
  }

  protected positionCode(id: string | null): string {
    if (!id) return '—';
    return (this.all.hasValue() ? this.all.value() : []).find((p) => p.id === id)?.code ?? '—';
  }

  protected patch(key: keyof Draft, value: string | null): void {
    this.draft.update((d) => ({ ...d, [key]: value ?? '' }));
  }

  protected openEditor(position: PositionDto | null): void {
    this.formError.set(null);
    this.editing.set(position);
    this.draft.set(
      position
        ? {
            code: position.code,
            name: position.name,
            departmentId: position.departmentId ?? '',
            parentId: position.parentId ?? '',
            hierarchyLevel: position.hierarchyLevel?.toString() ?? '',
            jobFamily: position.jobFamily ?? '',
            category: position.category ?? '',
            description: position.description ?? '',
            responsibilities: position.responsibilities ?? '',
            competencies: position.competencies.join('\n'),
            academicRequirements: position.academicRequirements ?? '',
            recommendedExperience: position.recommendedExperience ?? '',
          }
        : EMPTY,
    );
    this.editorOpen.set(true);
  }

  protected save(): void {
    const { body, error } = positionBody(this.draft());
    const current = this.editing();
    if (!current && !this.draft().code.trim()) {
      this.formError.set('Indique o código do cargo.');
      return;
    }
    if (error) {
      this.formError.set(error);
      return;
    }
    const call = current
      ? this.organization.updatePosition(current, body)
      : this.organization.createPosition({
          ...body,
          code: this.draft().code.trim(),
          name: body.name as string,
        });
    this.run(call, this.formError, () => this.editorOpen.set(false));
  }

  protected toggle(position: PositionDto): void {
    this.run(
      this.organization.updatePosition(position, {
        status: position.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      }),
      this.error,
    );
  }

  private run(
    call: Observable<unknown>,
    target: WritableSignal<string | null>,
    done?: () => void,
  ): void {
    target.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        this.positions.reload();
        this.reloads.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        target.set(detailedErrorMessage(e, 'Não foi possível concluir a operação.'));
        this.positions.reload();
      },
    });
  }
}
