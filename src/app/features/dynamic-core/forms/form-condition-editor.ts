import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ConditionDto } from '../../../core/dynamic/http/dynamic-dto';
import { Button } from '../../../shared/ui/button/button';
import { Input } from '../../../shared/ui/input/input';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import {
  buildFormCondition,
  describeFormCondition,
  FORM_CLAUSE_OPERATORS,
  parseFormCondition,
  type ConditionKind,
  type FormClause,
  type FormClauseOperator,
  type FormConditionDraft,
} from './form-condition';

export interface ConditionField {
  /** Código do campo no servidor. */
  readonly code: string;
  readonly label: string;
  readonly kind: ConditionKind;
}

const EMPTY_CLAUSE: FormClause = { field: '', operator: 'eq', value: '' };

/**
 * Editor de uma condição de apresentação («mostrar quando…»). Só constrói comparações ligadas por «e»/«ou»; uma
 * condição mais rica mostra-se descrita e mantém-se até ser substituída. Emite `undefined` ao retirar.
 */
@Component({
  selector: 'app-form-condition-editor',
  imports: [FormsModule, Button, Input, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="text-sm">
      <span class="font-medium">{{ label() }}:</span>
      @if (!editing()) {
        @if (condition(); as current) {
          <span class="ms-1 text-fg-muted" [attr.data-testid]="testId() + '-summary'">{{
            describe(current)
          }}</span>
          <app-button size="sm" variant="secondary" class="ms-2" (click)="start()"
            >Alterar</app-button
          >
          <app-button size="sm" variant="secondary" class="ms-1" (click)="clear()"
            >Retirar</app-button
          >
        } @else {
          <span class="ms-1 text-fg-muted">sempre</span>
          <app-button size="sm" variant="secondary" class="ms-2" (click)="start()"
            >Definir condição</app-button
          >
        }
      } @else {
        <div class="mt-2 space-y-2 rounded-lg border border-line p-3" [attr.data-testid]="testId()">
          @if (clauses().length > 1) {
            <app-select
              label="Ligar as condições com"
              [ngModel]="join()"
              (ngModelChange)="join.set($event === 'or' ? 'or' : 'and')"
              [options]="joins"
            />
          }
          @for (clause of clauses(); track $index; let i = $index) {
            <div class="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
              <app-select
                label="Campo"
                [ngModel]="clause.field"
                (ngModelChange)="patch(i, { field: $event ?? '' })"
                [options]="fieldOptions()"
              />
              <app-select
                label="Condição"
                [ngModel]="clause.operator"
                (ngModelChange)="patch(i, { operator: operatorOf($event) })"
                [options]="operators"
              />
              @if (clause.operator !== 'empty' && clause.operator !== 'notEmpty') {
                <app-input
                  label="Valor"
                  [ngModel]="clause.value"
                  (ngModelChange)="patch(i, { value: $event ?? '' })"
                />
              } @else {
                <span></span>
              }
              <app-button size="sm" variant="secondary" (click)="removeClause(i)"
                >Remover</app-button
              >
            </div>
          }
          @if (message(); as text) {
            <p class="text-sm text-red-600 dark:text-red-400" role="alert">{{ text }}</p>
          }
          <div class="flex gap-2">
            <app-button size="sm" variant="secondary" (click)="addClause()"
              >Adicionar condição</app-button
            >
            <app-button size="sm" (click)="apply()">Aplicar</app-button>
            <app-button size="sm" variant="secondary" (click)="editing.set(false)"
              >Cancelar</app-button
            >
          </div>
        </div>
      }
    </div>
  `,
})
export class FormConditionEditor {
  readonly label = input.required<string>();
  readonly condition = input<ConditionDto | undefined>(undefined);
  readonly fields = input.required<readonly ConditionField[]>();
  /** Distingue vários editores na mesma página (testes e acessibilidade). */
  readonly testId = input('condition');
  readonly changed = output<ConditionDto | undefined>();

  protected readonly editing = signal(false);
  protected readonly join = signal<'and' | 'or'>('and');
  protected readonly clauses = signal<readonly FormClause[]>([EMPTY_CLAUSE]);
  protected readonly message = signal<string | null>(null);

  protected readonly operators: readonly SelectOption[] = FORM_CLAUSE_OPERATORS;
  protected readonly joins: readonly SelectOption[] = [
    { value: 'and', label: 'todas (e)' },
    { value: 'or', label: 'qualquer uma (ou)' },
  ];
  protected readonly fieldOptions = computed<readonly SelectOption[]>(() =>
    this.fields().map((f) => ({ value: f.code, label: f.label })),
  );

  protected operatorOf(value: string | null): FormClauseOperator {
    return FORM_CLAUSE_OPERATORS.find((o) => o.value === value)?.value ?? 'eq';
  }

  protected describe(condition: ConditionDto): string {
    const labels = new Map(this.fields().map((f) => [f.code, f.label]));
    return describeFormCondition(condition, (code) => labels.get(code) ?? code);
  }

  protected start(): void {
    const draft: FormConditionDraft | null = parseFormCondition(this.condition());
    this.join.set(draft?.join ?? 'and');
    this.clauses.set(draft?.clauses ?? [EMPTY_CLAUSE]);
    this.message.set(null);
    this.editing.set(true);
  }

  protected patch(index: number, patch: Partial<FormClause>): void {
    this.clauses.update((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  protected addClause(): void {
    this.clauses.update((list) => [...list, EMPTY_CLAUSE]);
  }

  protected removeClause(index: number): void {
    this.clauses.update((list) => list.filter((_, i) => i !== index));
  }

  protected clear(): void {
    this.changed.emit(undefined);
  }

  protected apply(): void {
    const kinds = new Map(this.fields().map((f) => [f.code, f.kind]));
    const built = buildFormCondition({ join: this.join(), clauses: this.clauses() }, (code) =>
      kinds.get(code),
    );
    if (!built.ok) {
      this.message.set(built.message);
      return;
    }
    this.editing.set(false);
    this.changed.emit(built.condition);
  }
}
