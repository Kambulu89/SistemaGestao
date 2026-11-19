import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ToastService } from '../ui/toasts';
import { ASSIGNMENT_KIND, type Assignment, periodLabel } from './contracts-model';

interface Option {
  id: string;
  label: string;
  legalEntityId?: string | null;
  departmentId?: string | null;
}

/**
 * Carreira na ficha do colaborador: histórico da colocação com vigência e registo de movimentos (transferência,
 * promoção, alteração) com data de efeito e motivo. A ficha não muda a colocação directamente.
 */
@Component({
  selector: 'app-career-card',
  imports: [FormsModule, FormField, FieldControl, Modal, ErrorAlert, Icon],
  template: `
    @if (items(); as list) {
      <section class="card" aria-labelledby="career-title" data-testid="career">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="career-title" class="font-semibold">Carreira</h2>
          @if (canManage() && active()) {
            <button type="button" class="btn-secondary" data-testid="new-movement" (click)="open()">
              <app-icon name="plus" [size]="16" />Registar movimento
            </button>
          }
        </div>
        <ol class="space-y-3 border-l border-border pl-4 text-sm">
          @for (a of list; track a.id) {
            <li data-testid="assignment">
              <p class="font-medium">{{ kind(a.kind) }} · {{ period(a) }}</p>
              <p class="text-muted">
                {{ placement(a) }}
                @if (a.managerName) {
                  · superior: {{ a.managerName }}
                }
                @if (a.costCenterCode) {
                  · {{ a.costCenterCode }}
                }
              </p>
              @if (a.reason) {
                <p class="text-xs text-muted">{{ a.reason }}</p>
              }
            </li>
          }
        </ol>
      </section>
    }

    <app-modal
      title="Registar movimento de carreira"
      [open]="opened()"
      (closed)="opened.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        O período actual fecha na véspera da data de efeito. A entidade legal não muda por
        movimento.
      </p>
      <div class="space-y-3">
        <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
          <select
            appControl
            class="input"
            data-testid="mv-kind"
            [(ngModel)]="form.kind"
            [ngModelOptions]="{ standalone: true }"
          >
            <option value="TRANSFER">Transferência</option>
            <option value="PROMOTION">Promoção</option>
            <option value="CHANGE">Alteração</option>
          </select>
        </app-field>
        <app-field
          label="Data de efeito"
          [required]="true"
          hint="Até hoje."
          [error]="action.field('effectiveDate')"
        >
          <input
            appControl
            class="input"
            type="date"
            data-testid="mv-date"
            [(ngModel)]="form.effectiveDate"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Filial" [error]="action.field('branchId')">
          <select
            appControl
            class="input"
            [ngModel]="form.branchId"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="form.branchId = $event"
          >
            <option [ngValue]="null">—</option>
            @for (o of byEntity(refs().branches); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Departamento" [error]="action.field('departmentId')">
          <select
            appControl
            class="input"
            data-testid="mv-department"
            [ngModel]="form.departmentId"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="setDepartment($event)"
          >
            <option [ngValue]="null">—</option>
            @for (o of byEntity(refs().departments); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Cargo" [error]="action.field('positionId')">
          <select
            appControl
            class="input"
            data-testid="mv-position"
            [ngModel]="form.positionId"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="form.positionId = $event"
          >
            <option [ngValue]="null">—</option>
            @for (o of positions(); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Superior hierárquico" [error]="action.field('managerId')">
          <select
            appControl
            class="input"
            [ngModel]="form.managerId"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="form.managerId = $event"
          >
            <option [ngValue]="null">—</option>
            @for (o of refs().employees; track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Centro de custo" [error]="action.field('costCenterId')">
          <select
            appControl
            class="input"
            [ngModel]="form.costCenterId"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="form.costCenterId = $event"
          >
            <option [ngValue]="null">—</option>
            @for (o of byEntity(refs().costCenters); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Motivo" [required]="true" [error]="action.field('reason')">
          <textarea
            appControl
            class="input min-h-20"
            data-testid="mv-reason"
            [(ngModel)]="form.reason"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="mv-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class CareerCard {
  readonly employeeId = input.required<string>();
  readonly employeeVersion = input.required<number>();
  readonly legalEntityId = input.required<string>();
  readonly active = input(true);
  /** O movimento muda a colocação (e a versão) da ficha: quem a mostra recarrega. */
  readonly moved = output<void>();
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly items = signal<Assignment[] | null>(null);
  protected readonly canManage = signal(false);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly kind = (k: Assignment['kind']) => ASSIGNMENT_KIND[k];
  protected readonly period = (a: Assignment) => periodLabel(a, formatDate);
  protected readonly placement = (a: Assignment) =>
    [a.positionName, a.departmentName, a.branchName].filter(Boolean).join(' · ') ||
    'Sem cargo nem departamento';
  protected readonly refs = signal<
    Record<'branches' | 'departments' | 'positions' | 'costCenters' | 'employees', Option[]>
  >({
    branches: [],
    departments: [],
    positions: [],
    costCenters: [],
    employees: [],
  });
  private readonly tick = signal(0);
  protected form = this.empty();
  protected readonly positions = computed(() => {
    this.tick();
    const dept = this.form.departmentId;
    return this.refs().positions.filter((o) => !dept || !o.departmentId || o.departmentId === dept);
  });

  constructor() {
    effect(() => {
      const id = this.employeeId();
      this.employeeVersion();
      untracked(() => void this.load(id));
    });
  }

  private empty() {
    return {
      kind: 'TRANSFER',
      effectiveDate: new Date().toISOString().slice(0, 10),
      branchId: null as string | null,
      departmentId: null as string | null,
      positionId: null as string | null,
      managerId: null as string | null,
      costCenterId: null as string | null,
      reason: '',
    };
  }

  private async load(id: string) {
    try {
      const r = await this.api.get<{ items: Assignment[]; canManage: boolean }>(
        `hr/employees/${id}/assignments`,
      );
      this.items.set(r.items);
      this.canManage.set(r.canManage);
    } catch {
      this.items.set(null);
    }
  }

  protected byEntity(list: Option[]) {
    return list.filter((o) => !o.legalEntityId || o.legalEntityId === this.legalEntityId());
  }

  protected setDepartment(id: string | null) {
    this.form.departmentId = id;
    this.form.positionId = null;
    this.tick.update((n) => n + 1);
  }

  protected async open() {
    const current = this.items()?.find((a) => a.validTo === null);
    this.form = {
      ...this.empty(),
      ...(current
        ? {
            branchId: current.branchId,
            departmentId: current.departmentId,
            positionId: current.positionId,
            managerId: current.managerId,
            costCenterId: current.costCenterId,
          }
        : {}),
    };
    this.action.error.set(null);
    await this.loadRefs();
    this.tick.update((n) => n + 1);
    this.opened.set(true);
  }

  private async loadRefs() {
    if (this.refs().departments.length) return;
    interface Org {
      id: string;
      code: string;
      name?: string;
      fullName?: string;
      legalEntityId?: string;
      departmentId?: string | null;
    }
    const page = async (url: string, query: Record<string, unknown> = {}) => {
      try {
        return (await this.api.page<Org>(url, { limit: 200, ...query } as never)).items.map(
          (r) => ({
            id: r.id,
            label: `${r.code} — ${r.name ?? r.fullName ?? ''}`,
            legalEntityId: r.legalEntityId ?? null,
            departmentId: r.departmentId ?? null,
          }),
        );
      } catch {
        return [];
      }
    };
    const org = this.workspace.can('organization.read');
    const [branches, departments, positions, costCenters, employees] = await Promise.all([
      org ? page('organization/branches') : [],
      org ? page('organization/departments') : [],
      org ? page('organization/positions') : [],
      org ? page('organization/cost-centers') : [],
      page('hr/employees', { status: 'ACTIVE' }),
    ]);
    this.refs.set({
      branches,
      departments,
      positions,
      costCenters,
      employees: employees.filter((e) => e.id !== this.employeeId()),
    });
  }

  protected async save() {
    const f = this.form;
    const done = await this.action.run(() =>
      this.api.post(`hr/employees/${this.employeeId()}/assignments`, {
        kind: f.kind,
        effectiveDate: f.effectiveDate,
        branchId: f.branchId,
        departmentId: f.departmentId,
        positionId: f.positionId,
        managerId: f.managerId,
        costCenterId: f.costCenterId,
        reason: f.reason,
        expectedVersion: this.employeeVersion(),
      }),
    );
    if (!done) return;
    this.opened.set(false);
    this.toasts.show('Movimento registado.');
    this.moved.emit();
  }
}
