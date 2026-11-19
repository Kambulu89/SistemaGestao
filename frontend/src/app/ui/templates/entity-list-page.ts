import { Component, computed, inject, input } from '@angular/core';
import { Workspace } from '../../core/workspace';
import { PageHeader } from '../page-header';
import { AccessDenied } from '../states';

/**
 * EntityListPage: cabeçalho com acções, verificação de acesso (permissão e funcionalidade; sem elas mostra "sem
 * acesso" e não pede nada à API), barra de filtros e tabela projectadas. Os estados carregamento/vazio/erro ficam na
 * `DataTable`; a pesquisa, os filtros, a ordenação e a página no `ListState` (na URL).
 *
 * ```html
 * <app-entity-list-page title="…" permission="x.read">
 *   <button actions …>Novo</button>
 *   <app-filter-bar …/>
 *   <app-data-table …/>
 * </app-entity-list-page>
 * ```
 */
@Component({
  selector: 'app-entity-list-page',
  imports: [PageHeader, AccessDenied],
  template: `
    <app-page-header [title]="title()" [subtitle]="subtitle()">
      @if (allowed()) {
        <ng-content select="[actions]" />
      }
    </app-page-header>
    @if (allowed()) {
      <ng-content />
    } @else {
      <app-access-denied
        [reason]="featureMissing() ? 'feature' : 'permission'"
        [permission]="featureMissing() ? null : permission()"
      />
    }
  `,
})
export class EntityListPage {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly permission = input<string | null>(null);
  readonly feature = input<string | null>(null);
  /** A permissão vale em qualquer âmbito (a API filtra pelo âmbito do membro). */
  readonly anyScope = input(false);
  private readonly workspace = inject(Workspace);
  protected readonly featureMissing = computed(
    () => !!this.feature() && !this.workspace.has(this.feature()!),
  );
  protected readonly allowed = computed(
    () =>
      !this.featureMissing() &&
      (!this.permission() ||
        (this.anyScope()
          ? this.workspace.canAny(this.permission()!)
          : this.workspace.can(this.permission()!))),
  );
}
