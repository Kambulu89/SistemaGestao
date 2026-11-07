import { Component, input, output } from '@angular/core';
import type { ApiError } from '../core/api';
import { Icon } from './icon';

/** Estado vazio com mensagem e acção opcional (projectada). */
@Component({
  selector: 'app-empty-state',
  imports: [Icon],
  template: `
    <div class="card flex flex-col items-center gap-2 py-10 text-center">
      <app-icon [name]="icon()" [size]="28" />
      <p class="font-medium">{{ title() }}</p>
      @if (description()) {
        <p class="max-w-md text-sm text-muted">{{ description() }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
  readonly icon = input('info');
}

/** Erro de carregamento com repetição; mostra o código de referência para suporte. */
@Component({
  selector: 'app-error-state',
  imports: [Icon],
  template: `
    <div
      role="alert"
      class="card flex flex-col items-center gap-2 border-danger-border bg-danger-soft py-8 text-center text-danger-text"
    >
      <app-icon name="alert" [size]="28" />
      <p class="font-medium">
        {{
          error()?.status === 403
            ? 'Sem acesso.'
            : error()?.status === 0
              ? 'Sem ligação ao servidor.'
              : 'Não foi possível carregar.'
        }}
      </p>
      <p class="text-sm">{{ error()?.message }}</p>
      @if (error()?.requestId) {
        <p class="text-xs">Referência: {{ error()?.requestId }}</p>
      }
      @if (error()?.status !== 403) {
        <button type="button" class="btn-secondary mt-2" (click)="retry.emit()">
          Tentar de novo
        </button>
      }
    </div>
  `,
})
export class ErrorState {
  readonly error = input<ApiError | null>(null);
  readonly retry = output();
}

/** Linhas de esqueleto enquanto carrega (com texto alternativo para leitores de ecrã). */
@Component({
  selector: 'app-skeleton',
  template: `
    <div class="space-y-2" role="status" aria-label="A carregar">
      @for (i of rows; track i) {
        <span class="skeleton block h-4" [style.width.%]="90 - i * 10"></span>
      }
    </div>
  `,
})
export class Skeleton {
  protected readonly rows = [0, 1, 2];
}

/**
 * Acesso negado dentro de uma página (permissão em falta, funcionalidade não contratada ou fora do âmbito
 * organizacional). Diz o que falta sem expor dados; a API continua a ser quem decide.
 */
@Component({
  selector: 'app-access-denied',
  imports: [Icon],
  template: `
    <div class="card flex flex-col items-center gap-2 py-10 text-center" role="status">
      <app-icon name="lock" [size]="28" />
      <p class="font-medium">{{ title() }}</p>
      <p class="max-w-md text-sm text-muted">
        @switch (reason()) {
          @case ('feature') {
            Esta funcionalidade não está incluída na subscrição da empresa.
          }
          @case ('scope') {
            O registo está fora do seu âmbito organizacional (entidade legal ou filial).
          }
          @default {
            Não tem permissão para esta área. Peça acesso a um administrador da empresa.
          }
        }
      </p>
      @if (permission()) {
        <p class="text-xs text-muted">
          Permissão necessária: <code>{{ permission() }}</code>
        </p>
      }
      <ng-content />
    </div>
  `,
})
export class AccessDenied {
  readonly title = input('Sem acesso');
  readonly reason = input<'permission' | 'feature' | 'scope'>('permission');
  readonly permission = input<string | null>(null);
}
