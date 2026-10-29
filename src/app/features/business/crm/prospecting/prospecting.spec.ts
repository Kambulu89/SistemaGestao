import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import { CustomersApi } from '../customers/customers.api';
import { CampaignsTab } from './campaigns-tab';
import { LeadsTab } from './leads-tab';
import { PipelineTab } from './pipeline-tab';
import { ProspectingPage } from './prospecting-page';
import {
  ProspectingApi,
  type CampaignDto,
  type LeadDto,
  type MemberDto,
  type OpportunityDto,
  type StageDto,
} from './prospecting.api';
import { boardOf, prospectingError, sendSummary, totalsByCurrency } from './prospecting-model';

const stage = (over: Partial<StageDto>): StageDto => ({
  id: 's1',
  code: 'NEW',
  name: 'Novo',
  position: 1,
  probability: '0.1000',
  terminal: false,
  outcome: null,
  requiresEvidence: false,
  active: true,
  version: 1,
  ...over,
});
const STAGES: StageDto[] = [
  stage({}),
  stage({ id: 's2', code: 'PROPOSAL', name: 'Proposta', position: 3 }),
  stage({
    id: 's3',
    code: 'WON',
    name: 'Ganha',
    position: 5,
    terminal: true,
    outcome: 'WON',
    requiresEvidence: true,
  }),
  stage({ id: 's4', code: 'LOST', name: 'Perdida', position: 6, terminal: true, outcome: 'LOST' }),
  stage({ id: 's9', code: 'OLD', name: 'Antiga', position: 2, active: false }),
];

const opportunity = (over: Partial<OpportunityDto> = {}): OpportunityDto => ({
  id: 'o1',
  name: 'Venda Acme',
  customerId: 'c1',
  leadId: null,
  customerName: 'Acme, Lda.',
  leadName: null,
  stageId: 's1',
  stageCode: 'NEW',
  stageName: 'Novo',
  probability: '0.1000',
  outcome: null,
  expectedValue: '1500.5000',
  currency: 'AOA',
  expectedCloseDate: null,
  lossReason: null,
  winEvidence: null,
  version: 1,
  ...over,
});

const lead = (over: Partial<LeadDto> = {}): LeadDto => ({
  id: 'l1',
  name: 'Maria Silva',
  companyName: 'Acme, Lda.',
  email: 'maria@acme.pt',
  phone: null,
  source: 'web',
  status: 'NEW',
  consentStatus: 'OPT_IN',
  disqualifyReason: null,
  partyId: null,
  customerId: null,
  opportunityId: null,
  version: 1,
  ...over,
});

const campaign = (over: Partial<CampaignDto> = {}): CampaignDto => ({
  id: 'k1',
  name: 'Lançamento',
  channel: 'EMAIL',
  startsAt: '2026-01-01T00:00:00Z',
  endsAt: null,
  budget: '500.0000',
  currency: 'AOA',
  subject: null,
  message: null,
  status: 'ACTIVE',
  version: 1,
  summary: { total: 2, targeted: 1, contacted: 1, responded: 0, optedOut: 0 },
  ...over,
});

const member = (over: Partial<MemberDto> = {}): MemberDto => ({
  id: 'm1',
  partyId: null,
  leadId: 'l1',
  partyName: null,
  leadName: 'Maria Silva',
  status: 'TARGETED',
  ...over,
});

const page = <T>(items: T[]) => ({ items, total: items.length });

