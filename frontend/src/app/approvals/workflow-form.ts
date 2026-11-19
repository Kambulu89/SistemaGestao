import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import type { Member, Role } from '../admin/rbac-types';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { Autocomplete, type Option } from '../ui/autocomplete';
import { ConfirmService } from '../ui/confirm';
import { ToastService } from '../ui/toasts';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import type { Step, Workflow } from './types';

type StepDraft = Omit<Step, 'sequence'>;

/** Tipos de assunto aprovados por workflow (os mesmos da API). */
export const SUBJECT_TYPE_LABELS: Record<string, string> = {
  manual: 'Pedido avulso',
  bank_account: 'Conta bancária da empresa',
  job_requisition: 'Vaga (requisição de pessoal)',
  job_offer: 'Proposta de contratação',
  compensation_proposal: 'Proposta de compensação',
};

const emptyStep = (): StepDraft => ({
  name: '',
  approverType: 'ROLE',
  approverRoleId: null,
  approverMembershipId: null,
  requiredApprovals: 1,
});

/** Editor de workflow: etapas ordenadas com aprovador por perfil ou membro; publicar e retirar. */
@Component({
  selector: 'app-workflow-form',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, StatusBadge, Autocomplete],
  template: `
    <app-page-header [title]="isNew() ? 'Novo workflow' : (workflow()?.name ?? 'Workflow')">
      <a routerLink="/aprovacoes/workflows" class="btn-secondary">Voltar</a>
    </app-page-header>
    <app-error-alert [error]="loadError()" />
    @if (ready()) {
      <form class="space-y-4" (ngSubmit)="save()" novalidate>
        <section class="card grid gap-4 md:grid-cols-3">
          <div class="md:col-span-3 flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm">
              Estado: <app-status-badge [status]="workflow()?.status ?? 'DRAFT'" />
            </p>
            @if (saved()) {
              <p class="text-sm text-success-text" role="status">Guardado.</p>
            }
          </div>
          <div class="md:col-span-3"><app-error-alert [error]="action.error()" /></div>
          <div>
            <label class="label" for="code">Código *</label>
            <input
              id="code"
              name="code"
              class="input font-mono uppercase"
              [disabled]="!isNew()"
              [(ngModel)]="code"
            />
          </div>
          <div class="md:col-span-2">
            <label class="label" for="name">Nome *</label>
            <input
              id="name"
              name="name"
              class="input"
              [disabled]="!editable()"
              [(ngModel)]="name"
            />
          </div>
          <div class="md:col-span-3">
            <label class="label" for="subjectType">Tipo de assunto *</label>
            <select
              id="subjectType"
              name="subjectType"
              class="input"
              [disabled]="!editable()"
              [(ngModel)]="subjectType"
            >
              @for (t of subjectTypes; track t[0]) {
                <option [ngValue]="t[0]">{{ t[1] }}</option>
              }
            </select>
            <p class="mt-1 text-xs text-muted">
              Pedidos avulsos ou registos de um módulo que os submete a aprovação (configurado nesse
              módulo).
            </p>
          </div>
          <div class="md:col-span-3">
            <label class="label" for="description">Descrição</label>
            <textarea
              id="description"
              name="description"
              rows="2"
              class="input"
              [disabled]="!editable()"
              [(ngModel)]="description"
            ></textarea>
          </div>
        </section>

        <section class="card">
          <h2 class="font-semibold">Etapas</h2>
          @if (!canPickRoles() || !canPickMembers()) {
            <p class="mt-1 text-xs text-muted">
              Para escolher aprovadores precisa de ver perfis (roles.read) e membros (members.read).
            </p>
          }
          <ol class="mt-3 space-y-3">
            @for (s of steps(); track $index; let i = $index) {
              <li class="grid gap-3 rounded-md border border-border p-3 md:grid-cols-5">
                <div class="md:col-span-2">
                  <label class="label" [for]="'step-name-' + i">{{ i + 1 }}. Nome da etapa</label>
                  <input
                    class="input"
                    [id]="'step-name-' + i"
                    [name]="'step-name-' + i"
                    [disabled]="!editable()"
                    [(ngModel)]="s.name"
                  />
                </div>
                <div>
                  <label class="label" [for]="'step-type-' + i">Aprovador</label>
                  <select
                    class="input"
                    [id]="'step-type-' + i"
                    [name]="'step-type-' + i"
                    [disabled]="!editable()"
                    [(ngModel)]="s.approverType"
                  >
                    <option value="ROLE">Perfil</option>
                    <option value="MEMBER">Membro</option>
                  </select>
                </div>
                <div>
                  @if (s.approverType === 'ROLE') {
                    <label class="label" [for]="'step-role-' + i">Perfil</label>
                    <select
                      class="input"
                      [id]="'step-role-' + i"
                      [name]="'step-role-' + i"
                      [disabled]="!editable()"
                      [(ngModel)]="s.approverRoleId"
                    >
                      <option [ngValue]="null">—</option>
                      @for (r of roles(); track r.id) {
                        <option [ngValue]="r.id">{{ r.name }}</option>
                      }
                    </select>
                  } @else {
                    <label class="label" [for]="'step-member-' + i">Membro</label>
                    <app-autocomplete
                      [inputId]="'step-member-' + i"
                      [name]="'step-member-' + i"
                      [search]="searchMembers"
                      [initialLabel]="memberName(s.approverMembershipId)"
                      [disabled]="!editable()"
                      [(ngModel)]="s.approverMembershipId"
                    />
                  }
                </div>
                <div>
                  <label class="label" [for]="'step-req-' + i">Aprovações</label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    class="input"
                    [id]="'step-req-' + i"
                    [name]="'step-req-' + i"
                    [disabled]="!editable() || s.approverType === 'MEMBER'"
                    [(ngModel)]="s.requiredApprovals"
                  />
                </div>
                @if (stepErrors(i).length > 0) {
                  <ul class="field-error md:col-span-5">
                    @for (m of stepErrors(i); track m) {
                      <li>{{ m }}</li>
                    }
                  </ul>
                }
                @if (editable()) {
                  <div class="flex gap-2 md:col-span-5">
                    <button
                      type="button"
                      class="btn-secondary"
                      [disabled]="i === 0"
                      (click)="move(i, -1)"
                    >
                      Subir
                    </button>
                    <button
                      type="button"
                      class="btn-secondary"
                      [disabled]="i === steps().length - 1"
                      (click)="move(i, 1)"
                    >
                      Descer
                    </button>
                    <button type="button" class="btn-secondary" (click)="removeStep(i)">
                      Remover
                    </button>
                  </div>
                }
              </li>
            }
          </ol>
          @if (editable()) {
            <button type="button" class="btn-secondary mt-3" (click)="addStep()">
              Adicionar etapa
            </button>
          }
        </section>

        <div class="flex flex-wrap gap-2">
          @if (editable()) {
            <button type="submit" class="btn-primary" [disabled]="action.busy()">
              {{ isNew() ? 'Criar rascunho' : 'Guardar rascunho' }}
            </button>
          }
          @if (workflow()?.status === 'DRAFT') {
            <button
              type="button"
              class="btn-primary"
              [disabled]="action.busy()"
              (click)="setStatus('publish')"
            >
              Publicar
            </button>
            <button type="button" class="btn-danger" [disabled]="action.busy()" (click)="remove()">
              Eliminar rascunho
            </button>
          }
          @if (workflow()?.status === 'ACTIVE') {
            <button
              type="button"
              class="btn-danger"
              [disabled]="action.busy()"
              (click)="setStatus('retire')"
            >
              Retirar
            </button>
          }
        </div>
      </form>
    }
  `,
})
export class WorkflowForm implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly workspace = inject(Workspace);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly workflow = signal<Workflow | null>(null);
  protected readonly editable = computed(() => this.isNew() || this.workflow()?.status === 'DRAFT');
  protected readonly canPickRoles = computed(() => this.workspace.can('roles.read'));
  protected readonly canPickMembers = computed(() => this.workspace.can('members.read'));
  protected readonly roles = signal<Role[]>([]);
  protected readonly members = signal<Member[]>([]);
  protected readonly steps = signal<StepDraft[]>([emptyStep()]);
  protected readonly ready = signal(false);
  protected readonly saved = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected code = '';
  protected name = '';
  protected description = '';
  protected subjectType = 'manual';
  protected readonly subjectTypes = Object.entries(SUBJECT_TYPE_LABELS);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private initial = '';

  hasUnsavedChanges() {
    return this.ready() && this.editable() && this.current() !== this.initial;
  }

  private current() {
    return snapshot({
      code: this.code,
      name: this.name,
      description: this.description,
      subjectType: this.subjectType,
      steps: this.steps(),
    });
  }

  /** Procura membros activos pela API (só com members.read). */
  protected readonly searchMembers = async (q: string): Promise<Option[]> =>
    (
      await this.api.page<Member>('members', { q: q || undefined, status: 'ACTIVE', limit: 10 })
    ).items.map((m) => ({
      id: m.id,
      label: m.fullName,
      hint: m.email,
    }));

  protected memberName(id: string | null) {
    return this.members().find((m) => m.id === id)?.fullName ?? null;
  }

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    this.ready.set(false);
    try {
      if (this.canPickRoles())
        this.roles.set((await this.api.get<Role[]>('roles')).filter((r) => r.status === 'ACTIVE'));
      if (this.canPickMembers())
        this.members.set(
          (await this.api.page<Member>('members', { status: 'ACTIVE', limit: 100 })).items,
        );
      if (id !== 'novo') this.apply(await this.api.get<Workflow>(`approvals/workflows/${id}`));
      this.initial = this.current();
      this.ready.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(w: Workflow) {
    this.workflow.set(w);
    this.breadcrumbs.setCurrent(w.name);
    this.code = w.code;
    this.name = w.name;
    this.description = w.description ?? '';
    this.subjectType = w.subjectType;
    this.steps.set(
      w.steps.map((s) => ({
        name: s.name,
        approverType: s.approverType,
        approverRoleId: s.approverRoleId,
        approverMembershipId: s.approverMembershipId,
        requiredApprovals: s.requiredApprovals,
      })),
    );
  }

  protected stepErrors(i: number) {
    return (this.action.error()?.details ?? [])
      .filter((d) => d.path.startsWith(`steps.${i}.`))
      .map((d) => d.message);
  }

  protected addStep() {
    this.steps.set([...this.steps(), emptyStep()]);
  }

  protected removeStep(i: number) {
    this.steps.set(this.steps().filter((_, j) => j !== i));
  }

  protected move(i: number, delta: number) {
    const next = [...this.steps()];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    this.steps.set(next);
  }

  private body() {
    return {
      name: this.name.trim(),
      description: this.description.trim() || null,
      subjectType: this.subjectType,
      steps: this.steps().map((s) => ({
        name: s.name.trim(),
        approverType: s.approverType,
        approverRoleId: s.approverType === 'ROLE' ? s.approverRoleId : null,
        approverMembershipId: s.approverType === 'MEMBER' ? s.approverMembershipId : null,
        requiredApprovals: s.approverType === 'MEMBER' ? 1 : Number(s.requiredApprovals),
      })),
    };
  }

  protected async save() {
    if (this.action.busy()) return;
    this.saved.set(false);
    const current = this.workflow();
    const result = await this.action.run(() =>
      current
        ? this.api.patch<Workflow>(`approvals/workflows/${current.id}`, {
            ...this.body(),
            expectedVersion: current.version,
          })
        : this.api.post<Workflow>('approvals/workflows', {
            ...this.body(),
            code: this.code.trim().toUpperCase(),
          }),
    );
    if (!result) return;
    if (!current) {
      this.initial = this.current();
      this.toasts.show('Rascunho criado.');
      await this.router.navigate(['/aprovacoes/workflows', result.id]);
      return;
    }
    this.apply(result);
    this.initial = this.current();
    this.toasts.show('Rascunho guardado.');
  }

  protected async setStatus(action: 'publish' | 'retire') {
    const current = this.workflow()!;
    if (this.hasUnsavedChanges()) {
      this.toasts.show('Guarde o rascunho antes de publicar.', 'info');
      return;
    }
    const ok = await this.confirm.ask(
      action === 'publish'
        ? {
            title: 'Publicar workflow',
            message: 'Depois de publicado não se altera; para mudar, retire-o e crie outro.',
            confirmLabel: 'Publicar',
          }
        : {
            title: 'Retirar workflow',
            message: 'Deixa de aceitar pedidos novos; os pendentes continuam.',
            confirmLabel: 'Retirar',
            danger: true,
          },
    );
    if (!ok) return;
    const result = await this.action.run(() =>
      this.api.post<Workflow>(`approvals/workflows/${current.id}/${action}`, {
        expectedVersion: current.version,
      }),
    );
    if (result) {
      this.apply(result);
      this.initial = this.current();
      this.toasts.show(action === 'publish' ? 'Workflow publicado.' : 'Workflow retirado.');
    }
  }

  protected async remove() {
    const ok = await this.confirm.ask({
      title: 'Eliminar rascunho',
      message: 'Eliminar este rascunho de workflow?',
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    this.initial = this.current();
    await this.action.run(() => this.api.delete(`approvals/workflows/${this.workflow()!.id}`));
    if (!this.action.error()) await this.router.navigateByUrl('/aprovacoes/workflows');
  }
}
