import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type FormControl, ReactiveFormsModule } from '@angular/forms';
import type { FieldState } from '../../core/dynamic/engine/field-state';
import {
  type FieldDefinition,
  type FieldValue,
  hasOptions,
} from '../../core/dynamic/models/field-definition.model';
import { fieldTypeDefinition } from '../../core/dynamic/engine/field-types';
import { Checkbox } from '../ui/checkbox/checkbox';
import { CheckboxGroup } from '../ui/checkbox-group/checkbox-group';
import { FileInput } from '../ui/file-input/file-input';
import { Input, type InputType } from '../ui/input/input';
import { RadioGroup } from '../ui/radio-group/radio-group';
import { Select } from '../ui/select/select';
import { Textarea } from '../ui/textarea/textarea';
import { DynamicReferenceField } from './dynamic-reference-field';

const INPUT_TYPES: Partial<Record<FieldDefinition['type'], InputType>> = {
  text: 'text',
  email: 'email',
  url: 'url',
  phone: 'tel',
  number: 'number',
  decimal: 'number',
  currency: 'number',
  date: 'date',
  datetime: 'datetime-local',
};

/** Valores atribuídos pelo servidor: o utilizador nunca os escreve. */
const COMPUTED_TYPES: ReadonlySet<FieldDefinition['type']> = new Set([
  'formula',
  'lookup',
  'auto-number',
]);

/** Tipos com controlo próprio; os restantes mostram um aviso em vez de falharem em silêncio. */
const SUPPORTED_TYPES: ReadonlySet<FieldDefinition['type']> = new Set([
  'textarea',
  'boolean',
  'checkbox',
  'select',
  'multiselect',
  'radio',
  'file',
  'image',
  'entity-reference',
]);

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
    RadioGroup,
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
      @case ('checkbox') {
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
      @case ('radio') {
        <app-radio-group
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
      @case ('image') {
        <app-file-input
          [formControl]="control()"
          [label]="field().label"
          [hint]="field().description"
          [required]="state().required"
          [multiple]="multiple()"
          [accept]="accept()"
        />
      }
      @case ('computed') {
        <div data-testid="computed-field">
          <p class="mb-1.5 text-sm font-medium">{{ field().label }}</p>
          <p
            class="rounded-lg border border-dashed border-line bg-surface-muted px-3 py-2 text-sm text-fg-muted"
          >
            Calculado automaticamente pelo servidor.
          </p>
        </div>
      }
      @case ('unsupported') {
        <div data-testid="unsupported-field" role="note">
          <p class="mb-1.5 text-sm font-medium">{{ field().label }}</p>
          <p
            class="rounded-lg border border-dashed border-line bg-surface-muted px-3 py-2 text-sm text-fg-muted"
          >
            Tipo «{{ typeLabel() }}» ainda não disponível neste formulário.
          </p>
        </div>
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
    if (type in INPUT_TYPES) return 'input';
    if (COMPUTED_TYPES.has(type)) return 'computed';
    if (!SUPPORTED_TYPES.has(type)) return 'unsupported';
    return type;
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
    if (!hasOptions(f)) return [];
    // Opções inactivas só se mostram se forem o valor já gravado (ler dados antigos).
    const current = this.control().value;
    return f.options.filter((o) => o.active !== false || o.value === current);
  });

  protected readonly typeLabel = computed(() => fieldTypeDefinition(this.field().type).label);

  protected readonly multiple = computed(() => {
    const f = this.field();
    return f.type === 'file' || f.type === 'image' ? (f.multiple ?? false) : false;
  });

  protected readonly accept = computed(() => {
    const f = this.field();
    if (f.type === 'image') return f.accept?.join(',') ?? 'image/*';
    return f.type === 'file' ? f.accept?.join(',') : undefined;
  });

  protected readonly referenceKey = computed(() => {
    const f = this.field();
    return f.type === 'entity-reference' ? f.entityKey : '';
  });
}
