import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { EntityRecordsGateway } from '../../core/dynamic/data-access/entity-records.gateway';
import { formatFieldValue } from '../../core/dynamic/engine/format-value';
import type { FieldDefinition, FieldValue } from '../../core/dynamic/models/field-definition.model';

/** Valor de um campo em modo de leitura. Referências mostram o rótulo do registo, não o id. */
@Component({
  selector: 'app-dynamic-value',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ text() }}`,
})
export class DynamicValue {
  private readonly gateway = inject(EntityRecordsGateway, { optional: true });

  readonly field = input.required<FieldDefinition>();
  readonly value = input<FieldValue | undefined>();

  private readonly referenceId = computed(() => {
    const f = this.field();
    const v = this.value();
    return f.type === 'reference' && typeof v === 'string' && v
      ? { entityKey: f.entityKey, id: v }
      : null;
  });

  private readonly label = rxResource({
    params: () => this.referenceId() ?? undefined,
    stream: ({ params }) => this.gateway!.lookup(params.entityKey, { ids: [params.id] }),
  });

  protected readonly text = computed(() => {
    const reference = this.referenceId();
    if (reference && this.gateway) {
      return this.label.value()?.find((o) => o.id === reference.id)?.label ?? reference.id;
    }
    return formatFieldValue(this.field(), this.value());
  });
}
