import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { Pager } from '../ui/pager';
import { StatusBadge } from '../ui/status-badge';
import type { PlatformTenant } from './types';

const LIMIT = 25;

@Component({
  selector: 'app-platform-tenants',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, Pager, StatusBadge],
  template: `
    <app-page-header
      title="Empresas (plataforma)"
      subtitle="Tenants, estado e subscrição. Sem acesso aos dados de negócio."
    >
      <button type="button" class="btn-primary" (click)="showCreate.set(!showCreate())">
        Nova empresa
      </button>
    </app-page-header>
    @if (showCreate()) {
      <form
        class="card mb-6 grid gap-3 md:grid-cols-5"
        (ngSubmit)="create()"
        aria-label="Nova empresa"
      >
        <div>
          <label class="label" for="t-code">Código *</label>
          <input id="t-code" name="code" class="input uppercase" [(ngModel)]="form.code" />
        </div>
        <div class="md:col-span-2">
          <label class="label" for="t-name">Nome *</label>
          <input id="t-name" name="name" class="input" [(ngModel)]="form.name" />
        </div>
        <div>
          <label class="label" for="t-country">País *</label>
          <input
            id="t-country"
            name="countryCode"
            class="input uppercase"
            maxlength="2"
            [(ngModel)]="form.countryCode"
          />
        </div>
        <div>
          <label class="label" for="t-currency">Moeda *</label>
          <input
            id="t-currency"
            name="defaultCurrency"
            class="input uppercase"
            maxlength="3"
            [(ngModel)]="form.defaultCurrency"
          />
        </div>
        <div class="md:col-span-3">
          <label class="label" for="t-admin">Email do administrador (conta existente) *</label>
          <input
            id="t-admin"
            name="adminEmail"
            type="email"
            class="input"
            [(ngModel)]="form.adminEmail"
          />
        </div>
        <div class="flex items-end md:col-span-2">
          <button type="submit" class="btn-primary" [disabled]="action.busy()">Criar</button>
        </div>
        <div class="md:col-span-5"><app-error-alert [error]="action.error()" /></div>
      </form>
    }
    <form class="mb-4 flex flex-wrap gap-2" role="search" (ngSubmit)="go(0)">
      <label class="sr-only" for="q">Pesquisar</label>
      <input id="q" name="q" class="input max-w-xs" placeholder="Código ou nome" [(ngModel)]="q" />
      <button type="submit" class="btn-secondary">Pesquisar</button>
    </form>
    <app-error-alert [error]="page.error()" />
    @if (page.loading()) {
      <p class="text-sm text-slate-500">A carregar…</p>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="table" aria-label="Empresas">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nome</th>
              <th>País/moeda</th>
              <th>Estado</th>
              <th>Subscrição</th>
            </tr>
          </thead>
          <tbody>
            @for (t of page.value()?.items; track t.id) {
              <tr>
                <td>
                  <a class="btn-link" [routerLink]="['/plataforma/empresas', t.id]">{{ t.code }}</a>
                </td>
                <td>{{ t.name }}</td>
                <td>{{ t.countryCode }} / {{ t.defaultCurrency }}</td>
                <td><app-status-badge [status]="t.status" /></td>
                <td><app-status-badge [status]="t.subscriptionStatus ?? null" /></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <app-pager
        [total]="page.value()?.total ?? 0"
        [limit]="limit"
        [offset]="offset()"
        (offsetChange)="go($event)"
      />
    }
  `,
})
export class PlatformTenants {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly limit = LIMIT;
  protected readonly q = signal('');
  protected readonly offset = signal(0);
  protected readonly showCreate = signal(false);
  protected readonly action = new Action();
  protected form = {
    code: '',
    name: '',
    countryCode: 'AO',
    defaultCurrency: 'AOA',
    adminEmail: '',
  };
  protected readonly page = new Loadable(() =>
    this.api.page<PlatformTenant>('platform/tenants', {
      q: this.q().trim() || undefined,
      limit: LIMIT,
      offset: this.offset(),
    }),
  );

  constructor() {
    void this.page.load();
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected async create() {
    const tenant = await this.action.run(() =>
      this.api.post<PlatformTenant>('platform/tenants', {
        ...this.form,
        code: this.form.code.trim().toUpperCase(),
        countryCode: this.form.countryCode.trim().toUpperCase(),
        defaultCurrency: this.form.defaultCurrency.trim().toUpperCase(),
      }),
    );
    if (tenant) await this.router.navigate(['/plataforma/empresas', tenant.id]);
  }
}
