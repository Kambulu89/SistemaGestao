import type { Tone } from '../../../shared/ui/badge/badge';
import type { ValueKind } from '../rules/rule-condition';
import type {
  ActionDescriptorDto,
  ActionDto,
  AutomationStatus,
  EventDescriptorDto,
  ParamValue,
  RunDto,
  RunStatus,
} from './automations.api';

export const AUTOMATION_STATUS: Record<AutomationStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Rascunho', tone: 'warning' },
  ACTIVE: { label: 'Activa', tone: 'success' },
  PAUSED: { label: 'Pausada', tone: 'neutral' },
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Na fila', tone: 'brand' },
  RUNNING: { label: 'A executar', tone: 'brand' },
  SUCCEEDED: { label: 'Concluída', tone: 'success' },
  FAILED: { label: 'Falhada', tone: 'danger' },
  DEAD: { label: 'Fila de falhas', tone: 'danger' },
};

/** Códigos com que o motor fecha uma execução sem a poder reprocessar (as regras de causalidade e limites). */
export const BLOCKED_BY_RULE: readonly string[] = [
  'CAUSALITY_DEPTH',
  'CAUSALITY_LOOP',
  'PERIOD_LIMIT',
  'CONDITION_ERROR',
];

export const ERROR_LABEL: Record<string, string> = {
  CAUSALITY_DEPTH: 'A cadeia de causalidade excedeu o limite de níveis.',
  CAUSALITY_LOOP: 'O evento foi causado por esta mesma automação.',
  PERIOD_LIMIT: 'Limite de execuções por hora atingido.',
  CONDITION_ERROR: 'A condição não pôde ser avaliada.',
  AUTOMATION_NOT_ACTIVE: 'A automação já não estava activa.',
  RUN_AS_UNAVAILABLE: 'O membro em nome de quem executa já não pode agir.',
  TIMEOUT: 'A execução excedeu a duração máxima.',
};

/** Só se reprocessa o que falhou e que as regras do motor não fecharam. */
export function canRetry(run: Pick<RunDto, 'status' | 'errorCode'>): boolean {
  return (
    (run.status === 'DEAD' || run.status === 'FAILED') &&
    !(run.errorCode !== null && BLOCKED_BY_RULE.includes(run.errorCode))
  );
}

/** Tipo de valor do construtor de condições para um campo do evento. */
export function eventFieldKind(kind: 'text' | 'number' | 'boolean'): ValueKind {
  return kind;
}

/** Rascunho de um parâmetro: um valor fixo ou um campo do evento. */
export interface ParamDraft {
  readonly mode: 'fixed' | 'event';
  readonly value: string;
}

export interface ActionDraft {
  readonly type: string;
  readonly params: Readonly<Record<string, ParamDraft>>;
}

export function emptyAction(descriptor: ActionDescriptorDto | undefined): ActionDraft {
  return {
    type: descriptor?.type ?? '',
    params: Object.fromEntries(
      (descriptor?.params ?? []).map((p) => [p.name, { mode: 'fixed', value: '' } as ParamDraft]),
    ),
  };
}

/** Do rascunho ao corpo da API: sem parâmetros vazios, e as referências como `{ from: 'payload.campo' }`. */
export function toActionDto(draft: ActionDraft): ActionDto {
  const params: Record<string, ParamValue> = {};
  for (const [name, p] of Object.entries(draft.params)) {
    if (p.value.trim() === '') continue;
    params[name] = p.mode === 'event' ? { from: `payload.${p.value}` } : p.value.trim();
  }
  return { type: draft.type, params };
}

export function toActionDraft(
  action: ActionDto,
  descriptor: ActionDescriptorDto | undefined,
): ActionDraft {
  const base = emptyAction(descriptor).params;
  const params: Record<string, ParamDraft> = { ...base };
  for (const [name, value] of Object.entries(action.params)) {
    if (typeof value === 'object') {
      params[name] = { mode: 'event', value: value.from.replace(/^payload\./, '') };
    } else {
      params[name] = { mode: 'fixed', value: String(value) };
    }
  }
  return { type: action.type, params };
}

/** O gatilho em palavras: o evento (pelo rótulo do catálogo) ou o calendário com o fuso. */
export function describeTrigger(
  automation: { eventType: string | null; schedule: string | null; timezone: string },
  events: readonly EventDescriptorDto[],
): string {
  if (automation.eventType) {
    return events.find((e) => e.type === automation.eventType)?.label ?? automation.eventType;
  }
  return `Calendário «${automation.schedule}» (${automation.timezone})`;
}
