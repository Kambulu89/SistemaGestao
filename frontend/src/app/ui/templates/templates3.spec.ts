import { monthGrid, shiftMonth } from './calendar-page';
import { previewKind } from './document-preview-page';
import { requestTimeline, type RequestDetail } from '../../approvals/types';

describe('calendário mensal', () => {
  it('grelha de segunda a domingo, descanso e acontecimentos', () => {
    // Novembro de 2026 começa a um domingo.
    const days = monthGrid(
      2026,
      11,
      [6, 7],
      [{ date: '2026-11-11', label: 'Independência' }],
      '2026-11-08',
    );
    expect(days.length % 7).toBe(0);
    expect(days[0].date).toBe('2026-10-26');
    expect(days[6]).toMatchObject({ date: '2026-11-01', weekend: true, inMonth: true });
    expect(days.find((d) => d.date === '2026-11-11')!.events[0].label).toBe('Independência');
    expect(days.find((d) => d.date === '2026-11-08')!.today).toBe(true);
    expect(days.filter((d) => d.inMonth)).toHaveLength(30);
  });

  it('muda de mês e de ano', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });
});

describe('pré-visualização de documentos', () => {
  it('só tipos seguros', () => {
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('image/PNG')).toBe('image');
    expect(previewKind('text/csv; charset=utf-8')).toBe('text');
    expect(previewKind('image/svg+xml')).toBeNull();
    expect(previewKind('text/html')).toBeNull();
    expect(
      previewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBeNull();
  });
});

describe('linha temporal do pedido', () => {
  const person = (n: string) => ({ membershipId: n, fullName: n, email: `${n}@x` });
  const base = {
    id: 'r',
    workflow: { id: 'w', code: 'W', name: 'W' },
    subjectType: 'x',
    subjectId: null,
    title: 'T',
    description: null,
    requestedBy: person('Ana'),
    createdAt: '2026-01-01T10:00:00Z',
    version: 1,
    steps: [
      {
        sequence: 1,
        name: 'Chefia',
        approverType: 'ROLE',
        approverRoleId: null,
        approverMembershipId: null,
        requiredApprovals: 1,
      },
    ],
    myOptions: [],
  } as unknown as RequestDetail;

  it('ordena decisões e termina com o resultado', () => {
    const r = {
      ...base,
      status: 'REJECTED',
      currentStep: null,
      completedAt: '2026-01-03T10:00:00Z',
      decisions: [
        {
          stepSequence: 1,
          decision: 'REJECT',
          comment: 'Falta orçamento',
          decidedBy: person('Rui'),
          onBehalfOf: null,
          decidedAt: '2026-01-03T10:00:00Z',
        },
      ],
    } as RequestDetail;
    const t = requestTimeline(r);
    expect(t.map((e) => e.tone)).toEqual(['neutral', 'danger', 'danger']);
    expect(t[1].title).toContain('Rejeitado por Rui — Chefia');
    expect(t[1].detail).toBe('Falta orçamento');
    expect(t[2].title).toBe('Pedido rejeitado');
  });

  it('em curso mostra a etapa em espera', () => {
    const t = requestTimeline({
      ...base,
      status: 'PENDING',
      currentStep: 1,
      completedAt: null,
      decisions: [],
    } as RequestDetail);
    expect(t[t.length - 1]).toMatchObject({
      title: 'A aguardar decisão — Chefia',
      tone: 'warning',
    });
  });
});
