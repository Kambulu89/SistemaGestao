import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { type FormControl, ReactiveFormsModule } from '@angular/forms';
import { EntityRecordsGateway } from '../../core/dynamic/data-access/entity-records.gateway';
import type { FieldValue } from '../../core/dynamic/models/field-definition.model';
import { Select, type SelectOption } from '../ui/select/select';

/** Campo `reference`: uma lista com os registos da entidade alvo, obtidos pelo gateway. */
@Component({
  selector: 'app-dynamic-reference-field',
  imports: [ReactiveFormsModule, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-select
      [formControl]="control()"
      [label]="label()"
      [hint]="hint()"
      [required]="required()"
      [options]="options()"
      [placeholder]="loading() ? 'A carregar…' : 'Seleccione…'"
    />
  `,
})
export class DynamicReferenceField {
  private readonly gateway = inject(EntityRecordsGateway);

  readonly entityKey = input.required<string>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly required = input(false);
  readonly control = input.required<FormControl<FieldValue>>();

  private readonly lookup = rxResource({
    params: () => this.entityKey(),
    stream: ({ params }) => this.gateway.lookup(params, {}),
  });

  protected readonly loading = computed(() => this.lookup.isLoading());

  /** Inclui o valor actual mesmo que não esteja entre as opções carregadas (ex.: paginação do alvo). */
  protected readonly options = computed<readonly SelectOption[]>(() => {
    const loaded = (this.lookup.value() ?? []).map((o) => ({ value: o.id, label: o.label }));
    const current = this.control().value;
    return typeof current === 'string' && current && !loaded.some((o) => o.value === current)
      ? [...loaded, { value: current, label: current }]
      : loaded;
  });
}
