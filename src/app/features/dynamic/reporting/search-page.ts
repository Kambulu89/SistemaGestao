import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { ReportingApi, type SearchResultDto } from './reporting.api';
import { reportingError } from './reporting-model';

/**
 * Pesquisa global. Os resultados vêm de um índice derivado e cada resultado é revalidado no servidor com o acesso de
 * quem pesquisa: o que a pessoa não pode ler nunca aparece, nem sequer o seu título.
 */
@Component({
  selector: 'app-search-page',
  imports: [FormsModule, RouterLink, Alert, Button, Card, EmptyState, Input, PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header title="Pesquisa" description="Clientes, facturas e documentos que pode ver." />
    <form class="mb-4 flex items-end gap-2" (submit)="$event.preventDefault(); submit()">
      <div class="w-80">
        <app-input
          label="Pesquisar"
          [ngModel]="text()"
          (ngModelChange)="text.set($event ?? '')"
          name="q"
        />
      </div>
      <app-button type="submit" [loading]="searching()">Pesquisar</app-button>
    </form>
    @if (error(); as message) {
      <app-alert tone="danger" class="mb-3 block" data-testid="search-error">{{
        message
      }}</app-alert>
    }
    @if (result(); as shown) {
      @if (shown.groups.length === 0) {
        <app-empty-state icon="search" title="Sem resultados" />
      } @else {
        <div class="space-y-4" data-testid="search-results">
          @for (group of shown.groups; track group.type) {
            <app-card [title]="group.label">
              <ul class="divide-y divide-line">
                @for (item of group.items; track item.id) {
                  <li class="py-2">
                    <a
                      class="font-medium text-brand-700 underline"
                      [routerLink]="link(group.path)"
                      >{{ item.title }}</a
                    >
                    <span class="block text-xs text-fg-muted">{{ item.snippet }}</span>
                  </li>
                }
              </ul>
            </app-card>
          }
        </div>
      }
      <p class="mt-3 text-xs text-fg-muted" data-testid="indexed-at">
        {{
          shown.indexedAt
            ? 'Índice actualizado em ' + shown.indexedAt.slice(0, 16).replace('T', ' ') + ' (UTC)'
            : 'O índice ainda não foi construído.'
        }}
      </p>
    }
    @if (canReindex()) {
      <app-card title="Índice" class="mt-6 block">
        <p class="mb-2 text-sm text-fg-muted">
          O índice é uma cópia derivada; reconstrua-o depois de grandes alterações.
        </p>
        <ul class="mb-3 text-sm" data-testid="index-status">
          @for (s of status.hasValue() ? status.value() : []; track s.type) {
            <li>{{ s.label }}: {{ s.documents }} documentos</li>
          }
        </ul>
        <app-button variant="secondary" [loading]="reindexing()" (click)="reindex()"
          >Reconstruir índice</app-button
        >
      </app-card>
    }
  `,
})
export class SearchPage {
  private readonly api = inject(ReportingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  protected readonly text = signal('');
  protected readonly result = signal<SearchResultDto | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly searching = signal(false);
  protected readonly reindexing = signal(false);
  private readonly tick = signal(0);

  protected readonly canReindex = computed(() => this.permissions.can('report.design'));
  protected readonly status = rxResource({
    params: () => {
      const t = this.tenant();
      return t && this.canReindex() ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.searchStatus(),
  });

  /** O destino de cada tipo vem do servidor (caminho relativo ao tenant). */
  protected link(path: string): string[] {
    return ['/t', this.tenant()?.slug ?? '', ...path.split('/').filter(Boolean)];
  }

  protected submit(): void {
    const q = this.text().trim();
    this.error.set(null);
    if (q.length < 2) {
      this.error.set('Escreva pelo menos 2 caracteres.');
      return;
    }
    this.searching.set(true);
    this.api.search(q).subscribe({
      next: (r) => {
        this.searching.set(false);
        this.result.set(r);
      },
      error: (e: unknown) => {
        this.searching.set(false);
        this.error.set(reportingError(e, 'A pesquisa falhou.'));
      },
    });
  }

  protected reindex(): void {
    this.reindexing.set(true);
    this.api.reindex().subscribe({
      next: () => {
        this.reindexing.set(false);
        this.tick.update((t) => t + 1);
      },
      error: (e: unknown) => {
        this.reindexing.set(false);
        this.error.set(reportingError(e, 'Não foi possível reconstruir o índice.'));
      },
    });
  }
}