const ALL = ['crm.read', 'crm.manage', 'campaign.send'];

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    leads: vi.fn(() => of(page([lead()]))),
    stages: vi.fn(() => of(STAGES)),
    opportunities: vi.fn(() => of(page([opportunity()]))),
    opportunity: vi.fn(() =>
      of({
        ...opportunity(),
        history: [
          { id: 'h1', fromStageId: null, toStageId: 's1', movedAt: '2026-10-29T10:00:00Z' },
        ],
        activities: [
          {
            id: 'a1',
            kind: 'CALL',
            subject: 'Chamada inicial',
            notes: null,
            dueAt: null,
            doneAt: null,
          },
        ],
      }),
    ),
    metrics: vi.fn(() =>
      of({
        entered: [],
        won: 1,
        lost: 1,
        winRate: '0.5000',
        wonValue: [{ currency: 'AOA', value: '200.0000' }],
        openValue: [{ currency: 'AOA', value: '1500.5000' }],
        averageDaysToWin: '2.50',
      }),
    ),
    campaigns: vi.fn(() => of(page([campaign()]))),
    members: vi.fn(() => of(page([member()]))),
    exclusions: vi.fn(() =>
      of(page([{ id: 'e1', kind: 'EMAIL', value: 'fora@x.pt', reason: null }])),
    ),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: ProspectingApi, useValue: full },
      {
        provide: OrganizationApi,
        useValue: {
          listOrganizations: () => of([{ id: 'org1', code: 'EMP', legalName: 'Empresa' }]),
        },
      },
      {
        provide: CustomersApi,
        useValue: {
          customers: () => of(page([{ id: 'c1', code: 'CLI-1', partyName: 'Acme, Lda.' }])),
        },
      },
    ],
  });
  return full;
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

