import type { AutoNumberDefinition } from '../models/field-definition.model';

export const AUTO_NUMBER_RESETS: readonly AutoNumberDefinition['reset'][] = [
  'never',
  'yearly',
  'monthly',
];

const MAX_PADDING = 12;
const MAX_PREFIX = 12;
const MAX_START = 1_000_000_000;

/** Parte do período que entra no identificador (e na chave da sequência): `''`, `2026`, `202610`. */
export function autoNumberPeriod(reset: AutoNumberDefinition['reset'], at: Date): string {
  const year = String(at.getUTCFullYear());
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  if (reset === 'yearly') return year;
  if (reset === 'monthly') return `${year}${month}`;
  return '';
}

/**
 * Identificador final: `<prefixo><período->?<sequência com zeros>`.
 * Ex.: prefixo `EQ-`, 4 dígitos, anual → `EQ-2026-0007`.
 */
export function formatAutoNumber(
  definition: AutoNumberDefinition,
  sequence: number,
  at: Date,
): string {
  const period = autoNumberPeriod(definition.reset, at);
  return `${definition.prefix}${period ? `${period}-` : ''}${String(sequence).padStart(definition.padding, '0')}`;
}

/** Problemas da configuração de uma numeração automática (vazio = válida). */
export function validateAutoNumber(definition: AutoNumberDefinition): string[] {
  const messages: string[] = [];
  if (definition.prefix.length > MAX_PREFIX || /\s/.test(definition.prefix))
    messages.push(`O prefixo não pode ter espaços nem mais de ${MAX_PREFIX} caracteres.`);
  if (
    !Number.isInteger(definition.padding) ||
    definition.padding < 1 ||
    definition.padding > MAX_PADDING
  )
    messages.push(`Os dígitos têm de ser um inteiro entre 1 e ${MAX_PADDING}.`);
  if (!Number.isInteger(definition.start) || definition.start < 0 || definition.start > MAX_START)
    messages.push('O número inicial tem de ser um inteiro ≥ 0.');
  if (!AUTO_NUMBER_RESETS.includes(definition.reset))
    messages.push('Reinício inválido (nunca, anual ou mensal).');
  return messages;
}
