import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormActionBar } from '../ui/form-action-bar';
import { FormsModule } from '@angular/forms';
import { type Draft, Drafts } from '../core/drafts';
import { EntityFormPage } from '../ui/templates';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  ORG_KINDS,
  ORG_SECTIONS,
  type OrgField,
  type OrgRecord,
  payloadFor,
  recordLabel,
  sectionOf,
} from './org-kinds';
import type { Member } from './rbac-types';

interface Dependent {
  label: string;
  count: number;
}

/**
 * Criar (`:id = novo`, EntityCreatePage com rascunho local) ou ver/alterar (EntityDetailPage) um registo organizacional,
 * com anexos e histórico.
 */
@Component({
  selector: 'app-organization-form',
  imports: [
    FormActionBar,
    FormsModule,
    RouterLink,
    PageDetail,
    EntityFormPage,
    NgTemplateOutlet,
    ErrorAlert,
    ErrorState,
    Skeleton,
    FormSection,
    FormField,
    FieldControl,
    Attachments,
    AuditHistory,
  ],
  template: `
    @if (meta(); as k) {
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="reload()" />
      } @else if (isNew()) {
        <app-entity-form-page
          [title]="'Criar ' + k.singular"
          subtitle="Os campos com * são obrigatórios. O rascunho fica guardado neste browser até criar."
          formId="org-form"
          [loading]="!loaded()"
          [saveError]="action.error()"
          [busy]="action.busy()"
          [dirty]="hasUnsavedChanges()"
          saveLabel="Criar"
          [draftSavedAt]="draft()?.savedAt ?? null"
          (save)="save()"
          (cancelled)="cancel()"
          (restoreDraft)="restoreDraft()"
          (discardDraft)="discardDraft()"
          (input)="queueDraft()"
          (change)="queueDraft()"
        >
          <ng-container *ngTemplateOutlet="fieldsTpl" />
        </app-entity-form-page>
      } @else if (!loaded()) {
        <div class="card"><app-skeleton /></div>
      } @else {
        <app-page-detail [title]="title() ?? k.singular" [status]="$any(record()?.['status'])">
          <ng-container actions>
            <a class="btn-secondary" [routerLink]="['/organizacao', k.segment]">Voltar à lista</a>
          </ng-container>
          <form id="org-form" class="space-y-4" (ngSubmit)="save()" novalidate>
            <app-error-alert [error]="action.error()" [showDetails]="false" />
            <ng-container *ngTemplateOutlet="fieldsTpl" />
            @if (canManage()) {
              <app-form-action-bar
                formId="org-form"
                [dirty]="hasUnsavedChanges()"
                [busy]="action.busy()"
                [saveLabel]="'Guardar alterações'"
              />
            }
          </form>
          <div aside>
            @if (!isNew() && record(); as r) {
              @if (dependents().length > 0) {
                <section class="card" aria-labelledby="deps-title">
                  <h2 id="deps-title" class="font-semibold">Dependências activas</h2>
                  <p class="mt-1 text-xs text-muted">
                    Só se pode inactivar quando não houver dependências activas.
                  </p>
                  <ul class="mt-2 space-y-1 text-sm" data-testid="dependents">
                    @for (d of dependents(); track d.label) {
                      <li class="flex justify-between gap-2">
                        <span>{{ d.label }}</span>
                        <span class="badge" [class.bg-surface-2]="d.count === 0">{{
                          d.count
                        }}</span>
                      </li>
                    }
                  </ul>
                </section>
              }
              <app-attachments
                [subjectType]="k.entityType"
                [subjectId]="r.id"
                [canWrite]="canManage() && workspace.has('attachments.storage_mb')"
              />
              <app-audit-history
                [entityType]="k.entityType"
                [entityId]="r.id"
                [refreshKey]="r.version"
              />
            }
          </div>
        </app-page-detail>
      }
    }
    <ng-template #fieldsTpl>
      @for (section of sections; track section.id) {
        @if (fieldsOf(section.id).length > 0) {
          <app-form-section [title]="section.title" [description]="section.description">
            @for (f of fieldsOf(section.id); track f.key) {
              <app-field
                [label]="f.label"
                [required]="!!f.required"
                [hint]="
                  isNew()
                    ? (f.hint ?? null)
                    : f.immutable
                      ? 'Não se altera depois de criado.'
                      : null
                "
                [error]="action.field(f.key)"
                [class.md:col-span-2]="f.type === 'textarea'"
              >
                @switch (f.type) {
                  @case ('select') {
                    <select
                      appControl
                      class="input"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    >
                      @if (!f.required && f.key !== 'status') {
                        <option [ngValue]="null">—</option>
                      }
                      @for (o of f.options; track o.value) {
                        <option [ngValue]="o.value">{{ o.label }}</option>
                      }
                    </select>
                  }
                  @case ('boolean') {
                    <select
                      appControl
                      class="input"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    >
                      <option [ngValue]="null">—</option>
                      <option [ngValue]="true">Sim</option>
                      <option [ngValue]="false">Não</option>
                    </select>
                  }
                  @case ('member') {
                    <select
                      appControl
                      class="input"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    >
                      <option [ngValue]="null">—</option>
                      @for (m of memberOptions(f); track m.id) {
                        <option [ngValue]="m.id">{{ m.label }}</option>
                      }
                    </select>
                  }
                  @case ('ref') {
                    <select
                      appControl
                      class="input"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    >
                      <option [ngValue]="null">—</option>
                      @for (o of options(f); track o.id) {
                        <option [ngValue]="o.id">{{ o.label }}</option>
                      }
                    </select>
                  }
                  @case ('textarea') {
                    <textarea
                      appControl
                      class="input"
                      rows="3"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    ></textarea>
                  }
                  @case ('date') {
                    <input
                      appControl
                      type="date"
                      class="input"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    />
                  }
                  @case ('number') {
                    <input
                      appControl
                      type="number"
                      class="input"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    />
                  }
                  @default {
                    <input
                      appControl
                      [type]="
                        f.type === 'email' || f.type === 'tel' || f.type === 'url' ? f.type : 'text'
                      "
                      class="input"
                      [name]="f.key"
                      [disabled]="readonly(f)"
                      [(ngModel)]="form[f.key]"
                    />
                  }
                }
              </app-field>
            }
          </app-form-section>
        }
      }
    </ng-template>
  `,
})
export class OrganizationForm implements HasUnsavedChanges {
  readonly kind = input.required<string>();
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly workspace = inject(Workspace);
  protected readonly sections = ORG_SECTIONS;
  protected readonly meta = computed(() => ORG_KINDS[this.kind()] ?? null);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly canManage = computed(() => this.workspace.can('organization.manage'));
  protected readonly record = signal<OrgRecord | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly refs = signal<Record<string, OrgRecord[]>>({});
  protected readonly members = signal<{ id: string; label: string }[]>([]);
  protected readonly dependents = signal<Dependent[]>([]);
  protected readonly title = computed(() => (this.record() ? recordLabel(this.record()!) : null));
  protected readonly action = new Action();
  protected form: Record<string, unknown> = {};
  private initial = '';
  private readonly drafts = inject(Drafts);
  protected readonly draft = signal<Draft<Record<string, unknown>> | null>(null);
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly draftName = computed(() => `organization-new-${this.kind()}`);