const field = (label: string) => {
  const lab = [...document.body.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  return document.body.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
};
const type = (label: string, value: string) => {
  const input = field(label);
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
};
const buttons = (label: string) =>
  [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
const button = (label: string) => buttons(label)[0]!;
const text = () => document.body.textContent ?? '';

describe('modelo', () => {
  it('o quadro tem uma coluna por etapa activa, por posição, com as suas cartas', () => {
    const board = boardOf(STAGES, [opportunity(), opportunity({ id: 'o2', stageId: 's3' })]);
    expect(board.map((c) => c.stage.code)).toEqual(['NEW', 'PROPOSAL', 'WON', 'LOST']);
    expect(board[0]!.cards.map((c) => c.id)).toEqual(['o1']);
    expect(board[2]!.cards.map((c) => c.id)).toEqual(['o2']);
  });

  it('soma por moeda em decimal exacto, sem passar por number', () => {
    expect(
      totalsByCurrency([
        opportunity({ expectedValue: '0.1000' }),
        opportunity({ id: 'o2', expectedValue: '0.2000' }),
        opportunity({ id: 'o3', expectedValue: '900719925474099.1234', currency: 'EUR' }),
      ]),
    ).toEqual([
      { currency: 'AOA', value: '0.3000' },
      { currency: 'EUR', value: '900719925474099.1234' },
    ]);
  });

  it('resume o envio e traduz os erros do servidor', () => {
    expect(sendSummary({ sent: 2, optedOut: 1, noConsent: 0, noDestination: 3 })).toBe(
      '2 contactados · 1 recusaram · 3 sem destino para o canal',
    );
    expect(prospectingError({ code: 'OPPORTUNITY_CLOSED' }, 'x')).toContain('já não se move');
    expect(prospectingError({}, 'falhou')).toBe('falhou');
  });
});

describe('LeadsTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(LeadsTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('lista as leads com o consentimento e o estado', async () => {
    await open();
    expect(text()).toContain('Maria Silva');
    expect(text()).toContain('Aceita comunicações');
    expect(text()).toContain('Nova');
  });

  it('cria uma lead validando antes de enviar', async () => {
    const createLead = vi.fn(() => of(lead()));
    const { fixture } = await open({ createLead });
    button('Nova lead').click();
    await settle(fixture);
    button('Criar').click();
    await settle(fixture);
    expect(createLead).not.toHaveBeenCalled();
    expect(text()).toContain('Indique o nome e a origem');
    type('Nome', 'João Santos');
    type('Origem', 'feira');
    type('Email', 'joao@exemplo.pt');
    await settle(fixture);
    button('Criar').click();
    await settle(fixture);
    expect(createLead).toHaveBeenCalledWith({
      name: 'João Santos',
      source: 'feira',
      companyName: null,
      email: 'joao@exemplo.pt',
      phone: null,
      consentStatus: 'UNKNOWN',
    });
    expect(text()).toContain('Lead criada');
  });

  it('converte com a organização escolhida e mostra se já estava convertida', async () => {
    const convertLead = vi
      .fn()
      .mockReturnValueOnce(throwError(() => ({ code: 'PARTY_NAME_INCOMPLETE' })))
      .mockReturnValueOnce(
        of({
          lead: lead(),
          partyId: 'p',
          customerId: 'c',
          opportunityId: 'o',
          alreadyConverted: false,
        }),
      );
    const { fixture } = await open({ convertLead });
    button('Converter').click();
    await settle(fixture);
    button('Converter').click();
    await settle(fixture);
    expect(convertLead).not.toHaveBeenCalled();
    expect(text()).toContain('Escolha a organização');
    type('Organização', 'org1');
    type('Valor esperado', '1.234.5');
    await settle(fixture);
    buttons('Converter').at(-1)!.click();
    await settle(fixture);
    expect(text()).toContain('Valor esperado inválido');
    type('Valor esperado', '2500');
    await settle(fixture);
    buttons('Converter').at(-1)!.click();
    await settle(fixture);
    expect(text()).toContain('Indique nome e apelido');
    buttons('Converter').at(-1)!.click();
    await settle(fixture);
    expect(convertLead).toHaveBeenLastCalledWith('l1', {
      organizationId: 'org1',
      opportunity: { name: 'Acme, Lda.', expectedValue: '2500' },
    });
    expect(text()).toContain('Lead convertida');
  });

  it('desqualificar exige motivo; leads convertidas não têm acções; sem crm.manage não há acções', async () => {
    const disqualifyLead = vi.fn(() => of(lead({ status: 'DISQUALIFIED' })));
    const { fixture } = await open({ disqualifyLead });
    button('Desqualificar').click();
    await settle(fixture);
    buttons('Desqualificar').at(-1)!.click();
    await settle(fixture);
    expect(disqualifyLead).not.toHaveBeenCalled();
    type('Motivo', 'Sem orçamento');
    await settle(fixture);
    buttons('Desqualificar').at(-1)!.click();
    await settle(fixture);
    expect(disqualifyLead).toHaveBeenCalledWith('l1', 'Sem orçamento');
    TestBed.resetTestingModule();
    await open({ leads: () => of(page([lead({ status: 'CONVERTED' })])) });
    expect(buttons('Converter')).toHaveLength(0);
    TestBed.resetTestingModule();
    await open({}, ['crm.read']);
    expect(buttons('Converter')).toHaveLength(0);
    expect(buttons('Nova lead')).toHaveLength(0);
  });
});

