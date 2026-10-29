import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import type { Page } from '../../sales/orders/orders.api';

export type LeadStatus = 'NEW' | 'QUALIFIED' | 'DISQUALIFIED' | 'CONVERTED';
export type ConsentStatus = 'UNKNOWN' | 'OPT_IN' | 'OPT_OUT';
export type CampaignChannel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'CALL' | 'EVENT' | 'OTHER';
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';
export type MemberStatus = 'TARGETED' | 'CONTACTED' | 'RESPONDED' | 'OPTED_OUT';
export type ActivityKind = 'CALL' | 'EMAIL' | 'MEETING' | 'TASK' | 'NOTE';

/** Valores e probabilidades atravessam a API como texto decimal: nunca `number`. */
export interface LeadDto {
  readonly id: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: string;
  readonly status: LeadStatus;
  readonly consentStatus: ConsentStatus;
  readonly disqualifyReason: string | null;
  readonly partyId: string | null;
  readonly customerId: string | null;
  readonly opportunityId: string | null;
  readonly version: number;
}

export interface StageDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly position: number;
  readonly probability: string;
  readonly terminal: boolean;
  readonly outcome: 'WON' | 'LOST' | null;
  readonly requiresEvidence: boolean;
  readonly active: boolean;
  readonly version: number;
}

export interface OpportunityDto {
  readonly id: string;
  readonly name: string;
  readonly customerId: string | null;
  readonly leadId: string | null;
  readonly customerName: string | null;
  readonly leadName: string | null;
  readonly stageId: string;
  readonly stageCode: string;
  readonly stageName: string;
  readonly probability: string;
  readonly outcome: 'WON' | 'LOST' | null;
  readonly expectedValue: string;
  readonly currency: string;
  readonly expectedCloseDate: string | null;
  readonly lossReason: string | null;
  readonly winEvidence: string | null;
  readonly version: number;
}

export interface StageMoveDto {
  readonly id: string;
  readonly fromStageId: string | null;
  readonly toStageId: string;
  readonly movedAt: string;
}

export interface ActivityDto {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly subject: string;
  readonly notes: string | null;
  readonly dueAt: string | null;
  readonly doneAt: string | null;
}

export interface OpportunityDetailDto extends OpportunityDto {
  readonly history: readonly StageMoveDto[];
  readonly activities: readonly ActivityDto[];
}

export interface MetricsDto {
  readonly entered: readonly { stageId: string; code: string; name: string; count: number }[];
  readonly won: number;
  readonly lost: number;
  readonly winRate: string | null;
  readonly wonValue: readonly { currency: string; value: string }[];
  readonly openValue: readonly { currency: string; value: string }[];
  readonly averageDaysToWin: string | null;
}

export interface ConvertResultDto {
  readonly lead: LeadDto;
  readonly partyId: string;
  readonly customerId: string;
  readonly opportunityId: string | null;
  readonly alreadyConverted: boolean;
}

export interface CampaignSummaryDto {
  readonly total: number;
  readonly targeted: number;
  readonly contacted: number;
  readonly responded: number;
  readonly optedOut: number;
}

export interface CampaignDto {
  readonly id: string;
  readonly name: string;
  readonly channel: CampaignChannel;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly budget: string;
  readonly currency: string;
  readonly status: CampaignStatus;
  readonly version: number;
  readonly summary: CampaignSummaryDto;
}

export interface MemberDto {
  readonly id: string;
  readonly partyId: string | null;
  readonly leadId: string | null;
  readonly partyName: string | null;
  readonly leadName: string | null;
  readonly status: MemberStatus;
}

export interface SendResultDto {
  readonly sent: number;
  readonly optedOut: number;
  readonly noConsent: number;
  readonly noDestination: number;
}

export interface ExclusionDto {
  readonly id: string;
  readonly kind: 'EMAIL' | 'PHONE';
  readonly value: string;
  readonly reason: string | null;
}

export interface NewLead {
  readonly name: string;
  readonly source: string;
  readonly companyName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly consentStatus?: ConsentStatus;
}

const clean = (params: Record<string, unknown>): Record<string, string | number> =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Record<string, string | number>;

/** Prospecção e CRM (M02) sobre a API real: o servidor valida, converte de forma atómica e respeita o consentimento. */
@Injectable({ providedIn: 'root' })
export class ProspectingApi {
  private readonly api = inject(ApiService);

