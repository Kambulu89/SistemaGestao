import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'app-forgot-password',
  imports: [FormsModule, RouterLink, AuthLayout, ErrorAlert],
  template: `
    <app-auth-layout title="Recuperar palavra-passe">
      @if (sent()) {
        <p class="text-sm text-fg" role="status">
          Se existir uma conta com esse email, foi enviada uma ligação para definir uma nova
          palavra-passe.
        </p>
      } @else {
        <form class="space-y-4" (ngSubmit)="submit()">
          <app-error-alert [error]="action.error()" />
          <div>
            <label class="label" for="email">Email da conta</label>
            <input
              id="email"
              name="email"
              type="email"
              class="input"
              required
              [(ngModel)]="email"
            />
          </div>
          <button type="submit" class="btn-primary w-full" [disabled]="action.busy() || !email()">
            Enviar ligação
          </button>
        </form>
      }
      <p class="mt-4 text-center"><a routerLink="/entrar" class="btn-link">Voltar ao login</a></p>
    </app-auth-layout>
  `,
})
export class ForgotPassword {
  private readonly api = inject(Api);
  protected readonly email = signal('');
  protected readonly sent = signal(false);
  protected readonly action = new Action();

  protected async submit() {
    const done = await this.action.run(() =>
      this.api.post('auth/password/forgot', { email: this.email().trim() }),
    );
    if (done) this.sent.set(true);
  }
}
