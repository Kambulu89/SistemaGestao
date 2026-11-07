import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { Loadable } from '../ui/load';
import { EmptyState, ErrorState, Skeleton } from '../ui/states';
import { StatusBadge } from '../ui/status-badge';
import { flattenTree, type TreeNode } from './org-kinds';

/**
 * Organograma (departamentos ou centros de custo) a partir de `GET organization/:kind/tree`: lista indentada (o nível é
 * anunciado), com responsável e estado; filtra pela entidade legal do âmbito de trabalho.
 */
@Component({
  selector: 'app-org-tree',
  imports: [RouterLink, StatusBadge, Skeleton, ErrorState, EmptyState],
  template: `
    @if (tree.error()) {
      <app-error-state [error]="tree.error()" (retry)="tree.load()" />
    } @else if (tree.loading() && !tree.value()) {
      <div class="card"><app-skeleton /></div>
    } @else if (items().length === 0) {
      <app-empty-state title="Sem registos" description="Ainda não há registos para mostrar." />
    } @else {
      <ul [attr.aria-label]="label()" class="card divide-y divide-border p-0">
        @for (item of items(); track item.node.id) {
          <li
            class="flex flex-wrap items-center gap-2 py-2 pr-3 text-sm"
            [style.padding-left.rem]="0.75 + item.depth * 1.5"
          >
            @if (item.depth > 0) {
              <span aria-hidden="true" class="text-muted">└</span>
            }
            <span class="sr-only">Nível {{ item.depth + 1 }}:</span>
            <a class="btn-link font-medium" [routerLink]="['/organizacao', kind(), item.node.id]"
              >{{ item.node.code }} — {{ item.node.name }}</a
            >
            <span class="text-muted">{{
              item.node.managerName ? 'Responsável: ' + item.node.managerName : 'Sem responsável'
            }}</span>
            <span class="ml-auto"><app-status-badge [status]="item.node.status" /></span>
          </li>
        }
      </ul>
    }
  `,
})
export class OrgTree {
  readonly kind = input.required<string>();
  readonly label = input.required<string>();
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly tree = new Loadable(() =>
    this.api.get<TreeNode[]>(`organization/${this.kind()}/tree`, {
      legalEntityId: this.workspace.legalEntityId() ?? undefined,
    }),
  );
  protected readonly items = computed(() => flattenTree(this.tree.value() ?? []));

  constructor() {
    effect(() => {
      this.kind();
      this.workspace.legalEntityId();
      untracked(() => void this.tree.load());
    });
  }
}
