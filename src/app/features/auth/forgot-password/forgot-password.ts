import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { AuthService } from '../../../core/auth/auth.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Input } from '../../../shared/ui/input/input';

@Component({
  selector: 'app-forgot-password',
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <h1 class="text-xl font-bold tracking-tight">Recuperar palavra-passe</h1>
    <p class="mt-1 text-sm text-fg-muted">
      Indique o seu email e enviaremos instruções para definir uma nova palavra-passe.
    </p>

    @if (sent()) {
      <app-alert class="mt-6" tone="success">
        Se existir uma conta com esse email, receberá as instruções em breve.
      </app-alert>
    } @else {
      <form class="mt-6 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        @if (error(); as message) {
          <app-alert tone="danger">{{ message }}</app-alert>
        }
        <app-input label="Email" type="email" autocomplete="email" formControlName="email" />
        <app-button type="submit" [block]="true" [loading]="loading()"
          >Enviar instruções</app-button
        >
      </form>
    }

    <p class="mt-6 text-center text-sm">
      <a routerLink="/auth/login" class="text-brand-700 hover:underline dark:text-brand-300">
        Voltar a entrar
      </a>
    </p>
  `,
})
export class ForgotPassword {
  private readonly auth = inject(AuthService);

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
  });
  protected readonly loading = signal(false);
  protected readonly sent = signal(false);
  protected readonly error = signal<string | null>(null);

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.error.set(null);
    this.loading.set(true);
    this.auth
      .requestPasswordReset(this.form.getRawValue().email)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        // Resposta igual quer o email exista ou não, para não revelar contas.
        next: () => this.sent.set(true),
        error: (e: ApiError) => this.error.set(e.message),
      });
  }
}
