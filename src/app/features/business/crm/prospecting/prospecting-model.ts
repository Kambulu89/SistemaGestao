import type { Tone } from '../../../../shared/ui/badge/badge';
import { documentError } from '../../sales/orders/orders-model';
import type {
  CampaignChannel,
  CampaignStatus,
  ConsentStatus,
  LeadStatus,
  MemberStatus,
  OpportunityDto,
  SendResultDto,
  StageDto,
} from './prospecting.api';

export { documentError, formatDecimal } from '../../sales/orders/orders-model';

export const LEAD_STATUS: Readonly<Record<LeadStatus, { label: string; tone: Tone }>> = {
  NEW: { label: 'Nova', tone: 'neutral' },
  QUALIFIED: { label: 'Qualificada', tone: 'brand' },
  DISQUALIFIED: { label: 'Desqualificada', tone: 'danger' },
  CONVERTED: { label: 'Convertida', tone: 'success' },
};

export const CONSENT: Readonly<Record<ConsentStatus, { label: string; tone: Tone }>> = {
  UNKNOWN: { label: 'Consentimento por obter', tone: 'neutral' },
  OPT_IN: { label: 'Aceita comunicações', tone: 'success' },
  OPT_OUT: { label: 'Recusou comunicações', tone: 'danger' },
};

export const CAMPAIGN_STATUS: Readonly<Record<CampaignStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  ACTIVE: { label: 'Activa', tone: 'success' },
  PAUSED: { label: 'Pausada', tone: 'warning' },
  COMPLETED: { label: 'Concluída', tone: 'brand' },
};

export const MEMBER_STATUS: Readonly<Record<MemberStatus, { label: string; tone: Tone }>> = {
  TARGETED: { label: 'Por contactar', tone: 'neutral' },
  CONTACTED: { label: 'Contactado', tone: 'brand' },
  RESPONDED: { label: 'Respondeu', tone: 'success' },
  OPTED_OUT: { label: 'Recusou', tone: 'danger' },
};

export const CHANNEL: Readonly<Record<CampaignChannel, string>> = {
  EMAIL: 'Email',
  SMS: 'SMS',
  WHATSAPP: 'WhatsApp',
  CALL: 'Chamada',
  EVENT: 'Evento',
  OTHER: 'Outro',
};

/** Estados seguintes permitidos a uma campanha (rascunho → activa ⇄ pausada → concluída). */
export const NEXT_CAMPAIGN_STATUS: Readonly<
  Record<CampaignStatus, readonly { to: CampaignStatus; label: string }[]>
> = {
  DRAFT: [{ to: 'ACTIVE', label: 'Activar' }],
  ACTIVE: [
    { to: 'PAUSED', label: 'Pausar' },
    { to: 'COMPLETED', label: 'Concluir' },
  ],
  PAUSED: [
    { to: 'ACTIVE', label: 'Retomar' },
    { to: 'COMPLETED', label: 'Concluir' },
  ],
  COMPLETED: [],
};

const PROSPECTING_ERRORS: Readonly<Record<string, string>> = {
  PARTY_NAME_INCOMPLETE:
    'Indique nome e apelido na lead, ou escolha uma pessoa ou organização existente.',
  LEAD_DISQUALIFIED: 'Uma lead desqualificada tem de ser requalificada antes de converter.',
  CAMPAIGN_NO_MESSAGE: 'Indique o assunto e a mensagem da campanha antes de a enviar.',
  LEAD_CONVERTED: 'Uma lead convertida já não muda de estado.',
  OPPORTUNITY_CLOSED: 'Uma oportunidade ganha ou perdida já não se move nem se altera.',
  LOSS_REASON_REQUIRED: 'Indique o motivo da perda.',
  EVIDENCE_REQUIRED: 'Esta etapa exige a evidência comercial do ganho.',
  STAGE_INACTIVE: 'A etapa está inactiva.',
  STAGE_IN_USE: 'Há oportunidades nesta etapa.',
  UNKNOWN_CUSTOMER: 'O cliente não existe.',
  UNKNOWN_LEAD: 'A lead não existe.',
  UNKNOWN_STAGE: 'A etapa não existe.',
  UNKNOWN_ORGANIZATION: 'A organização não existe.',
  CUSTOMER_CODE_TAKEN: 'Já existe um cliente com este código.',
  CAMPAIGN_NOT_RUNNING: 'Só se envia uma campanha activa, dentro do seu período.',
  CAMPAIGN_STATE: 'A campanha não pode passar a esse estado.',
  CAMPAIGN_COMPLETED: 'Uma campanha concluída já não se altera.',
  MEMBER_ALREADY_CONTACTED: 'Só se retira um destinatário que ainda não foi contactado.',
  MEMBER_NOT_CONTACTED: 'Só responde quem já foi contactado.',
  EXCLUSION_EXISTS: 'Este valor já está na lista de exclusão.',
  INVALID_EMAIL: 'Email inválido.',
  INVALID_PHONE: 'Telefone inválido.',
};

/** Texto de um erro da API: primeiro os códigos da prospecção; depois os campos que falharam. */
export function prospectingError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && PROSPECTING_ERRORS[code]) return PROSPECTING_ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => PROSPECTING_ERRORS[f.code] ?? f.message).join(' ');
  }
  return documentError(error, fallback);
}

/** Valor monetário em texto, até 4 casas decimais. */
export const isMoney = (value: string): boolean => /^\d{1,15}(\.\d{1,4})?$/.test(value.trim());

/** Resumo do resultado de um envio, em frases curtas. */
export function sendSummary(result: SendResultDto): string {
  const parts = [`${result.sent} contactados`];
  if (result.optedOut) parts.push(`${result.optedOut} recusaram`);
  if (result.noConsent) parts.push(`${result.noConsent} sem consentimento`);
  if (result.noDestination) parts.push(`${result.noDestination} sem destino para o canal`);
  return parts.join(' · ');
}

export interface BoardColumn {
  readonly stage: StageDto;
  readonly cards: readonly OpportunityDto[];
}

/** Colunas do quadro: uma por etapa activa (por posição), com as suas oportunidades; as de etapas desconhecidas ficam de fora. */
export function boardOf(
  stages: readonly StageDto[],
  opportunities: readonly OpportunityDto[],
): readonly BoardColumn[] {
  return [...stages]
    .filter((s) => s.active)
    .sort((a, b) => a.position - b.position)
    .map((stage) => ({ stage, cards: opportunities.filter((o) => o.stageId === stage.id) }));
}

/** Soma por moeda dos valores esperados das cartas, em texto decimal exacto (BigInt, 4 casas). */
export function totalsByCurrency(
  cards: readonly OpportunityDto[],
): readonly { currency: string; value: string }[] {
  const sums = new Map<string, bigint>();
  for (const card of cards) {
    const [int = '0', frac = ''] = card.expectedValue.split('.');
    const scaled = BigInt(int) * 10000n + BigInt(frac.padEnd(4, '0').slice(0, 4));
    sums.set(card.currency, (sums.get(card.currency) ?? 0n) + scaled);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, scaled]) => ({
      currency,
      value: `${scaled / 10000n}.${String(scaled % 10000n).padStart(4, '0')}`,
    }));
}
