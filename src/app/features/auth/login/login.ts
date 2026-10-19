import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { AuthService } from '../../../core/auth/auth.service';
import { APP_ENVIRONMENT } from '../../../core/config/app-environment';
import { DEMO_ACCOUNTS, MOCK_PASSWORD } from '../../../core/mock/mock-data';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Input } from '../../../shared/ui/input/input';

/** Só aceita caminhos internos, evitando redireccionamentos para sites externos. */
function safeReturnUrl(url: string | undefined): string {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') ? url : '/';
}

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-xl font-bold tracking-tight">Entrar</h1>
    <p class="mt-1 text-sm text-fg-muted">Aceda à sua conta para continuar.</p>

    <form class="mt-6 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
      @if (error(); as message) {
        <app-alert tone="danger">{{ message }}</app-alert>
      }

      <app-input label="Email" type="email" autocomplete="username" formControlName="email" />
      <app-input
        label="Palavra-passe"
        type="password"
        autocomplete="current-password"
        formControlName="password"
      />

      <div class="text-end">
        <a
          routerLink="/auth/forgot-password"
          class="text-sm text-brand-700 hover:underline dark:text-brand-300"
        >
          Esqueceu-se da palavra-passe?
        </a>
      </div>

      <app-button type="submit" [block]="true" [loading]="loading()">Entrar</app-button>
    </form>

    @if (!isProduction) {
      <section class="mt-6 border-t border-line pt-4" aria-label="Contas de demonstração">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Contas de demonstração
        </h2>
        <ul class="mt-2 space-y-1">
          @for (account of demoAccounts; track account.email) {
            <li>
              <button
                type="button"
                class="w-full rounded-lg px-2 py-1.5 text-start text-sm hover:bg-surface-muted"
                (click)="fill(account.email)"
              >
                <span class="block font-medium">{{ account.email }}</span>
                <span class="block text-xs text-fg-muted">{{ account.description }}</span>
              </button>
            </li>
          }
        </ul>
        <p class="mt-2 text-xs text-fg-muted">Palavra-passe: {{ demoPassword }}</p>
      </section>
    }
  `,
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Vem do query param `returnUrl` (binding de inputs do router). */
  readonly returnUrl = input<string>();

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly isProduction = inject(APP_ENVIRONMENT).production;
  protected readonly demoAccounts = DEMO_ACCOUNTS;
  protected readonly demoPassword = MOCK_PASSWORD;

  protected fill(email: string): void {
    this.form.setValue({ email, password: MOCK_PASSWORD });
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.error.set(null);
    this.loading.set(true);
    this.auth
      .login(this.form.getRawValue())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: () => void this.router.navigateByUrl(safeReturnUrl(this.returnUrl())),
        error: (e: ApiError) => this.error.set(e.message),
      });
  }
}
