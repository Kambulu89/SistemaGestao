import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { StatusBadge } from '../ui/status-badge';
import type { PlatformTenant } from './types';

const LIMIT = 25;

@Component({
  selector: 'app-platform-tenants',
  imports: [FormsModule, EntityListPage, FilterBar, DataTable, CellDef, ErrorAlert, StatusBadge],
  template: `
    <app-entity-list-page
      title="Empresas (plataforma)"
      subtitle="Tenants, estado e subscrição. Sem acesso aos dados de negócio."
    >
      <button actions type="button" class="btn-primary" (click)="showCreate.set(!showCreate())">
        Nova empresa
      </button>
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
      <app-filter-bar id="tenants" label="empresas" placeholder="Código ou nome" [state]="list" />
      <app-data-table
        label="Empresas"
        tableId="platform-tenants"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="list.q() ? 'Sem empresas com esta pesquisa.' : 'Ainda não há empresas.'"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
        <ng-template appCell="subscriptionStatus" let-row
          ><app-status-badge [status]="row.subscriptionStatus ?? null"
        /></ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class PlatformTenants {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly list = new ListState<PlatformTenant>(this.api, {
    url: 'platform/tenants',
    limit: LIMIT,
  });
  protected readonly columns: Column<PlatformTenant>[] = [
    { key: 'code', label: 'Código', required: true, link: (t) => ['/plataforma/empresas', t.id] },
    { key: 'name', label: 'Nome' },
    {
      key: 'country',
      label: 'País/moeda',
      value: (t) => `${t.countryCode} / ${t.defaultCurrency}`,
    },
    { key: 'status', label: 'Estado' },
    { key: 'subscriptionStatus', label: 'Subscrição' },
  ];
  protected readonly showCreate = signal(false);
  protected readonly action = new Action();
  protected form = {
    code: '',
    name: '',
    countryCode: 'AO',
    defaultCurrency: 'AOA',
    adminEmail: '',
  };
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
