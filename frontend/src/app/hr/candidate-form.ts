import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { formatDate } from '../ui/dates';
import { FormActionBar } from '../ui/form-action-bar';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { type Candidate, STAGE, type Stage, tone } from './recruitment-model';

const FIELDS = ['fullName', 'email', 'phone', 'source', 'notes'] as const;

/** Candidato: dados de contacto mínimos e as candidaturas visíveis ao membro. Sem rascunhos (dados pessoais). */
@Component({
  selector: 'app-candidate-form',
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
    ErrorState,
    Skeleton,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (isNew()) {
      <app-entity-form-page
        title="Novo candidato"
        subtitle="Indique pelo menos um contacto (email ou telefone)."
        formId="cand-form"
        [loading]="false"
        [saveError]="action.error()"
        [busy]="action.busy()"
        [dirty]="hasUnsavedChanges()"
        saveLabel="Registar candidato"
        (save)="save()"
        (cancelled)="back()"
      >
        <ng-container *ngTemplateOutlet="fieldsTpl" />
      </app-entity-form-page>
    } @else if (!record()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let c = record()!;
      <app-page-detail [title]="c.fullName" [subtitle]="c.email ?? c.phone">
        <ng-container actions>
          <a class="btn-secondary" routerLink="/rh/candidatos">Voltar à lista</a>
        </ng-container>
        <form id="cand-form" class="space-y-4" (ngSubmit)="save()" novalidate>
          <ng-container *ngTemplateOutlet="fieldsTpl" />
          @if (canManage()) {
            <app-form-action-bar
              formId="cand-form"
              [dirty]="hasUnsavedChanges()"
              [busy]="action.busy()"
            />
          }
        </form>
        <div aside>
          <section class="card" aria-labelledby="cand-apps">
            <h2 id="cand-apps" class="mb-3 font-semibold">Candidaturas</h2>
            @if (c.applications?.length) {
              <ul class="space-y-2 text-sm">
                @for (a of c.applications; track a.id) {
                  <li class="flex items-center justify-between gap-2">
                    <a class="link" [routerLink]="['/rh/candidaturas', a.id]"
                      >{{ a.requisition.code }} — {{ a.requisition.title }}</a
                    >
                    <span class="badge" [class]="tone(a.stage)">{{ stage(a.stage) }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="text-sm text-muted">Sem candidaturas visíveis.</p>
            }
          </section>
        </div>
      </app-page-detail>
    }

    <ng-template #fieldsTpl>
      <app-form-section
        title="Candidato"
        description="Só os dados necessários ao processo de recrutamento."
      >
        <app-field label="Nome completo" [required]="true" [error]="action.field('fullName')">
          <input
            appControl
            class="input"
            data-field="fullName"
            [disabled]="!canManage()"
            [(ngModel)]="form['fullName']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Email" [error]="action.field('email')">
          <input
            appControl
            class="input"
            type="email"
            data-field="email"
            [disabled]="!canManage()"
            [(ngModel)]="form['email']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Telefone" [error]="action.field('phone')">
          <input
            appControl
            class="input"
            data-field="phone"
            [disabled]="!canManage()"
            [(ngModel)]="form['phone']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field
          label="Origem"
          hint="Ex.: site, indicação, feira de emprego."
          [error]="action.field('source')"
        >
          <input
            appControl
            class="input"
            data-field="source"
            [disabled]="!canManage()"
            [(ngModel)]="form['source']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Notas" [error]="action.field('notes')">
          <textarea
            appControl
            class="input min-h-24"
            data-field="notes"
            [disabled]="!canManage()"
            [(ngModel)]="form['notes']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          ></textarea>
        </app-field>
      </app-form-section>
    </ng-template>
  `,
})
export class CandidateForm implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly record = signal<Candidate | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly tone = tone;
  protected readonly stage = (s: Stage) => STAGE[s] ?? s;
  protected readonly date = formatDate;
  private readonly tick = signal(0);
  protected form: Record<string, unknown> = {};
  private initial = snapshot({});
  protected readonly canManage = computed(() =>
    this.isNew() ? this.workspace.canAny('hr.recruitment.manage') : !!this.record()?.access?.manage,
  );

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  hasUnsavedChanges() {
    this.tick();
    return this.canManage() && snapshot(this.form) !== this.initial;
  }

  protected touch() {
    this.tick.update((n) => n + 1);
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loadError.set(null);
    if (id === 'novo') {
      this.form = {};
      this.initial = snapshot(this.form);
      return;
    }
    try {
      const c = await this.api.get<Candidate>(`hr/candidates/${id}`);
      this.record.set(c);
      this.breadcrumbs.setCurrent(c.fullName);
      this.form = Object.fromEntries(FIELDS.map((k) => [k, c[k] ?? null]));
      this.initial = snapshot(this.form);
      this.touch();
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected back() {
    void this.router.navigate(['/rh/candidatos']);
  }

  protected async save() {
    if (this.action.busy() || !this.canManage()) return;
    const original = this.record();
    const body: Record<string, unknown> = {};
    for (const k of FIELDS) {
      let v = this.form[k];
      if (typeof v === 'string') v = v.trim();
      if (v === '' || v === undefined) v = null;
      if (original ? (original[k] ?? null) !== v : v !== null) body[k] = v;
    }
    if (original && Object.keys(body).length === 0) {
      this.toasts.show('Nada para guardar.', 'info');
      return;
    }
    const result = await this.action.run(() =>
      original
        ? this.api.patch<Candidate>(`hr/candidates/${original.id}`, {
            ...body,
            expectedVersion: original.version,
          })
        : this.api.post<Candidate>('hr/candidates', body),
    );
    if (!result) return;
    this.initial = snapshot(this.form);
    if (!original) {
      this.toasts.show('Candidato registado.');
      await this.router.navigate(['/rh/candidatos', result.id]);
      return;
    }
    await this.load(original.id);
    this.toasts.show('Candidato actualizado.');
  }
}
