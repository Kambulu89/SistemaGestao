import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'app-accept-invitation',
  imports: [FormsModule, RouterLink, AuthLayout, ErrorAlert],
  template: `
    <app-auth-layout title="Aceitar convite">
      @if (!token) {
        <p class="text-sm text-red-700" role="alert">
          Ligação inválida: falta o código do convite.
        </p>
      } @else if (done()) {
        <p class="text-sm text-slate-700" role="status">Convite aceite. Já pode entrar.</p>
        <p class="mt-4"><a routerLink="/entrar" class="btn-primary w-full">Entrar</a></p>
      } @else {
        <form class="space-y-4" (ngSubmit)="submit()">
          <p class="text-sm text-slate-600">
            Se ainda não tem conta, indique o nome e escolha uma palavra-passe. Se já tem, deixe a
            palavra-passe em branco e use a que já tem para entrar.
          </p>
          <app-error-alert [error]="action.error()" [showDetails]="false" />
          <div>
            <label class="label" for="fullName">Nome completo</label>
            <input
              id="fullName"
              name="fullName"
              class="input"
              autocomplete="name"
              [(ngModel)]="fullName"
            />
          </div>
          <div>
            <label class="label" for="password">Palavra-passe (conta nova)</label>
            <input
              id="password"
              name="password"
              type="password"
              class="input"
              autocomplete="new-password"
              [(ngModel)]="password"
            />
            @if (action.field('password'); as message) {
              <p class="field-error">{{ message }}</p>
            }
          </div>
          <button type="submit" class="btn-primary w-full" [disabled]="action.busy()">
            Aceitar
          </button>
        </form>
      }
    </app-auth-layout>
  `,
})
export class AcceptInvitation {
  private readonly api = inject(Api);
  protected readonly token = inject(ActivatedRoute).snapshot.queryParamMap.get('token');
  protected readonly fullName = signal('');
  protected readonly password = signal('');
  protected readonly done = signal(false);
  protected readonly action = new Action();

  protected async submit() {
    const body: Record<string, string> = { token: this.token! };
    if (this.fullName().trim()) body['fullName'] = this.fullName().trim();
    if (this.password()) body['password'] = this.password();
    const ok = await this.action.run(() => this.api.post('auth/invitations/accept', body));
    if (ok) this.done.set(true);
  }
}