  private page<T>(path: string, params: Record<string, unknown>) {
    return this.api
      .getWithMeta<readonly T[]>(path, { params: clean(params) })
      .pipe(
        map((r): Page<T> => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })),
      );
  }

  // --- leads ------------------------------------------------------------------------------------

  leads(filter: { q?: string; status?: LeadStatus; limit?: number }) {
    return this.page<LeadDto>('leads', filter);
  }

  createLead(body: NewLead): Observable<LeadDto> {
    return this.api.post('leads', body);
  }

  qualifyLead(id: string): Observable<LeadDto> {
    return this.api.post(`leads/${id}/qualify`, {});
  }

  disqualifyLead(id: string, reason: string): Observable<LeadDto> {
    return this.api.post(`leads/${id}/disqualify`, { reason });
  }

  convertLead(
    id: string,
    body: {
      organizationId: string;
      opportunity?: { name?: string; expectedValue?: string };
    },
  ): Observable<ConvertResultDto> {
    return this.api.post(`leads/${id}/convert`, body);
  }

  // --- pipeline ---------------------------------------------------------------------------------

  stages(): Observable<readonly StageDto[]> {
    return this.api.get('pipeline-stages', { params: { activeOnly: 'true' } });
  }

  opportunities(filter: { status?: 'open' | 'won' | 'lost'; limit?: number }) {
    return this.page<OpportunityDto>('opportunities', filter);
  }

  opportunity(id: string): Observable<OpportunityDetailDto> {
    return this.api.get(`opportunities/${id}`);
  }

  createOpportunity(body: {
    name: string;
    customerId?: string;
    leadId?: string;
    organizationId?: string;
    expectedValue?: string;
    expectedCloseDate?: string | null;
  }): Observable<OpportunityDto> {
    return this.api.post('opportunities', body);
  }

  move(
    id: string,
    body: { stageId: string; lossReason?: string; winEvidence?: string },
  ): Observable<OpportunityDto> {
    return this.api.post(`opportunities/${id}/move`, body);
  }

  metrics(): Observable<MetricsDto> {
    return this.api.get('opportunities/metrics');
  }

  addActivity(
    id: string,
    body: { kind: ActivityKind; subject: string; dueAt?: string | null },
  ): Observable<ActivityDto> {
    return this.api.post(`opportunities/${id}/activities`, body);
  }

  completeActivity(id: string): Observable<ActivityDto> {
    return this.api.post(`opportunity-activities/${id}/complete`, {});
  }

  // --- campanhas --------------------------------------------------------------------------------

  campaigns(filter: { status?: CampaignStatus; limit?: number }) {
    return this.page<CampaignDto>('campaigns', filter);
  }

  createCampaign(body: {
    name: string;
    channel: CampaignChannel;
    startsAt: string;
    endsAt?: string | null;
    budget?: string;
  }): Observable<CampaignDto> {
    return this.api.post('campaigns', body);
  }

  setCampaignStatus(id: string, status: CampaignStatus): Observable<CampaignDto> {
    return this.api.post(`campaigns/${id}/status`, { status });
  }

  members(id: string, filter: { status?: MemberStatus; limit?: number } = {}) {
    return this.page<MemberDto>(`campaigns/${id}/members`, filter);
  }

  addMembers(
    id: string,
    body: { partyIds?: readonly string[]; leadIds?: readonly string[] },
  ): Observable<{ added: number; duplicates: number }> {
    return this.api.post(`campaigns/${id}/members`, body);
  }

  removeMember(id: string, memberId: string): Observable<void> {
    return this.api.delete(`campaigns/${id}/members/${memberId}`);
  }

  respondMember(id: string, memberId: string): Observable<MemberDto> {
    return this.api.post(`campaigns/${id}/members/${memberId}/respond`, {});
  }

  optOutMember(id: string, memberId: string): Observable<MemberDto> {
    return this.api.post(`campaigns/${id}/members/${memberId}/opt-out`, {});
  }

  send(id: string): Observable<SendResultDto> {
    return this.api.post(`campaigns/${id}/send`, {});
  }

  // --- lista de exclusão ------------------------------------------------------------------------

  exclusions() {
    return this.page<ExclusionDto>('marketing-exclusions', { limit: 200 });
  }

  addExclusion(body: {
    kind: 'EMAIL' | 'PHONE';
    value: string;
    reason?: string;
  }): Observable<ExclusionDto> {
    return this.api.post('marketing-exclusions', body);
  }

  removeExclusion(id: string): Observable<void> {
    return this.api.delete(`marketing-exclusions/${id}`);
  }
}
