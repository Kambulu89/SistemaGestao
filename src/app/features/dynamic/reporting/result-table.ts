import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Alert } from '../../../shared/ui/alert/alert';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { formatCell } from './reporting-model';
import type { RunResultDto } from './reporting.api';

/** Tabela de um resultado: valores como texto (decimais exactos), campos omitidos e frescura dos dados. */
@Component({
  selector: 'app-result-table',
  imports: [Alert, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (result().omittedFields.length > 0) {
      <app-alert tone="warning" class="mb-2 block" data-testid="omitted">
        Não tem acesso a: {{ result().omittedFields.join(', ') }}. Esses campos não vêm no
        resultado.
      </app-alert>
    }
    <app-table caption="Resultado" [columns]="columns()" [rows]="result().rows">
      <ng-template let-row let-column="column">{{ cell(row, column.key) }}</ng-template>
    </app-table>
    <p class="mt-2 text-xs text-fg-muted" data-testid="freshness">
      {{ result().total }} {{ result().total === 1 ? 'linha' : 'linhas' }} · dados lidos em tempo
      real às {{ result().asOf.slice(11, 19) }} (UTC)
    </p>
  `,
})
export class ResultTable {
  readonly result = input.required<RunResultDto>();

  protected columns(): readonly TableColumn[] {
    return this.result().columns.map((c) => ({
      key: c.code,
      label: c.label,
      align: c.type === 'decimal' || c.type === 'measure' || c.type === 'integer' ? 'end' : 'start',
    }));
  }

  protected cell(row: Record<string, unknown>, key: string): string {
    const type = this.result().columns.find((c) => c.code === key)?.type ?? 'string';
    return formatCell(row[key], type);
  }
}
