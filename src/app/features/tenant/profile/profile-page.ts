import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { describeAgent, eventLabel, passwordIssue, SEVERITY } from './profile-model';
import { ProfileApi, type Severity } from './profile.api';

/** A minha conta: sessões activas, palavra-passe e actividade de segurança. Aplica-se a todas as organizações. */
@Component({
  selector: 'app-profile-page',
  imports: [DatePipe, FormsModule, Alert, Badge, Button, Card, Input, LoadingState, PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="A minha conta"
      [description]="user()?.email ?? 'Sessões, palavra-passe e actividade de segurança.'"
    />

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (error(); as text) {
      <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
    }

    <app-card title="Sessões activas">
      @if (sessions.isLoading() && !sessions.hasValue()) {
        <app-loading-state label="A carregar sessões…" />
      } @else if (sessions.error()) {
        <app-alert tone="danger">{{ describe(sessions.error()) }}</app-alert>
      } @else {
        <ul class="divide-y divide-line" data-testid="sessions">
          @for (s of sessions.value() ?? []; track s.id) {
            <li class="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span>
                <strong>{{ agent(s.userAgent) }}</strong>
                @if (s.current) {
                  <app-badge tone="success">Esta sessão</app-badge>
                }
                <span class="block text-xs text-fg-muted">
                  {{ s.ip ?? 'IP desconhecido' }} · última actividade
                  {{ s.lastSeenAt | date: 'dd/MM/yyyy HH:mm' }} · expira
                  {{ s.expiresAt | date: 'dd/MM/yyyy HH:mm' }}
                </span>
              </span>
              @if (!s.current) {
                <app-button size="sm" variant="secondary" (click)="revoke(s.id)"
                  >Terminar</app-button
                >
              }
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem sessões.</li>
          }
        </ul>
      }
    </app-card>

    <app-card title="Alterar palavra-passe" class="mt-4 block">
      <div class="grid max-w-md gap-3" data-testid="password-form">
        <app-input
          label="Palavra-passe actual"
          type="password"
          autocomplete="current-password"
          [ngModel]="current()"
          (ngModelChange)="current.set($event ?? '')"
        />
        <app-input
          label="Nova palavra-passe"
          type="password"
          autocomplete="new-password"
          [ngModel]="next()"
          (ngModelChange)="next.set($event ?? '')"
        />
        <app-input
          label="Confirmar nova palavra-passe"
          type="password"
          autocomplete="new-password"
          [ngModel]="confirm()"
          (ngModelChange)="confirm.set($event ?? '')"
        />
        <div>
          <app-button [loading]="busy()" (click)="changePassword()"
            >Alterar palavra-passe</app-button
          >
        </div>
      </div>
    </app-card>

    <app-card title="Actividade de segurança" class="mt-4 block">
      @if (events.isLoading() && !events.hasValue()) {
        <app-loading-state label="A carregar actividade…" />
      } @else if (events.error()) {
        <app-alert tone="danger">{{ describe(events.error()) }}</app-alert>
      } @else {
        <ul class="divide-y divide-line" data-testid="events">
          @for (e of events.value() ?? []; track e.id) {
            <li class="flex items-center justify-between gap-3 py-2 text-sm">
              <span>{{ label(e.type) }}</span>
              <span class="flex items-center gap-2">
                <app-badge [tone]="severity(e.severity).tone">{{
                  severity(e.severity).label
                }}</app-badge>
                <span class="text-xs text-fg-muted">{{
                  e.occurredAt | date: 'dd/MM/yyyy HH:mm'
                }}</span>
              </span>
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem actividade registada.</li>
          }
        </ul>
      }
    </app-card>
  `,
})
export class ProfilePage {
  private readonly api = inject(ProfileApi);
  protected readonly user = inject(AuthService).user;

  protected readonly sessions = rxResource({ stream: () => this.api.sessions() });
  protected readonly events = rxResource({ stream: () => this.api.securityEvents() });

  protected readonly current = signal('');
  protected readonly next = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected agent = describeAgent;
  protected label = eventLabel;
  protected severity = (s: Severity) => SEVERITY[s];
  protected describe = (e: unknown) => detailedErrorMessage(e, 'Pedido falhado.');

  protected revoke(id: string): void {
    this.reset();
    this.api.revokeSession(id).subscribe({
      next: () => {
        this.notice.set('Sessão terminada.');
        this.sessions.reload();
      },
      error: (e: unknown) => {
        this.error.set(detailedErrorMessage(e, 'Não foi possível terminar a sessão.'));
        this.sessions.reload();
      },
    });
  }

  protected changePassword(): void {
    this.reset();
    const issue = passwordIssue(this.current(), this.next(), this.confirm());
    if (issue) {
      this.error.set(issue);
      return;
    }
    this.busy.set(true);
    this.api.changePassword(this.current(), this.next()).subscribe({
      next: () => {
        this.busy.set(false);
        this.current.set('');
        this.next.set('');
        this.confirm.set('');
        this.notice.set('Palavra-passe alterada.');
        this.sessions.reload();
        this.events.reload();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(detailedErrorMessage(e, 'Não foi possível alterar a palavra-passe.'));
      },
    });
  }

  private reset(): void {
    this.notice.set(null);
    this.error.set(null);
  }
}
