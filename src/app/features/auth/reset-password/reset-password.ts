import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { AuthService } from '../../../core/auth/auth.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Input } from '../../../shared/ui/input/input';

/** Define a nova palavra-passe com o token da ligação enviada por email (uso único). */
@Component({
  selector: 'app-reset-password',
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <h1 class="text-xl font-bold tracking-tight">Nova palavra-passe</h1>

    @if (done()) {
      <app-alert class="mt-6" tone="success">
        Palavra-passe alterada. Por segurança, todas as sessões foram terminadas.
      </app-alert>
      <p class="mt-6 text-center text-sm">
        <a routerLink="/auth/login" class="text-brand-700 hover:underline dark:text-brand-300">
          Entrar
        </a>
      </p>
    } @else if (!token()) {
      <app-alert class="mt-6" tone="danger">
        A ligação é inválida. Peça uma nova em "Recuperar palavra-passe".
      </app-alert>
    } @else {
      <p class="mt-1 text-sm text-fg-muted">
        Escolha uma palavra-passe com pelo menos 12 caracteres.
      </p>
      <form class="mt-6 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        @if (error(); as message) {
          <app-alert tone="danger">{{ message }}</app-alert>
        }
        <app-input
          label="Nova palavra-passe"
          type="password"
          autocomplete="new-password"
          formControlName="password"
          [required]="true"
        />
        <app-button type="submit" [block]="true" [loading]="loading()"
          >Alterar palavra-passe</app-button
        >
      </form>
    }
  `,
})
export class ResetPassword {
  private readonly auth = inject(AuthService);

  /** Vem do query param `token` (binding de inputs do router). */
  readonly token = input<string>();

  protected readonly form = inject(NonNullableFormBuilder).group({
    password: ['', [Validators.required, Validators.minLength(12), Validators.maxLength(128)]],
  });
  protected readonly loading = signal(false);
  protected readonly done = signal(false);
  protected readonly error = signal<string | null>(null);

  protected submit(): void {
    const token = this.token();
    if (!token) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.error.set(null);
    this.loading.set(true);
    this.auth
      .resetPassword(token, this.form.getRawValue().password)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: () => this.done.set(true),
        // Token inválido/expirado/usado ou palavra-passe fraca: a mensagem do servidor já é clara.
        error: (e: ApiError) => this.error.set(e.fieldErrors?.[0]?.message ?? e.message),
      });
  }
}
