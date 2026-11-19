import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { type Column, DataTable } from '../ui/data-table';
import { FilterBar } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import type { Candidate } from './recruitment-model';

/** Candidatos: a API mostra os das vagas que o membro vê e os que registou (dados de contacto mínimos). */
@Component({
  selector: 'app-candidates',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, Icon],
  template: `
    <app-entity-list-page
      title="Candidatos"
      subtitle="Pessoas candidatas às vagas. Não são colaboradores nem utilizadores até serem contratadas."
      permission="hr.recruitment.read"
      feature="hr"
      [anyScope]="true"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/rh/candidatos/novo"
          ><app-icon name="plus" [size]="16" />Novo candidato</a
        >
      }
      <app-filter-bar
        id="cand"
        label="candidatos"
        placeholder="Nome, email ou telefone"
        [state]="list"
        [filters]="[]"
      />
      <app-data-table
        label="Candidatos"
        tableId="hr-candidates"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="list.q() ? 'Sem candidatos com esta pesquisa.' : 'Ainda não há candidatos.'"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      />
    </app-entity-list-page>
  `,
})
export class Candidates {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('hr.recruitment.manage'));
  protected readonly columns: Column<Candidate>[] = [
    {
      key: 'fullName',
      label: 'Nome',
      required: true,
      link: (c) => ['/rh/candidatos', c.id],
    },
    { key: 'email', label: 'Email', hideOnMobile: true },
    { key: 'phone', label: 'Telefone', hideOnMobile: true },
    { key: 'source', label: 'Origem', hideOnMobile: true, hiddenByDefault: true },
    { key: 'applicationsCount', label: 'Candidaturas', align: 'end' },
  ];
  protected readonly list = new ListState<Candidate>(this.api, {
    url: 'hr/candidates',
    filterKeys: [],
    sortFields: [],
    limit: 25,
  });
}
