import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ConfirmService } from '../ui/confirm';
import { ToastService } from '../ui/toasts';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import type { FeatureDefinition, Plan } from './types';

interface FeatureRow {
  definition: FeatureDefinition;
  included: boolean;
  /** Texto do campo; vazio = sem limite. */
  limit: string;
}

/** Criar ou editar (em rascunho) um plano; publicar e retirar. */
@Component({
  selector: 'app-platform-plan-form',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, StatusBadge],
  template: `
    <app-page-header [title]="isNew() ? 'Novo plano' : (plan()?.name ?? 'Plano')">
      <a routerLink="/plataforma/planos" class="btn-secondary">Voltar</a>
    </app-page-header>
    <app-error-alert [error]="loadError()" />
    @if (ready()) {
      <form class="space-y-4" (ngSubmit)="save()" novalidate>
        <section class="card grid gap-4 md:grid-cols-4">
          <div class="md:col-span-4 flex items-center justify-between">
            <p class="text-sm">Estado: <app-status-badge [status]="plan()?.status ?? 'DRAFT'" /></p>
            @if (saved()) {
              <p class="text-sm text-success-text" role="status">Guardado.</p>
            }
          </div>
          <div class="md:col-span-4"><app-error-alert [error]="action.error()" /></div>
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
          <div>
            <label class="label" for="trial">Dias experimentais</label>
            <input
              id="trial"
              name="trial"
              type="number"
              min="0"
              class="input"
              [disabled]="!editable()"
              [(ngModel)]="trialDays"
            />
          </div>
          <div class="md:col-span-4">
            <label class="label" for="description">Descrição</label>
            <input
              id="description"
              name="description"
              class="input"
              [disabled]="!editable()"
              [(ngModel)]="description"
            />
          </div>
        </section>
        <section class="card">
          <h2 class="font-semibold">Funcionalidades</h2>
          <table class="table mt-2" aria-label="Funcionalidades do plano">
            <thead>
              <tr>
                <th>Incluir</th>
                <th>Funcionalidade</th>
                <th>Tipo</th>
                <th>Limite (vazio = sem limite)</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.definition.code; let i = $index) {
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      [id]="'inc-' + i"
                      [name]="'inc-' + i"
                      [disabled]="!editable()"
                      [(ngModel)]="row.included"
                      [attr.aria-label]="'Incluir ' + row.definition.code"
                    />
                  </td>
                  <td>
                    <span class="font-mono text-xs">{{ row.definition.code }}</span
                    ><br /><span class="text-xs text-muted">{{ row.definition.description }}</span>
                  </td>
                  <td>{{ row.definition.kind }}</td>
                  <td>
                    @if (row.definition.kind === 'LIMIT') {
                      <input
                        type="number"
                        min="0"
                        class="input w-32"
                        [name]="'lim-' + i"
                        [disabled]="!editable() || !row.included"
                        [(ngModel)]="row.limit"
                        [attr.aria-label]="'Limite de ' + row.definition.code"
                      />
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
        <div class="flex flex-wrap gap-2">
          @if (editable()) {
            <button type="submit" class="btn-primary" [disabled]="action.busy()">
              {{ isNew() ? 'Criar rascunho' : 'Guardar' }}
            </button>
          }
          @if (plan()?.status === 'DRAFT') {
            <button
              type="button"
              class="btn-primary"
              [disabled]="action.busy()"
              (click)="setStatus('publish')"
            >
              Publicar
            </button>
          }
          @if (plan()?.status === 'ACTIVE') {
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
export class PlatformPlanForm implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly plan = signal<Plan | null>(null);
  protected readonly editable = computed(() => this.isNew() || this.plan()?.status === 'DRAFT');
  protected readonly rows = signal<FeatureRow[]>([]);
  protected readonly ready = signal(false);
  protected readonly saved = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected code = '';
  protected name = '';
  protected description = '';
  protected trialDays = 0;
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private initial = '';

  hasUnsavedChanges() {
    return this.ready() && this.editable() && this.current() !== this.initial;
  }

  private current() {
    return snapshot({ code: this.code, ...this.body() });
  }

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    try {
      const features = await this.api.get<FeatureDefinition[]>('platform/features');
      const plan = id === 'novo' ? null : await this.api.get<Plan>(`platform/plans/${id}`);
      this.apply(plan, features);
      this.ready.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(plan: Plan | null, features = this.rows().map((r) => r.definition)) {
    this.plan.set(plan);
    this.code = plan?.code ?? '';
    this.name = plan?.name ?? '';
    this.description = plan?.description ?? '';
    this.trialDays = plan?.trialDays ?? 0;
    this.rows.set(
      features.map((definition) => {
        const f = plan?.features.find((x) => x.featureCode === definition.code);
        return {
          definition,
          included: !!f?.enabled,
          limit: f?.limitValue !== null && f?.limitValue !== undefined ? String(f.limitValue) : '',
        };
      }),
    );
    if (plan) this.breadcrumbs.setCurrent(plan.name);
    this.initial = this.current();
  }

  private body() {
    return {
      name: this.name.trim(),
      description: this.description.trim() || null,
      trialDays: Number(this.trialDays) || 0,
      features: this.rows()
        .filter((r) => r.included)
        .map((r) => ({
          featureCode: r.definition.code,
          limitValue:
            r.definition.kind === 'LIMIT' && String(r.limit).trim() !== '' ? Number(r.limit) : null,
        })),
    };
  }

  protected async save() {
    if (this.action.busy()) return;
    this.saved.set(false);
    const plan = this.plan();
    const result = await this.action.run(() =>
      plan
        ? this.api.patch<Plan>(`platform/plans/${plan.id}`, {
            ...this.body(),
            expectedVersion: plan.version,
          })
        : this.api.post<Plan>('platform/plans', {
            ...this.body(),
            code: this.code.trim().toUpperCase(),
          }),
    );
    if (!result) return;
    this.initial = this.current();
    if (!plan) {
      this.toasts.show('Plano criado.');
      await this.router.navigate(['/plataforma/planos', result.id]);
      return;
    }
    this.apply(result);
    this.toasts.show('Plano guardado.');
  }

  protected async setStatus(action: 'publish' | 'retire') {
    const message =
      action === 'publish'
        ? 'Publicar? Depois de publicado o plano não se altera.'
        : 'Retirar? Deixa de aceitar subscrições novas.';
    if (this.hasUnsavedChanges()) {
      this.toasts.show('Guarde o plano antes de mudar o estado.', 'info');
      return;
    }
    const ok = await this.confirm.ask({
      title: action === 'publish' ? 'Publicar plano' : 'Retirar plano',
      message,
      confirmLabel: action === 'publish' ? 'Publicar' : 'Retirar',
      danger: action === 'retire',
    });
    if (!ok) return;
    const result = await this.action.run(() =>
      this.api.post<Plan>(`platform/plans/${this.plan()!.id}/${action}`),
    );
    if (result) {
      this.apply(result);
      this.toasts.show(action === 'publish' ? 'Plano publicado.' : 'Plano retirado.');
    }
  }
}
