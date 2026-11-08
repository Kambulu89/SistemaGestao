import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { OnboardingCard } from './onboarding-card';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { FormActionBar } from '../ui/form-action-bar';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type Employee,
  EMPLOYEE_SECTIONS,
  EMPLOYEE_STATUS,
  type EmployeeField,
  type EmployeeSection,
  employeePayload,
  type RefKind,
} from './model';

interface Option {
  id: string;
  label: string;
  legalEntityId?: string | null;
  departmentId?: string | null;
}

/**
 * Ficha do colaborador: criar (EntityCreatePage) ou ver/alterar (EntityDetailPage com barra de acções fixa). Os dados
 * pessoais só aparecem a quem a API devolve `sensitiveVisible`; quem não os vê não os pode enviar. Sem rascunho local:
 * dados pessoais não ficam guardados no browser.
 */
@Component({
  selector: 'app-employee-form',
  imports: [
    FormsModule,
    RouterLink,
    NgTemplateOutlet,
    PageDetail,
    EntityFormPage,
    FormSection,
    FormField,
    FieldControl,
    FormActionBar,
    FieldList,
    Attachments,
    AuditHistory,
    OnboardingCard,
    ErrorState,
    Skeleton,
    Icon,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (isNew()) {
      <app-entity-form-page
        title="Novo colaborador"
        subtitle="O colaborador não precisa de conta de utilizador. Os campos com * são obrigatórios."
        formId="emp-form"
        [loading]="!loaded()"
        [saveError]="action.error()"
        [busy]="action.busy()"
        [dirty]="hasUnsavedChanges()"
        saveLabel="Criar colaborador"
        (save)="save()"
        (cancelled)="cancel()"
      >
        <ng-container *ngTemplateOutlet="sectionsTpl; context: { $implicit: visibleSections() }" />
      </app-entity-form-page>
    } @else if (!loaded() || !record()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let e = record()!;
      <app-page-detail [title]="e.fullName" [subtitle]="subtitle()" [status]="e.status">
        <ng-container actions>
          <a class="btn-secondary" routerLink="/rh/colaboradores">Voltar à lista</a>
          @if (canManage() && e.status === 'ACTIVE') {
            <button type="button" class="btn-secondary" (click)="changeStatus('SUSPENDED')">
              Suspender
            </button>
          }
          @if (canManage() && e.status === 'SUSPENDED') {
            <button type="button" class="btn-secondary" (click)="changeStatus('ACTIVE')">
              Reactivar
            </button>
          }
        </ng-container>
        <form id="emp-form" class="space-y-4" (ngSubmit)="save()" novalidate>
          <ng-container
            *ngTemplateOutlet="sectionsTpl; context: { $implicit: visibleSections() }"
          />
          @if (!e.sensitiveVisible) {
            <section class="card" aria-labelledby="emp-reserved" data-testid="emp-reserved">
              <h2 id="emp-reserved" class="flex items-center gap-2 font-semibold">
                <app-icon name="lock" [size]="16" /> Dados pessoais reservados
              </h2>
              <p class="mt-1 text-sm text-muted">
                Documentos, NIF, segurança social, morada, contactos pessoais e dados bancários só
                aparecem a quem tem acesso a dados pessoais deste colaborador.
              </p>
            </section>
          }
          @if (canManage()) {
            <app-form-action-bar
              formId="emp-form"
              [dirty]="hasUnsavedChanges()"
              [busy]="action.busy()"
            />
          }
        </form>
        <div aside>
          <section class="card" aria-labelledby="emp-summary">
            <h2 id="emp-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                { label: 'Entidade legal', value: e.legalEntity.code + ' — ' + e.legalEntity.name },
                { label: 'Admissão', value: date(e.hireDate) },
                { label: 'Superior', value: e.manager?.fullName },
                { label: 'Subordinados directos', value: e.directReports ?? 0 },
                { label: 'Estado', value: statusLabel(e.status) },
              ]"
            />
          </section>
          @if (e.access?.sensitive) {
            <app-attachments
              subjectType="employee"
              [subjectId]="e.id"
              [canWrite]="canManage() && workspace.has('attachments.storage_mb')"
            />
          }
          <app-onboarding-card [employeeId]="e.id" />
          <app-audit-history entityType="employee" [entityId]="e.id" [refreshKey]="e.version" />
        </div>
      </app-page-detail>
    }

    <ng-template #sectionsTpl let-sections>
      @for (section of sections; track section.id) {
        <app-form-section [title]="section.title" [description]="section.description">
          @for (f of section.fields; track f.key) {
            <app-field
              [label]="f.label"
              [required]="!!f.required"
              [hint]="f.hint ?? null"
              [error]="action.field(f.key)"
            >
              @if (f.type === 'select' || f.type === 'ref') {
                <select
                  appControl
                  class="input"
                  [attr.data-field]="f.key"
                  [disabled]="readonly()"
                  [ngModel]="form[f.key] ?? null"
                  [ngModelOptions]="{ standalone: true }"
                  (ngModelChange)="setField(f.key, $event)"
                >
                  @if (!f.required) {
                    <option [ngValue]="null">—</option>
                  }
                  @for (o of optionsFor(f); track o.id) {
                    <option [ngValue]="o.id">{{ o.label }}</option>
                  }
                </select>
              } @else {
                <input
                  appControl
                  class="input"
                  [attr.data-field]="f.key"
                  [type]="f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'"
                  [disabled]="readonly()"
                  [ngModel]="form[f.key] ?? ''"
                  [ngModelOptions]="{ standalone: true }"
                  (ngModelChange)="setField(f.key, $event)"
                />
              }
            </app-field>
          }
        </app-form-section>
      }
    </ng-template>
  `,
})
export class EmployeeForm implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly workspace = inject(Workspace);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly record = signal<Employee | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly date = formatDate;
  protected readonly statusLabel = (s: keyof typeof EMPLOYEE_STATUS) => EMPLOYEE_STATUS[s];
  private readonly refs = signal<Record<RefKind, Option[]>>({
    legalEntities: [],
    branches: [],
    departments: [],
    positions: [],
    costCenters: [],
    employees: [],
    members: [],
  });
  /** Versão do formulário (o objecto `form` é editado directamente; isto força a recomputação). */
  private readonly tick = signal(0);
  protected form: Record<string, unknown> = {};
  private initial = '';

  protected readonly canManage = computed(() =>
    this.isNew() ? this.workspace.canAny('hr.manage') : !!this.record()?.access?.manage,
  );
  protected readonly readonly = computed(() => !this.canManage());
  private readonly sensitiveAllowed = computed(() =>
    this.isNew() ? this.workspace.canAny('hr.sensitive') : !!this.record()?.sensitiveVisible,
  );
  protected readonly visibleSections = computed<EmployeeSection[]>(() =>
    EMPLOYEE_SECTIONS.filter((s) => !s.sensitive || this.sensitiveAllowed()),
  );
  protected readonly subtitle = computed(() => {
    const e = this.record();
    if (!e) return null;
    return [e.code, e.positionName, e.departmentName].filter(Boolean).join(' · ');
  });

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  hasUnsavedChanges() {
    this.tick();
    return this.loaded() && this.canManage() && snapshot(this.form) !== this.initial;
  }

  protected reload() {
    void this.load(this.id());
  }

  protected setField(key: string, value: unknown) {
    this.form = { ...this.form, [key]: value };
    // Mudar de entidade legal limpa o que é da entidade anterior.
    if (key === 'legalEntityId')
      for (const k of ['branchId', 'departmentId', 'positionId', 'costCenterId'])
        this.form[k] = null;
    if (key === 'departmentId') this.form['positionId'] = null;
    this.tick.update((n) => n + 1);
  }

  /** Opções de cada referência, filtradas pela entidade (e o cargo pelo departamento). */
  protected optionsFor(f: EmployeeField): Option[] {
    this.tick();
    if (f.options) return f.options.map((o) => ({ id: o.value, label: o.label }));
    const all = this.refs()[f.ref!] ?? [];
    const le = this.form['legalEntityId'] as string | null;
    const dept = this.form['departmentId'] as string | null;
    let list = all;
    if (['branches', 'departments', 'costCenters'].includes(f.ref!))
      list = all.filter((o) => !le || o.legalEntityId === le);
    if (f.ref === 'positions')
      list = all.filter((o) => !o.departmentId || !dept || o.departmentId === dept);
    if (f.ref === 'employees') list = all.filter((o) => o.id !== this.record()?.id);
    // O valor actual aparece sempre (mesmo fora do filtro), para não se perder sem querer.
    const current = this.form[f.key] as string | null;
    if (current && !list.some((o) => o.id === current)) {
      const known = all.find((o) => o.id === current);
      list = [...list, known ?? { id: current, label: 'Valor actual' }];
    }
    return list;
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set(null);
    try {
      await this.loadRefs();
      if (id === 'novo') {
        this.record.set(null);
        this.form = { legalEntityId: this.workspace.legalEntityId() ?? null };
      } else {
        this.apply(await this.api.get<Employee>(`hr/employees/${id}`));
      }
      this.initial = snapshot(this.form);
      this.loaded.set(true);
      this.tick.update((n) => n + 1);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(e: Employee) {
    this.record.set(e);
    this.breadcrumbs.setCurrent(e.fullName);
    this.form = { ...e };
  }

  private async loadRefs() {
    const page = async <T>(url: string, query: Record<string, unknown>, map: (r: T) => Option) => {
      try {
        return (await this.api.page<T>(url, query as never)).items.map(map);
      } catch {
        return [];
      }
    };
    interface Org {
      id: string;
      code: string;
      name?: string;
      legalName?: string;
      legalEntityId?: string;
      departmentId?: string | null;
    }
    const orgLabel = (r: Org): Option => ({
      id: r.id,
      label: `${r.code} — ${r.name ?? r.legalName ?? ''}`,
      legalEntityId: r.legalEntityId ?? null,
      departmentId: r.departmentId ?? null,
    });
    const canOrg = this.workspace.can('organization.read');
    const [legalEntities, branches, departments, positions, costCenters, employees, members] =
      await Promise.all([
        canOrg ? page<Org>('organization/legal-entities', { limit: 200 }, orgLabel) : [],
        canOrg ? page<Org>('organization/branches', { limit: 200 }, orgLabel) : [],
        canOrg ? page<Org>('organization/departments', { limit: 200 }, orgLabel) : [],
        canOrg ? page<Org>('organization/positions', { limit: 200 }, orgLabel) : [],
        canOrg ? page<Org>('organization/cost-centers', { limit: 200 }, orgLabel) : [],
        page<Employee>('hr/employees', { limit: 200, status: 'ACTIVE' }, (e) => ({
          id: e.id,
          label: `${e.code} — ${e.fullName}`,
        })),
        this.workspace.can('members.read')
          ? page<{ id: string; fullName: string | null; email: string }>(
              'members',
              { status: 'ACTIVE', limit: 100 },
              (m) => ({ id: m.id, label: m.fullName ? `${m.fullName} (${m.email})` : m.email }),
            )
          : [],
      ]);
    this.refs.set({
      legalEntities,
      branches,
      departments,
      positions,
      costCenters,
      employees,
      members,
    });
  }

  protected cancel() {
    void this.router.navigate(['/rh/colaboradores']);
  }

  protected async save() {
    if (this.action.busy() || !this.canManage()) return;
    const original = this.record();
    const body = employeePayload(this.form, original, this.sensitiveAllowed());
    if (original && Object.keys(body).length === 0) {
      this.toasts.show('Nada para guardar.', 'info');
      return;
    }
    const result = await this.action.run(() =>
      original
        ? this.api.patch<Employee>(`hr/employees/${original.id}`, {
            ...body,
            expectedVersion: original.version,
          })
        : this.api.post<Employee>('hr/employees', body),
    );
    if (!result) {
      if (this.action.error()?.code === 'VERSION_CONFLICT')
        this.toasts.show(
          'Outra pessoa alterou esta ficha. Recarregue para ver a versão actual.',
          'error',
          0,
        );
      return;
    }
    if (!original) {
      this.initial = snapshot(this.form);
      this.toasts.show('Colaborador criado.');
      await this.router.navigate(['/rh/colaboradores', result.id]);
      return;
    }
    await this.load(original.id);
    this.toasts.show('Ficha actualizada.');
  }

  protected async changeStatus(status: 'ACTIVE' | 'SUSPENDED') {
    const e = this.record()!;
    const ok = await this.confirm.ask({
      title: status === 'SUSPENDED' ? 'Suspender colaborador' : 'Reactivar colaborador',
      message:
        status === 'SUSPENDED'
          ? `Suspender ${e.fullName}? A ficha mantém-se e pode ser reactivada.`
          : `Reactivar ${e.fullName}?`,
      confirmLabel: status === 'SUSPENDED' ? 'Suspender' : 'Reactivar',
      danger: status === 'SUSPENDED',
    });
    if (!ok) return;
    const result = await this.action.run(() =>
      this.api.post<Employee>(`hr/employees/${e.id}/status`, {
        status,
        expectedVersion: e.version,
      }),
    );
    if (!result) return;
    await this.load(e.id);
    this.toasts.show(status === 'SUSPENDED' ? 'Colaborador suspenso.' : 'Colaborador reactivado.');
  }
}
