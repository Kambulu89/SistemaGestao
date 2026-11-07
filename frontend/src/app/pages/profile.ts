import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { Workspace } from '../core/workspace';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';

interface SessionView {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Conta: dados do utilizador e sessões activas (revogar qualquer uma, incluindo a actual). */
@Component({
  selector: 'app-profile',
  imports: [PageHeader, ErrorAlert],
  template: `
    <app-page-header title="A minha conta" [subtitle]="session.user()?.email ?? ''" />
    <section class="card">
      <h2 class="font-semibold">Sessões activas</h2>
      <p class="text-sm text-muted">Termine as sessões que não reconhece.</p>
      <app-error-alert [error]="sessions.error() ?? action.error()" />
      <div class="mt-3 overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Dispositivo</th>
              <th>IP</th>
              <th>Última actividade</th>
              <th>Expira</th>
              <th><span class="sr-only">Acções</span></th>
            </tr>
          </thead>
          <tbody>
            @for (s of sessions.value(); track s.id) {
              <tr>
                <td class="max-w-xs truncate" [title]="s.userAgent ?? ''">
                  {{ s.userAgent ?? 'Desconhecido' }}
                  @if (s.current) {
                    <span class="badge ml-1 bg-primary-soft text-link">Esta sessão</span>
                  }
                </td>
                <td>{{ s.ip ?? '—' }}</td>
                <td>{{ when(s.lastSeenAt) }}</td>
                <td>{{ when(s.expiresAt) }}</td>
                <td>
                  <button
                    type="button"
                    class="btn-secondary"
                    [disabled]="action.busy()"
                    (click)="revoke(s)"
                  >
                    Terminar
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class Profile {
  protected readonly session = inject(Session);
  private readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly when = formatDateTime;
  protected readonly action = new Action();
  protected readonly sessions = new Loadable(() => this.api.get<SessionView[]>('auth/sessions'));

  constructor() {
    void this.sessions.load();
  }

  protected async revoke(s: SessionView) {
    const done = await this.action.run(() => this.api.delete(`auth/sessions/${s.id}`));
    if (done === undefined && this.action.error()) return;
    if (s.current) {
      this.session.clear();
      this.workspace.reset();
      await this.router.navigateByUrl('/entrar');
    } else await this.sessions.load();
  }
}
