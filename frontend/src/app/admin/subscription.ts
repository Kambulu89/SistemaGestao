import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';

interface SubscriptionView {
  status: string;
  plan: { code: string; name: string } | null;
  trialEndsAt: string | null;
  endsAt: string | null;
  entitlements: { code: string; enabled: boolean; limit: number | null; source: string }[];
}

const SOURCES: Record<string, string> = { PLAN: 'Plano', OVERRIDE: 'Excepção', NONE: '—' };

/** Subscrição da empresa (só leitura; a gestão é da administração da plataforma). */
@Component({
  selector: 'app-tenant-subscription',
  imports: [PageHeader, ErrorAlert, StatusBadge],
  template: `
    <app-page-header
      title="Subscrição"
      subtitle="Plano e funcionalidades contratadas. Alterações: administração da plataforma."
    />
    <app-error-alert [error]="sub.error()" />
    @if (sub.value(); as s) {
      <section class="card mb-4 grid gap-2 text-sm md:grid-cols-4">
        <p>Estado: <app-status-badge [status]="s.status" /></p>
        <p>
          Plano: <strong>{{ s.plan?.name ?? '—' }}</strong>
        </p>
        <p>Fim do período experimental: {{ when(s.trialEndsAt) }}</p>
        <p>Fim: {{ when(s.endsAt) }}</p>
      </section>
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Funcionalidades">
          <thead>
            <tr>
              <th>Funcionalidade</th>
              <th>Incluída</th>
              <th>Limite</th>
              <th>Origem</th>
            </tr>
          </thead>
          <tbody>
            @for (e of s.entitlements; track e.code) {
              <tr>
                <td class="font-mono text-xs">{{ e.code }}</td>
                <td>{{ e.enabled ? 'Sim' : 'Não' }}</td>
                <td>{{ e.enabled ? (e.limit ?? 'Sem limite') : '—' }}</td>
                <td>{{ source(e.source) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class TenantSubscription {
  private readonly api = inject(Api);
  protected readonly when = formatDateTime;
  protected readonly sub = new Loadable(() =>
    this.api.get<SubscriptionView>('tenant/subscription'),
  );
  protected source = (s: string) => SOURCES[s] ?? s;

  constructor() {
    void this.sub.load();
  }
}