describe('PipelineTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(PipelineTab);
    await settle(fixture);
    return { fixture, mocked };
  }
  const moveTo = (name: string, stageId: string) => {
    const select = document.body.querySelector<HTMLSelectElement>(
      `select[aria-label="Mover ${name}"]`,
    )!;
    select.value = stageId;
    select.dispatchEvent(new Event('change'));
  };

  it('mostra o quadro por etapas e as métricas; a lista mostra os mesmos dados', async () => {
    const { fixture } = await open();
    expect(document.body.querySelector('[data-testid=column-NEW]')?.textContent).toContain(
      'Venda Acme',
    );
    expect(document.body.querySelector('[data-testid=column-WON]')?.textContent).not.toContain(
      'Venda Acme',
    );
    expect(document.body.querySelector('[data-testid=column-OLD]')).toBeNull();
    expect(document.body.querySelector('[data-testid=win-rate]')?.textContent).toContain('50,0 %');
    (document.body.querySelector('[data-testid=view-list]') as HTMLElement).click();
    await settle(fixture);
    expect(text()).toContain('Venda Acme');
    expect(text()).toMatch(/1\s500,5000 AOA/);
  });

  it('move para uma etapa normal logo e para ganho/perda pedindo o motivo ou a evidência', async () => {
    const move = vi.fn(() => of(opportunity()));
    const { fixture } = await open({ move });
    moveTo('Venda Acme', 's2');
    await settle(fixture);
    expect(move).toHaveBeenCalledWith('o1', { stageId: 's2' });
    moveTo('Venda Acme', 's4');
    await settle(fixture);
    button('Confirmar').click();
    await settle(fixture);
    expect(text()).toContain('Indique o motivo da perda');
    type('Motivo da perda', 'Preço');
    await settle(fixture);
    button('Confirmar').click();
    await settle(fixture);
    expect(move).toHaveBeenLastCalledWith('o1', { stageId: 's4', lossReason: 'Preço' });
    moveTo('Venda Acme', 's3');
    await settle(fixture);
    button('Confirmar').click();
    await settle(fixture);
    expect(text()).toContain('exige a evidência');
    type('Evidência comercial', 'Proposta aceite');
    await settle(fixture);
    button('Confirmar').click();
    await settle(fixture);
    expect(move).toHaveBeenLastCalledWith('o1', { stageId: 's3', winEvidence: 'Proposta aceite' });
  });

  it('mostra o erro do servidor ao mover e sem crm.manage não se move nem se cria', async () => {
    const move = vi.fn(() => throwError(() => ({ code: 'OPPORTUNITY_CLOSED' })));
    const { fixture } = await open({ move });
    moveTo('Venda Acme', 's2');
    await settle(fixture);
    expect(text()).toContain('já não se move');
    TestBed.resetTestingModule();
    await open({}, ['crm.read']);
    expect(document.body.querySelector('select[aria-label^="Mover"]')).toBeNull();
    expect(buttons('Nova oportunidade')).toHaveLength(0);
  });

  it('abre o histórico e regista e conclui actividades', async () => {
    const addActivity = vi.fn(() => of({ id: 'a2' }));
    const completeActivity = vi.fn(() => of({ id: 'a1' }));
    const { fixture } = await open({ addActivity, completeActivity });
    (document.body.querySelector('[data-testid=card] button') as HTMLElement).click();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=history]')?.textContent).toContain('Novo');
    button('Concluir').click();
    await settle(fixture);
    expect(completeActivity).toHaveBeenCalledWith('a1');
    type('Assunto', 'Enviar proposta');
    await settle(fixture);
    button('Adicionar').click();
    await settle(fixture);
    expect(addActivity).toHaveBeenCalledWith('o1', { kind: 'CALL', subject: 'Enviar proposta' });
  });

  it('cria uma oportunidade validando o valor', async () => {
    const createOpportunity = vi.fn(() => of(opportunity()));
    const { fixture } = await open({ createOpportunity });
    button('Nova oportunidade').click();
    await settle(fixture);
    type('Nome', 'Nova venda');
    type('Cliente', 'c1');
    type('Valor esperado', '1,5');
    await settle(fixture);
    button('Criar').click();
    await settle(fixture);
    expect(createOpportunity).not.toHaveBeenCalled();
    type('Valor esperado', '300');
    await settle(fixture);
    button('Criar').click();
    await settle(fixture);
    expect(createOpportunity).toHaveBeenCalledWith({
      name: 'Nova venda',
      customerId: 'c1',
      expectedValue: '300',
    });
  });
});

