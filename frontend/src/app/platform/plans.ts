import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import type { Plan } from './types';

@Component({
  selector: 'app-platform-plans',
  imports: [RouterLink, PageHeader, ErrorAlert, StatusBadge],
  template: `
    <app-page-header
      title="Planos"
      subtitle="Publicado, um plano não se altera: crie outro e mude as subscrições."
    >
      <a routerLink="/plataforma/planos/novo" class="btn-primary">Novo plano</a>
    </app-page-header>
    <app-error-alert [error]="plans.error()" />
    @if ((plans.value() ?? []).length === 0 && !plans.loading()) {
      <p class="card text-sm text-slate-600">Ainda não há planos.</p>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Planos">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nome</th>
              <th>Funcionalidades</th>
              <th>Experimental</th>
              <th>Estado</th>
              <th>Publicado</th>
            </tr>
          </thead>
          <tbody>
            @for (p of plans.value(); track p.id) {
              <tr>
                <td>
                  <a class="btn-link font-mono" [routerLink]="['/plataforma/planos', p.id]">{{
                    p.code
                  }}</a>
                </td>
                <td>{{ p.name }}</td>
                <td>{{ p.features.length }}</td>
                <td>{{ p.trialDays }} dias</td>
                <td><app-status-badge [status]="p.status" /></td>
                <td>{{ when(p.publishedAt) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class PlatformPlans {
  private readonly api = inject(Api);
  protected readonly when = formatDateTime;
  protected readonly plans = new Loadable(() => this.api.get<Plan[]>('platform/plans'));

  constructor() {
    void this.plans.load();
  }
}
