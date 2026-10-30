import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { CatalogApi, type CategoryDto } from './catalog.api';
import { catalogError } from './catalog-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Categoria' },
  { key: 'parent', label: 'Categoria-mãe' },
];

/** Categorias de produtos: uma árvore sem ciclos (o servidor recusa um pai que seja descendente). */
@Component({
  selector: 'app-catalog-categories',
  imports: [FormsModule, Alert, Button, Card, EmptyState, Input, LoadingState, Select, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }

    <app-card [flush]="true">
      @if (categories.isLoading() && !categories.hasValue()) {
        <app-loading-state label="A carregar categorias…" />
      } @else if (categories.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as categorias">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (categories.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="tag" title="Sem categorias" />
        } @else {
          <app-table
            caption="Categorias"
            [columns]="columns"
            [rows]="list"
            data-testid="categories"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.code }}</span>
                }
                @case ('parent') {
                  {{ parentName(row) }}
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (canManage()) {
      <app-card class="mt-4 block">
        <h3 class="mb-3 text-sm font-semibold">Nova categoria</h3>
        <div class="grid gap-4 sm:grid-cols-3">
          <app-input
            label="Código"
            [required]="true"
            [ngModel]="code()"
            (ngModelChange)="code.set($event ?? '')"
          />
          <app-input
            label="Nome"
            [required]="true"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <app-select
            label="Categoria-mãe"
            placeholder="Nenhuma"
            [options]="parentOptions()"
            [ngModel]="parentId()"
            (ngModelChange)="parentId.set($event ?? '')"
          />
        </div>
        <app-button class="mt-4" [loading]="busy()" (click)="create()">Criar categoria</app-button>
      </app-card>
    }
  `,
})
export class CategoriesTab {
  private readonly api = inject(CatalogApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly canManage = computed(() => this.permissions.can('catalog.manage'));

  private readonly reload = signal(0);
  protected readonly categories = rxResource({
    params: () => ({ reload: this.reload() }),
    stream: () => this.api.categories(),
  });
  protected readonly loadError = computed(() =>
    catalogError(this.categories.error(), 'Tente novamente.'),
  );
  protected readonly parentOptions = computed<readonly SelectOption[]>(() =>
    (this.categories.hasValue() ? this.categories.value() : []).map((c) => ({
      value: c.id,
      label: c.name,
    })),
  );

  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly parentId = signal('');
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected parentName(row: CategoryDto): string {
    if (!row.parentId) return '—';
    const list = this.categories.hasValue() ? this.categories.value() : [];
    return list.find((c) => c.id === row.parentId)?.name ?? '—';
  }

  private run<T>(call: Observable<T>, message: string, after?: () => void): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        after?.();
        this.notice.set(message);
        this.reload.update((n) => n + 1);
      },
      error: (error: unknown) =>
        this.actionError.set(catalogError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected create(): void {
    if (!this.code().trim() || !this.name().trim()) {
      this.actionError.set('O código e o nome são obrigatórios.');
      return;
    }
    this.run(
      this.api.createCategory({
        code: this.code().trim(),
        name: this.name().trim(),
        parentId: this.parentId() || null,
      }),
      'Categoria criada.',
      () => {
        this.code.set('');
        this.name.set('');
        this.parentId.set('');
      },
    );
  }
}
