import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../core/api';
import { Session } from '../core/session';
import { Workspace } from '../core/workspace';
import { ErrorAlert } from '../ui/error-alert';
import { statusLabel } from '../ui/labels';

/** Escolha da empresa: só as memberships activas em empresas activas dão acesso. */
@Component({
  selector: 'app-tenant-select',
  imports: [RouterLink, ErrorAlert],
  template: `
    <main class="mx-auto max-w-xl px-4 py-12">
      <h1 class="text-2xl font-semibold">Escolher empresa</h1>
      <p class="mt-1 text-sm text-muted">Sessão de {{ session.user()?.fullName }}.</p>
      <div class="mt-4"><app-error-alert [error]="error()" /></div>
      @if (session.tenants().length === 0) {
        <p class="card mt-6 text-sm text-fg">
          Ainda não pertence a nenhuma empresa. Peça um convite ao administrador da sua empresa.
        </p>
      } @else {
        <ul class="mt-6 space-y-2">
          @for (t of session.tenants(); track t.id) {
            <li>
              <button
                type="button"
                class="card flex w-full items-center justify-between text-left hover:border-primary disabled:opacity-60"
                [disabled]="!t.available || busy()"
                (click)="choose(t.id)"
              >
                <span>
                  <span class="block font-medium">{{ t.name }}</span>
                  <span class="text-xs text-muted">{{ t.code }}</span>
                </span>
                @if (!t.available) {
                  <span class="text-xs text-muted">
                    {{
                      t.status !== 'ACTIVE'
                        ? 'Empresa ' + label(t.status)
                        : 'Acesso ' + label(t.membershipStatus)
                    }}
                  </span>
                }
              </button>
            </li>
          }
        </ul>
      }
      <div class="mt-8 flex flex-wrap gap-3">
        @if (session.user()?.isPlatformAdmin) {
          <a routerLink="/plataforma/empresas" class="btn-secondary">Administração da plataforma</a>
        }
        <button type="button" class="btn-secondary" (click)="logout()">Sair</button>
      </div>
    </main>
  `,
})
export class TenantSelect {
  protected readonly session = inject(Session);
  private readonly workspace = inject(Workspace);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly label = statusLabel;

  protected async choose(id: string) {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.workspace.select(id);
      await this.router.navigateByUrl('/painel');
    } catch (error) {
      this.error.set(ApiError.from(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async logout() {
    await this.session.logout();
    this.workspace.reset();
    await this.router.navigateByUrl('/entrar');
  }
}
