import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { Button } from '../../../shared/ui/button/button';

@Component({
  selector: 'app-no-access',
  imports: [RouterLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="py-4 text-center">
      <h1 class="text-xl font-bold tracking-tight">Sem acesso</h1>
      <p class="mt-2 text-sm text-fg-muted">
        Não tem permissão para ver esta área, ou não pertence a nenhuma organização activa. Contacte
        um administrador se considera que é um engano.
      </p>
      <div class="mt-6 flex justify-center gap-3">
        <a
          routerLink="/"
          class="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-medium hover:bg-surface-muted"
        >
          Ir para o início
        </a>
        @if (auth.isAuthenticated()) {
          <app-button (click)="logout()">Terminar sessão</app-button>
        }
      </div>
    </section>
  `,
})
export class NoAccess {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected logout(): void {
    this.auth.logout();
    void this.router.navigate(['/auth/login']);
  }
}
