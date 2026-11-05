import { Component, input } from '@angular/core';
import type { ApiError } from '../core/api';

/** Mensagem de erro da API, com os detalhes de validação sem caminho de campo e o id do pedido para suporte. */
@Component({
  selector: 'app-error-alert',
  template: `
    @if (error(); as e) {
      <div role="alert" class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        <p class="font-medium">{{ e.message }}</p>
        @if (showDetails()) {
          <ul class="mt-1 list-disc pl-5">
            @for (d of e.details; track $index) {
              <li>{{ d.path ? d.path + ': ' : '' }}{{ d.message }}</li>
            }
          </ul>
        }
        @if (e.requestId) {
          <p class="mt-1 text-xs text-red-700">Referência: {{ e.requestId }}</p>
        }
      </div>
    }
  `,
})
export class ErrorAlert {
  readonly error = input<ApiError | null>(null);
  readonly showDetails = input(true);
}
