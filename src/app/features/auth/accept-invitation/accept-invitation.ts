import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { finalize, switchMap } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { ApiService } from '../../../core/api/api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';

interface AcceptedDto {
  readonly tenantId: string;
  readonly membershipId: string;
}

/**
 * Aceita um convite. Exige sessão (a conta é a identidade global) e que o email da conta seja o do
 * convite; o servidor valida o token, o email, o prazo, o estado do tenant e a quota.
 */
@Component({
  selector: 'app-accept-invitation',
  imports: [Alert, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <h1 class="text-xl font-bold tracking-tight">Convite</h1>
    @if (!token()) {
      <app-alert class="mt-6" tone="danger">A ligação do convite é inválida.</app-alert>
    } @else {
      <p class="mt-1 text-sm text-fg-muted">
        Sessão iniciada como <strong>{{ email() }}</strong
        >. O convite só pode ser aceite com a conta para a qual foi enviado.
      </p>
      @if (error(); as message) {
        <app-alert class="mt-4" tone="danger">{{ message }}</app-alert>
      }
      <div class="mt-6">
        <app-button [block]="true" [loading]="loading()" (click)="accept()"
          >Aceitar convite</app-button
        >
      </div>
    }
  `,
})
export class AcceptInvitation {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly tenants = inject(TenantContextService);
  private readonly router = inject(Router);

  /** Vem do query param `token` (binding de inputs do router). */
  readonly token = input<string>();

  protected readonly email = () => this.auth.user()?.email ?? '';
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected accept(): void {
    const token = this.token();
    if (!token) return;
    this.error.set(null);
    this.loading.set(true);
    this.api
      .post<AcceptedDto>('invitations/accept', { token })
      .pipe(
        // A lista de organizações mudou: recarrega-a para encontrar a nova.
        switchMap((accepted) =>
          this.tenants.refreshMemberships().pipe(
            switchMap((list) => {
              const slug = list.find((m) => m.tenant.id === accepted.tenantId)?.tenant.slug;
              return this.router.navigate(slug ? ['/t', slug] : ['/']);
            }),
          ),
        ),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        // Token, email, prazo ou estado do tenant: o servidor responde sempre o mesmo, de propósito.
        error: (e: ApiError) => this.error.set(e.message),
      });
  }
}