describe('CampaignsTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(CampaignsTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('mostra o público e as respostas e envia mostrando o resumo', async () => {
    const send = vi.fn(() => of({ sent: 1, optedOut: 1, noConsent: 0, noDestination: 0 }));
    const { fixture } = await open({ send });
    expect(text()).toContain('2 destinatários');
    expect(text()).toContain('1 contactados');
    button('Enviar').click();
    await settle(fixture);
    expect(send).toHaveBeenCalledWith('k1');
    expect(text()).toContain('1 contactados · 1 recusaram');
  });

  it('só uma campanha activa se envia e o envio é uma permissão própria', async () => {
    await open({ campaigns: () => of(page([campaign({ status: 'DRAFT' })])) });
    expect(buttons('Enviar')).toHaveLength(0);
    expect(buttons('Activar')).toHaveLength(1);
    TestBed.resetTestingModule();
    await open({}, ['crm.read', 'crm.manage']);
    expect(buttons('Enviar')).toHaveLength(0);
    TestBed.resetTestingModule();
    await open({}, ['crm.read', 'campaign.send']);
    expect(buttons('Enviar')).toHaveLength(1);
    expect(buttons('Pausar')).toHaveLength(0);
  });

  it('gere o público: adicionar, responder, recusar e retirar', async () => {
    const addMembers = vi.fn(() => of({ added: 1, duplicates: 0 }));
    const optOutMember = vi.fn(() => of(member()));
    const removeMember = vi.fn(() => of(undefined));
    const { fixture } = await open({ addMembers, optOutMember, removeMember });
    button('Público').click();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=members]')?.textContent).toContain(
      'Maria Silva',
    );
    button('Recusou').click();
    await settle(fixture);
    expect(optOutMember).toHaveBeenCalledWith('k1', 'm1');
    expect(text()).toContain('lista de exclusão');
    button('Retirar').click();
    await settle(fixture);
    expect(removeMember).toHaveBeenCalledWith('k1', 'm1');
  });

  it('acrescenta e retira da lista de exclusão', async () => {
    const addExclusion = vi.fn(() => of({ id: 'e2' }));
    const removeExclusion = vi.fn(() => of(undefined));
    const { fixture } = await open({ addExclusion, removeExclusion });
    expect(document.body.querySelector('[data-testid=exclusions]')?.textContent).toContain(
      'fora@x.pt',
    );
    button('Acrescentar').click();
    await settle(fixture);
    expect(addExclusion).not.toHaveBeenCalled();
    type('Valor a excluir', 'nunca@x.pt');
    await settle(fixture);
    button('Acrescentar').click();
    await settle(fixture);
    expect(addExclusion).toHaveBeenCalledWith({ kind: 'EMAIL', value: 'nunca@x.pt' });
    document.body.querySelector<HTMLElement>('[data-testid=exclusions] button')!.click();
    await settle(fixture);
    expect(removeExclusion).toHaveBeenCalledWith('e1');
  });

  it('cria uma campanha com a data e o orçamento validados', async () => {
    const createCampaign = vi.fn(() => of(campaign()));
    const { fixture } = await open({ createCampaign });
    button('Nova campanha').click();
    await settle(fixture);
    type('Nome', 'Natal');
    type('Início', 'amanhã');
    await settle(fixture);
    buttons('Criar').at(-1)!.click();
    await settle(fixture);
    expect(createCampaign).not.toHaveBeenCalled();
    type('Início', '2026-12-01');
    type('Orçamento', '1000');
    await settle(fixture);
    buttons('Criar').at(-1)!.click();
    await settle(fixture);
    expect(createCampaign).toHaveBeenCalledWith({
      name: 'Natal',
      channel: 'EMAIL',
      startsAt: '2026-12-01T00:00:00Z',
      budget: '1000',
    });
  });
});

describe('ProspectingPage', () => {
  it('mostra os três separadores a quem pode ler', async () => {
    configure();
    const fixture = TestBed.createComponent(ProspectingPage);
    await settle(fixture);
    expect(
      [...document.body.querySelectorAll('[role=tab]')].map((t) => t.textContent?.trim()),
    ).toEqual(['Leads', 'Pipeline', 'Campanhas']);
  });

  it('sem crm.read não há separadores', async () => {
    configure({}, []);
    const fixture = TestBed.createComponent(ProspectingPage);
    await settle(fixture);
    expect(document.body.querySelectorAll('[role=tab]')).toHaveLength(0);
  });
});
