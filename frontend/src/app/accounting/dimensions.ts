import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ErrorState, Skeleton } from '../ui/states';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import type { Dimension, DimensionValue } from './model';
import { accountingDeps } from './shared';

/** Dimensões analíticas (projecto, região, …) e os seus valores. Inactivar em vez de apagar: o histórico fica. */
@Component({
  selector: 'app-dimensions',
  imports: [FormsModule, PageHeader, ErrorAlert, ErrorState, Skeleton, StatusBadge],
  template: `
    <app-page-header
      title="Dimensões analíticas"
      subtitle="Além dos centros de custo, as linhas podem ser imputadas a valores destas dimensões."
    />
    <app-error-alert [error]="action.error()" [showDetails]="true" />
    @if (dims.error()) {
      <app-error-state [error]="dims.error()" (retry)="dims.load()" />
    } @else if (!dims.value()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @if (dims.value()!.length === 0) {
        <p class="card text-sm text-muted">Ainda não há dimensões.</p>
      }
      @for (d of dims.value(); track d.id) {
        <section class="card mb-4" [attr.aria-labelledby]="'dim-' + d.id">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 [id]="'dim-' + d.id" class="font-semibold">
              <span class="font-mono">{{ d.code }}</span> — {{ d.name }}
              <app-status-badge [status]="d.status" />
            </h2>
            @if (canManage()) {
              <button
                type="button"
                class="btn-secondary"
                [disabled]="action.busy()"
                (click)="toggleDimension(d)"
              >
                {{ d.status === 'ACTIVE' ? 'Inactivar' : 'Reactivar' }}
              </button>
            }
          </div>
          <ul class="mt-2 divide-y divide-border text-sm">
            @for (v of d.values; track v.id) {
              <li class="flex items-center justify-between gap-2 py-1">
                <span
                  ><span class="font-mono">{{ v.code }}</span> — {{ v.name }}
                  <app-status-badge [status]="v.status"
                /></span>
                @if (canManage()) {
                  <button
                    type="button"
                    class="btn-secondary"
                    [attr.aria-label]="
                      (v.status === 'ACTIVE' ? 'Inactivar ' : 'Reactivar ') + v.code
                    "
                    [disabled]="action.busy()"
                    (click)="toggleValue(d, v)"
                  >
                    {{ v.status === 'ACTIVE' ? 'Inactivar' : 'Reactivar' }}
                  </button>
                }
              </li>
            }
          </ul>
          @if (canManage()) {
            <form
              class="mt-3 flex flex-wrap items-end gap-2"
              (ngSubmit)="addValue(d)"
              [attr.aria-label]="'Novo valor de ' + d.name"
            >
              <div>
                <label class="label" [for]="'vc-' + d.id">Código</label>
                <input
                  class="input w-32"
                  [id]="'vc-' + d.id"
                  [name]="'vc' + d.id"
                  [(ngModel)]="newValue[d.id].code"
                />
              </div>
              <div>
                <label class="label" [for]="'vn-' + d.id">Nome</label>
                <input
                  class="input w-64"
                  [id]="'vn-' + d.id"
                  [name]="'vn' + d.id"
                  [(ngModel)]="newValue[d.id].name"
                />
              </div>
              <button type="submit" class="btn-secondary" [disabled]="action.busy()">
                Acrescentar valor
              </button>
            </form>
          }
        </section>
      }
      @if (canManage()) {
        <form
          class="card flex flex-wrap items-end gap-2"
          (ngSubmit)="create()"
          aria-label="Nova dimensão"
        >
          <div>
            <label class="label" for="d-code">Código</label>
            <input id="d-code" name="code" class="input w-40" [(ngModel)]="form.code" />
          </div>
          <div>
            <label class="label" for="d-name">Nome</label>
            <input id="d-name" name="name" class="input w-64" [(ngModel)]="form.name" />
          </div>
          <button type="submit" class="btn-primary" [disabled]="action.busy()">
            Criar dimensão
          </button>
        </form>
      }
    }
  `,
})
export class Dimensions {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly action = new Action();
  protected form = { code: '', name: '' };
  protected newValue: Record<string, { code: string; name: string }> = {};
  protected readonly dims = new Loadable(async () => {
    const list = (await this.deps.api.page<Dimension>('accounting/dimensions', { limit: 200 }))
      .items;
    for (const d of list) this.newValue[d.id] ??= { code: '', name: '' };
    return list;
  });
  protected readonly reloadKey = signal(0);

  constructor() {
    void this.dims.load();
  }

  protected async create() {
    const d = await this.action.run(() =>
      this.deps.api.post<Dimension>('accounting/dimensions', this.form),
    );
    if (!d) return;
    this.form = { code: '', name: '' };
    this.toasts.show('Dimensão criada.');
    await this.dims.load();
  }

  protected async addValue(d: Dimension) {
    const v = this.newValue[d.id];
    const r = await this.action.run(() =>
      this.deps.api.post<DimensionValue[]>(`accounting/dimensions/${d.id}/values`, v),
    );
    if (!r) return;
    this.newValue[d.id] = { code: '', name: '' };
    this.toasts.show('Valor acrescentado.');
    await this.dims.load();
  }

  protected async toggleDimension(d: Dimension) {
    const r = await this.action.run(() =>
      this.deps.api.patch<Dimension>(`accounting/dimensions/${d.id}`, {
        expectedVersion: d.version,
        status: d.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      }),
    );
    if (r) await this.dims.load();
  }

  protected async toggleValue(d: Dimension, v: DimensionValue) {
    const r = await this.action.run(() =>
      this.deps.api.patch<DimensionValue[]>(`accounting/dimensions/${d.id}/values/${v.id}`, {
        expectedVersion: v.version,
        status: v.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      }),
    );
    if (r) await this.dims.load();
  }
}
