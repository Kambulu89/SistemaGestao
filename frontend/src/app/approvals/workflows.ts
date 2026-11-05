import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import type { Workflow } from './types';

@Component({
  selector: 'app-workflows',
  imports: [RouterLink, PageHeader, ErrorAlert, StatusBadge],
  template: `
    <app-page-header
      title="Workflows de aprovação"
      subtitle="Etapas e aprovadores. Publicado, não se altera: retire e crie outro."
    >
      <a routerLink="/aprovacoes/workflows/novo" class="btn-primary">Novo workflow</a>
    </app-page-header>
    <app-error-alert [error]="list.error()" />
    @if ((list.value() ?? []).length === 0 && !list.loading()) {
      <p class="card text-sm text-slate-600">Ainda não há workflows.</p>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Workflows">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Código</th>
              <th>Etapas</th>
              <th>Estado</th>
              <th>Publicado</th>
            </tr>
          </thead>
          <tbody>
            @for (w of list.value(); track w.id) {
              <tr>
                <td>
                  <a class="btn-link" [routerLink]="['/aprovacoes/workflows', w.id]">{{
                    w.name
                  }}</a>
                </td>
                <td class="font-mono text-xs">{{ w.code }}</td>
                <td>{{ w.steps.length }}</td>
                <td><app-status-badge [status]="w.status" /></td>
                <td>{{ when(w.publishedAt) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class Workflows {
  private readonly api = inject(Api);
  protected readonly when = formatDateTime;
  protected readonly list = new Loadable(() => this.api.get<Workflow[]>('approvals/workflows'));

  constructor() {
    void this.list.load();
  }
}
