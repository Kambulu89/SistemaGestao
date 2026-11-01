import type { FieldDefinition } from '../../../core/dynamic/models/field-definition.model';
import type { ValueKind } from './rule-condition';

/**
 * Como o motor de condições do servidor compara o valor de um campo (decimais em texto, números como número…);
 * `null` para os tipos que não se comparam (referências, multi-selecção, ficheiros…). Usado pelos editores de regras
 * e de guardas de transições, que partilham a mesma gramática.
 */
export function ruleValueKind(field: FieldDefinition): ValueKind | null {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'decimal':
    case 'formula':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'url':
    case 'date':
    case 'datetime':
    case 'select':
    case 'radio':
      return 'text';
    default:
      return null;
  }
}