  constructor() {
    warnOnUnload(this);
    inject(DestroyRef).onDestroy(() => this.draftTimer && clearTimeout(this.draftTimer));
    effect(() => {
      const kind = this.kind();
      const id = this.id();
      untracked(() => void this.load(kind, id));
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.canManage() && snapshot(this.form) !== this.initial;
  }

  protected reload() {
    void this.load(this.kind(), this.id());
  }

  private async load(kind: string, id: string) {
    const meta = ORG_KINDS[kind];
    if (!meta) return;
    this.loaded.set(false);
    this.loadError.set(null);
    try {
      const refKinds = [...new Set(meta.fields.filter((f) => f.ref).map((f) => f.ref!))];
      const pages = await Promise.all(
        refKinds.map((r) => this.api.page<OrgRecord>(`organization/${r}`, { limit: 200 })),
      );
      this.refs.set(Object.fromEntries(refKinds.map((r, i) => [r, pages[i].items])));
      if (meta.fields.some((f) => f.type === 'member') && this.workspace.can('members.read'))
        this.members.set(
          (await this.api.page<Member>('members', { status: 'ACTIVE', limit: 100 })).items.map(
            (m) => ({ id: m.id, label: `${m.fullName} (${m.email})` }),
          ),
        );
      this.dependents.set([]);
      if (id === 'novo') {
        this.record.set(null);
        const legalEntityId = meta.fields.some((f) => f.key === 'legalEntityId')
          ? this.workspace.legalEntityId()
          : null;
        const branchId = meta.fields.some((f) => f.key === 'branchId')
          ? this.workspace.branchId()
          : null;
        this.form = {
          status: 'ACTIVE',
          ...(kind === 'branches' ? { type: 'BRANCH' } : {}),
          ...(legalEntityId ? { legalEntityId } : {}),
          ...(branchId ? { branchId } : {}),
        };
      } else {
        const record = await this.api.get<OrgRecord>(`organization/${kind}/${id}`);
        this.record.set(record);
        this.form = { ...record };
        this.breadcrumbs.setCurrent(recordLabel(record));
        void this.loadDependents(kind, id);
      }
      this.initial = snapshot(this.form);
      this.loaded.set(true);
      if (id === 'novo') {
        const d = this.drafts.read<Record<string, unknown>>(this.draftName());
        this.draft.set(d && snapshot(d.value) !== this.initial ? d : null);
      } else this.draft.set(null);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async loadDependents(kind: string, id: string) {
    try {
      this.dependents.set(await this.api.get<Dependent[]>(`organization/${kind}/${id}/dependents`));
    } catch {
      this.dependents.set([]);
    }
  }

  /** Membros activos; se o responsável actual já não estiver na lista (ou não houver permissão), mantém-se a opção. */
  protected memberOptions(f: OrgField) {
    const current = this.form[f.key] as string | null | undefined;
    const list = this.members();
    return current && !list.some((m) => m.id === current)
      ? [...list, { id: current, label: 'Responsável actual' }]
      : list;
  }

  /** Rascunho do registo novo 1 s depois da última alteração (só neste browser, por utilizador e empresa). */
  protected queueDraft() {
    if (!this.isNew()) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      if (this.hasUnsavedChanges()) this.drafts.write(this.draftName(), this.form);
    }, 1000);
  }

  protected restoreDraft() {
    const d = this.draft();
    if (d) this.form = { ...this.form, ...d.value };
    this.draft.set(null);
  }

  protected discardDraft() {
    this.drafts.clear(this.draftName());
    this.draft.set(null);
  }

  protected cancel() {
    void this.router.navigate(['/organizacao', this.meta()!.segment]);
  }

  protected fieldsOf(section: string) {
    return (this.meta()?.fields ?? []).filter((f) => sectionOf(f) === section);
  }

  protected readonly = (f: OrgField) =>
    !this.canManage() || (!this.isNew() && f.immutable === true);

  /** Opções de um campo de referência; exclui o próprio registo e, quando aplicável, outras entidades legais. */
  protected options(f: OrgField) {
    const legalEntityId = this.form['legalEntityId'];
    return (this.refs()[f.ref!] ?? [])
      .filter((r) => r.id !== this.record()?.id)
      .filter(
        (r) => !legalEntityId || !('legalEntityId' in r) || r['legalEntityId'] === legalEntityId,
      )
      .map((r) => ({ id: r.id, label: recordLabel(r) }));
  }

  protected async save() {
    if (this.action.busy()) return;
    const meta = this.meta()!;
    const original = this.record();
    const body = payloadFor(meta, this.form, original);
    if (original && Object.keys(body).length === 0) {
      this.toasts.show('Nada para guardar.', 'info');
      return;
    }
    const result = await this.action.run(() =>
      original
        ? this.api.patch<OrgRecord>(`organization/${meta.segment}/${original.id}`, {
            ...body,
            expectedVersion: original.version,
          })
        : this.api.post<OrgRecord>(`organization/${meta.segment}`, body),
    );
    if (!result) {
      if (original && this.action.error()?.code === 'HAS_ACTIVE_DEPENDENTS')
        void this.loadDependents(meta.segment, original.id);
      if (this.action.error()?.code === 'VERSION_CONFLICT')
        this.toasts.show(
          'Outra pessoa alterou este registo. Recarregue para ver a versão actual.',
          'error',
          0,
        );
      return;
    }
    this.workspace.invalidate('names:');
    this.workspace.invalidate('scope:');
    this.initial = snapshot({ ...result });
    if (!original) {
      this.drafts.clear(this.draftName());
      this.draft.set(null);
      this.form = { ...result };
      this.toasts.show(`${meta.singular[0].toUpperCase()}${meta.singular.slice(1)} criada.`);
      await this.router.navigate(['/organizacao', meta.segment, result.id]);
      return;
    }
    this.record.set(result);
    this.form = { ...result };
    this.breadcrumbs.setCurrent(recordLabel(result));
    void this.loadDependents(meta.segment, result.id);
    this.toasts.show('Alterações guardadas.');
  }
}
