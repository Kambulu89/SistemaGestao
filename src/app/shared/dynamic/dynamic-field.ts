import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type FormControl, ReactiveFormsModule } from '@angular/forms';
import type { FieldState } from '../../core/dynamic/engine/field-state';
import {
  type FieldDefinition,
  type FieldValue,
  hasOptions,
} from '../../core/dynamic/models/field-definition.model';
import { Checkbox } from '../ui/checkbox/checkbox';
import { CheckboxGroup } from '../ui/checkbox-group/checkbox-group';
import { FileInput } from '../ui/file-input/file-input';
import { Input, type InputType } from '../ui/input/input';
import { Select } from '../ui/select/select';
import { Textarea } from '../ui/textarea/textarea';
import { DynamicReferenceField } from './dynamic-reference-field';

const INPUT_TYPES: Partial<Record<FieldDefinition['type'], InputType>> = {
  text: 'text',
  email: 'email',
  phone: 'tel',
  number: 'number',
  decimal: 'number',
  currency: 'number',
  date: 'date',
  datetime: 'datetime-local',
};

/**
 * Escolhe o controlo de UI adequado ao tipo do campo e liga-o ao `FormControl`. É o único sítio
 * que conhece o mapeamento tipo → componente; nada aqui é específico de uma entidade.
 */
@Component({
  selector: 'app-dynamic-field',
  imports: [
    ReactiveFormsModule,
    Input,
    Textarea,
    Select,
    Checkbox,
    CheckboxGroup,
    FileInput,
    DynamicReferenceField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @switch (kind()) {
      @case ('input') {
        <app-input
          [formControl]="control()"
          [label]="field().label"
          [hint]="field().description"
          [required]="state().required"
          [type]="inputType()"
          [placeholder]="field().placeholder"
          [step]="step()"
          [suffix]="suffix()"
        />
      }
      @case ('textarea') {
        <app-textarea
          [formControl]="control()"
          [label]="field().label"
          [hint]="field().description"
          [required]="state().required"
          [placeholder]="field().placeholder"
        />
      }
      @case ('boolean') {
        <app-checkbox
          [formControl]="control()"
          [label]="field().label"
          [hint]="field().description"
        />
      }
      @case ('select') {
        <app-select
          [formControl]="control()"
          [label]="field().label"
          [hint]="field().description"
          [required]="state().required"
          [options]="options()"
        />
      }
      @case ('multiselect') {
        <app-checkbox-group
          [formControl]="control()"
          [label]="field().label"
          [hint]="field().description"
          [required]="state().required"
          [options]="options()"
        />
      }
      @case ('file') {
        <app-file-input
          [formControl]="control()"
          [label]="field().label"
          [hint]="field().description"
          [required]="state().required"
          [multiple]="multiple()"
          [accept]="accept()"
        />
      }
      @case ('entity-reference') {
        <app-dynamic-reference-field
          [control]="control()"
          [entityKey]="referenceKey()"
          [label]="field().label"
          [hint]="field().description"
          [required]="state().required"
        />
      }
    }
  `,
})
export class DynamicField {
  readonly field = input.required<FieldDefinition>();
  readonly control = input.required<FormControl<FieldValue>>();
  readonly state = input.required<FieldState>();

  protected readonly kind = computed(() => {
    const type = this.field().type;
    return type in INPUT_TYPES ? 'input' : type;
  });

  protected readonly inputType = computed<InputType>(
    () => INPUT_TYPES[this.field().type] ?? 'text',
  );

  protected readonly step = computed(() => {
    const f = this.field();
    if (f.type === 'decimal') return f.scale !== undefined ? 10 ** -f.scale : 'any';
    if (f.type === 'currency') return 0.01;
    return f.type === 'number' ? 1 : undefined;
  });

  protected readonly suffix = computed(() => {
    const f = this.field();
    return f.type === 'currency' ? f.currency : undefined;
  });

  protected readonly options = computed(() => {
    const f = this.field();
    return hasOptions(f) ? f.options : [];
  });

  protected readonly multiple = computed(() => {
    const f = this.field();
    return f.type === 'file' ? (f.multiple ?? false) : false;
  });

  protected readonly accept = computed(() => {
    const f = this.field();
    return f.type === 'file' ? f.accept?.join(',') : undefined;
  });

  protected readonly referenceKey = computed(() => {
    const f = this.field();
    return f.type === 'entity-reference' ? f.entityKey : '';
  });
}
