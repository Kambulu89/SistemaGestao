import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ORG_KINDS, type OrgField, type OrgRecord, payloadFor, recordLabel } from './org-kinds';

/** Criar (`:id = novo`) ou ver/alterar um registo organizacional. Inactivar em vez de eliminar. */
@Component({
  selector: 'app-organization-form',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, Attachments],
  template: `
    @if (meta(); as k) {
      <app-page-header [title]="isNew() ? 'Nova ' + k.singular : (title() ?? k.singular)">
        <a class="btn-secondary" [routerLink]="['/organizacao', k.segment]">Voltar à lista</a>
      </app-page-header>
      <app-error-alert [error]="loadError()" />
      @if (loaded()) {
        <form class="card grid gap-4 md:grid-cols-2" (ngSubmit)="save()" novalidate>
          <div class="md:col-span-2">
            <app-error-alert [error]="action.error()" [showDetails]="false" />
          </div>
          @if (saved()) {
            <p class="text-sm text-green-700 md:col-span-2" role="status">Guardado.</p>
          }
          @for (f of k.fields; track f.key) {
            <div [class.md:col-span-2]="f.type === 'textarea'">
              <label class="label" [for]="f.key">{{ f.label }}{{ f.required ? ' *' : '' }}</label>
              @switch (f.type) {
                @case ('select') {
                  <select
                    class="input"
                    [id]="f.key"
                    [name]="f.key"
                    [disabled]="readonly(f)"
                    [(ngModel)]="form[f.key]"
                    [attr.aria-invalid]="!!action.field(f.key)"
                  >
                    @if (!f.required && f.key !== 'status') {
                      <option [ngValue]="null">—</option>
                    }
                    @for (o of f.options; track o.value) {
                      <option [ngValue]="o.value">{{ o.label }}</option>
                    }
                  </select>
                }
                @case ('ref') {
                  <select
                    class="input"
                    [id]="f.key"
                    [name]="f.key"
                    [disabled]="readonly(f)"
                    [(ngModel)]="form[f.key]"
                    [attr.aria-invalid]="!!action.field(f.key)"
                  >
                    <option [ngValue]="null">—</option>
                    @for (o of options(f); track o.id) {
                      <option [ngValue]="o.id">{{ o.label }}</option>
                    }
                  </select>
                }
                @case ('textarea') {
                  <textarea
                    class="input"
                    rows="3"
                    [id]="f.key"
                    [name]="f.key"
                    [disabled]="readonly(f)"
                    [(ngModel)]="form[f.key]"
                    [attr.aria-invalid]="!!action.field(f.key)"
                  ></textarea>
                }
                @case ('date') {
                  <input
                    type="date"
                    class="input"
                    [id]="f.key"
                    [name]="f.key"
                    [disabled]="readonly(f)"
                    [(ngModel)]="form[f.key]"
                    [attr.aria-invalid]="!!action.field(f.key)"
                  />
                }
                @case ('number') {
                  <input
                    type="number"
                    class="input"
                    [id]="f.key"
                    [name]="f.key"
                    [disabled]="readonly(f)"
                    [(ngModel)]="form[f.key]"
                    [attr.aria-invalid]="!!action.field(f.key)"
                  />
                }
                @default {
                  <input
                    class="input"
                    [id]="f.key"
                    [name]="f.key"
                    [disabled]="readonly(f)"
                    [(ngModel)]="form[f.key]"
                    [attr.aria-invalid]="!!action.field(f.key)"
                  />
                }
              }
              @if (action.field(f.key); as message) {
                <p class="field-error">{{ message }}</p>
              } @else if (f.hint && isNew()) {
                <p class="mt-1 text-xs text-slate-500">{{ f.hint }}</p>
              }
            </div>
          }
          @if (canManage()) {
            <div class="md:col-span-2">
              <button type="submit" class="btn-primary" [disabled]="action.busy()">
                {{ isNew() ? 'Criar' : 'Guardar alterações' }}
              </button>
            </div>
          }
        </form>
        @if (!isNew() && record()) {
          <div class="mt-6">
            <app-attachments
              [subjectType]="k.entityType"
              [subjectId]="record()!.id"
              [canWrite]="canManage()"
            />
          </div>
        }
      }
    }
  `,
})
export class OrganizationForm {
  readonly kind = input.required<string>();
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly workspace = inject(Workspace);
  protected readonly meta = computed(() => ORG_KINDS[this.kind()] ?? null);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly canManage = computed(() => this.workspace.can('organization.manage'));
  protected readonly record = signal<OrgRecord | null>(null);
  protected readonly loaded = signal(false);
  protected readonly saved = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly refs = signal<Record<string, OrgRecord[]>>({});
  protected readonly title = computed(() => (this.record() ? recordLabel(this.record()!) : null));
  protected readonly action = new Action();
  protected form: Record<string, unknown> = {};

  constructor() {
    effect(() => {
      const kind = this.kind();
      const id = this.id();
      untracked(() => void this.load(kind, id));
    });
  }

  private async load(kind: string, id: string) {
    const meta = ORG_KINDS[kind];
    if (!meta) return;
    this.loaded.set(false);
    this.saved.set(false);
    this.loadError.set(null);
    try {
      const refKinds = [...new Set(meta.fields.filter((f) => f.ref).map((f) => f.ref!))];
      const pages = await Promise.all(
        refKinds.map((r) => this.api.page<OrgRecord>(`organization/${r}`, { limit: 200 })),
      );
      this.refs.set(Object.fromEntries(refKinds.map((r, i) => [r, pages[i].items])));
      if (id === 'novo') {
        this.record.set(null);
        this.form = { status: 'ACTIVE', ...(kind === 'branches' ? { type: 'BRANCH' } : {}) };
      } else {
        const record = await this.api.get<OrgRecord>(`organization/${kind}/${id}`);
        this.record.set(record);
        this.form = { ...record };
      }
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected readonly = (f: OrgField) =>
    !this.canManage() || (!this.isNew() && f.immutable === true);

  /** Opções de um campo de referência; os pais excluem o próprio registo; tudo da mesma entidade legal quando aplicável. */
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
    const meta = this.meta()!;
    const original = this.record();
    const body = payloadFor(meta, this.form, original);
    this.saved.set(false);
    if (original && Object.keys(body).length === 0) {
      this.saved.set(true);
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
    if (!result) return;
    if (!original) {
      await this.router.navigate(['/organizacao', meta.segment, result.id]);
      return;
    }
    this.record.set(result);
    this.form = { ...result };
    this.saved.set(true);
  }
}
