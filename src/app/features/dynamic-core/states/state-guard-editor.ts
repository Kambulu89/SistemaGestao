import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from '../../../shared/ui/button/button';
import { Input } from '../../../shared/ui/input/input';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import {
  buildCondition,
  CLAUSE_OPERATORS,
  describeRuleCondition,
  parseCondition,
  type Clause,
  type ClauseOperator,
  type ConditionDraft,
  type ValueKind,
} from '../rules/rule-condition';

export interface GuardField {
  /** Código do campo no servidor. */
  readonly code: string;
  readonly label: string;
  readonly kind: ValueKind;
}

const EMPTY: Clause = { field: '', operator: 'eq', value: '' };

/**
 * Editor da guarda de uma transição («só pode executar quando…»). Constrói comparações de campos do registo ligadas por
 * «e»/«ou» na gramática das políticas de acesso; uma guarda mais rica mostra-se como «avançada» e mantém-se até ser
 * substituída. Emite `undefined` ao retirar.
 */
@Component({
  selector: 'app-state-guard-editor',
  imports: [FormsModule, Button, Input, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="text-sm">
      <span class="font-medium">Só quando:</span>
      @if (!editing()) {
        @if (guard() !== undefined) {
          <span class="ms-1 text-fg-muted" [attr.data-testid]="testId() + '-summary'">{{
            summary()
          }}</span>
          <app-button size="sm" variant="secondary" class="ms-2" (click)="start()"
            >Alterar</app-button
          >
          <app-button size="sm" variant="secondary" class="ms-1" (click)="changed.emit(undefined)"
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
              @if (clause.operator !== 'filled' && clause.operator !== 'empty') {
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
export class StateGuardEditor {
  readonly guard = input<unknown>(undefined);
  readonly fields = input.required<readonly GuardField[]>();
  readonly testId = input('guard');
  readonly changed = output<unknown>();

  protected readonly editing = signal(false);
  protected readonly join = signal<'and' | 'or'>('and');
  protected readonly clauses = signal<readonly Clause[]>([EMPTY]);
  protected readonly message = signal<string | null>(null);

  protected readonly operators: readonly SelectOption[] = CLAUSE_OPERATORS;
  protected readonly joins: readonly SelectOption[] = [
    { value: 'and', label: 'todas (e)' },
    { value: 'or', label: 'qualquer uma (ou)' },
  ];
  protected readonly fieldOptions = computed<readonly SelectOption[]>(() =>
    this.fields().map((f) => ({ value: f.code, label: f.label })),
  );

  protected readonly summary = computed(() => {
    const labels = new Map(this.fields().map((f) => [f.code, f.label]));
    return (
      describeRuleCondition(this.guard(), (code) => labels.get(code) ?? code) ??
      'condição avançada (mantém-se como está)'
    );
  });

  protected operatorOf(value: string | null): ClauseOperator {
    return CLAUSE_OPERATORS.find((o) => o.value === value)?.value ?? 'eq';
  }

  protected start(): void {
    const draft: ConditionDraft | null = parseCondition(this.guard());
    this.join.set(draft?.join ?? 'and');
    this.clauses.set(draft?.clauses ?? [EMPTY]);
    this.message.set(null);
    this.editing.set(true);
  }

  protected patch(index: number, patch: Partial<Clause>): void {
    this.clauses.update((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  protected addClause(): void {
    this.clauses.update((list) => [...list, EMPTY]);
  }

  protected removeClause(index: number): void {
    this.clauses.update((list) => list.filter((_, i) => i !== index));
  }

  protected apply(): void {
    const kinds = new Map(this.fields().map((f) => [f.code, f.kind]));
    const built = buildCondition({ join: this.join(), clauses: this.clauses() }, (code) =>
      kinds.get(code),
    );
    if (!built.ok) {
      this.message.set(built.message);
      return;
    }
    this.editing.set(false);
    this.changed.emit(built.ast);
  }
}
