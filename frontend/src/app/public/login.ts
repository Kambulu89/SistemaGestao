import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Session } from '../core/session';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { AuthLayout } from './auth-layout';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink, AuthLayout, ErrorAlert],
  template: `
    <app-auth-layout title="Entrar">
      <form class="space-y-4" (ngSubmit)="submit()" novalidate>
        <app-error-alert [error]="action.error()" [showDetails]="false" />
        <div>
          <label class="label" for="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            class="input"
            autocomplete="username"
            required
            [(ngModel)]="email"
          />
        </div>
        <div>
          <label class="label" for="password">Palavra-passe</label>
          <input
            id="password"
            name="password"
            type="password"
            class="input"
            autocomplete="current-password"
            required
            [(ngModel)]="password"
          />
        </div>
        <button
          type="submit"
          class="btn-primary w-full"
          [disabled]="action.busy() || !email() || !password()"
        >
          {{ action.busy() ? 'A entrar…' : 'Entrar' }}
        </button>
        <p class="text-center">
          <a routerLink="/recuperar" class="btn-link">Esqueci-me da palavra-passe</a>
        </p>
      </form>
    </app-auth-layout>
  `,
})
export class Login {
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly action = new Action();

  protected async submit() {
    const me = await this.action.run(() =>
      this.session.login(this.email().trim(), this.password()),
    );
    if (!me) {
      this.password.set('');
      return;
    }
    const next = this.route.snapshot.queryParamMap.get('next');
    await this.router.navigateByUrl(
      next && next.startsWith('/') && !next.startsWith('//') ? next : '/',
    );
  }
}
