import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, RouterLink, AuthLayout, ErrorAlert],
  template: `
    <app-auth-layout title="Nova palavra-passe">
      @if (!token) {
        <p class="text-sm text-red-700" role="alert">Ligação inválida: falta o código.</p>
      } @else if (done()) {
        <p class="text-sm text-slate-700" role="status">
          Palavra-passe alterada. As outras sessões foram terminadas.
        </p>
      } @else {
        <form class="space-y-4" (ngSubmit)="submit()">
          <app-error-alert [error]="action.error()" [showDetails]="false" />
          <div>
            <label class="label" for="password">Nova palavra-passe</label>
            <input
              id="password"
              name="password"
              type="password"
              class="input"
              autocomplete="new-password"
              aria-describedby="password-hint"
              [(ngModel)]="password"
            />
            <p id="password-hint" class="mt-1 text-xs text-slate-500">Entre 12 e 128 caracteres.</p>
          </div>
          <div>
            <label class="label" for="confirm">Confirmar</label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              class="input"
              autocomplete="new-password"
              [(ngModel)]="confirm"
            />
            @if (confirm() && confirm() !== password()) {
              <p class="field-error">As palavras-passe não coincidem.</p>
            }
          </div>
          <button
            type="submit"
            class="btn-primary w-full"
            [disabled]="action.busy() || password().length < 12 || confirm() !== password()"
          >
            Guardar
          </button>
        </form>
      }
      <p class="mt-4 text-center"><a routerLink="/entrar" class="btn-link">Ir para o login</a></p>
    </app-auth-layout>
  `,
})
export class ResetPassword {
  private readonly api = inject(Api);
  protected readonly token = inject(ActivatedRoute).snapshot.queryParamMap.get('token');
  protected readonly password = signal('');
  protected readonly confirm = signal('');
  protected readonly done = signal(false);
  protected readonly action = new Action();

  protected async submit() {
    const ok = await this.action.run(() =>
      this.api.post('auth/password/reset', { token: this.token, password: this.password() }),
    );
    if (ok) this.done.set(true);
  }
}
