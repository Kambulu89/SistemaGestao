import { describe, expect, it } from 'vitest';
import {
  addApprover,
  addStage,
  describeStage,
  localProblems,
  moveStage,
  removeApprover,
  removeStage,
  setCriteria,
  updateStage,
} from './workflow-model';
import type { GraphDto } from './workflows.api';

const A = { type: 'MEMBERSHIP', id: 'a' } as const;
const B = { type: 'ROLE', id: 'b' } as const;
const C = { type: 'MEMBERSHIP', id: 'c' } as const;

describe('workflow-model', () => {
  it('adds stages with unique codes, in order', () => {
    let graph: GraphDto = { stages: [] };
    graph = addStage(graph);
    graph = addStage(graph);
    expect(graph.stages.map((s) => s.code)).toEqual(['etapa', 'etapa_2']);
    expect(graph.stages[0]?.criteria).toBe('ALL');
    expect(graph.stages[0]?.allowSelfApproval).toBe(false);
  });

  it('moves and removes stages without touching the others', () => {
    let graph = addStage(addStage(addStage({ stages: [] })));
    graph = moveStage(graph, 2, -1);
    expect(graph.stages.map((s) => s.code)).toEqual(['etapa', 'etapa_3', 'etapa_2']);
    expect(moveStage(graph, 0, -1)).toBe(graph);
    graph = removeStage(graph, 1);
    expect(graph.stages.map((s) => s.code)).toEqual(['etapa', 'etapa_2']);
  });

  it('never repeats an approver and keeps the quorum within the approvers', () => {
    let graph = addStage({ stages: [] });
    graph = addApprover(graph, 0, A);
    expect(addApprover(graph, 0, A)).toBe(graph);
    graph = addApprover(addApprover(graph, 0, B), 0, C);
    graph = setCriteria(graph, 0, 'QUORUM');
    expect(graph.stages[0]).toMatchObject({ criteria: 'QUORUM', quorum: 2 });
    graph = removeApprover(removeApprover(graph, 0, 2), 0, 1);
    expect(graph.stages[0]?.quorum).toBe(1);
    graph = setCriteria(graph, 0, 'ANY');
    expect('quorum' in (graph.stages[0] as object)).toBe(false);
  });

  it('drops cleared optional values so the server never sees unknown or null keys', () => {
    let graph = updateStage(addStage({ stages: [] }), 0, {
      dueInHours: 24,
      condition: { op: 'x' },
    });
    graph = updateStage(graph, 0, { dueInHours: undefined, condition: undefined });
    expect(Object.keys(graph.stages[0] as object).sort()).toEqual([
      'allowSelfApproval',
      'approvers',
      'code',
      'criteria',
      'label',
    ]);
  });

  it('reports what can be seen without asking the server', () => {
    expect(localProblems({ stages: [] })).toEqual(['Acrescente pelo menos uma etapa.']);
    let graph = addStage({ stages: [] });
    expect(localProblems(graph)).toEqual(['«Aprovação» não tem responsáveis.']);
    graph = addApprover(graph, 0, A);
    expect(localProblems(graph)).toEqual([]);
    graph = updateStage(graph, 0, { criteria: 'QUORUM', quorum: 3 });
    expect(localProblems(graph)[0]).toContain('quórum');
  });

  it('describes a stage in one sentence', () => {
    const stage = addApprover(addApprover(addStage({ stages: [] }), 0, A), 0, B).stages[0]!;
    expect(describeStage(stage)).toBe('aprovação dos 2 responsáveis');
    expect(describeStage({ ...stage, criteria: 'ANY', dueInHours: 48 })).toBe(
      'aprovação de qualquer um dos 2 responsáveis em 48 h',
    );
    expect(describeStage({ ...stage, criteria: 'QUORUM', quorum: 2, condition: {} })).toBe(
      '2 aprovações de 2 responsáveis (só quando a condição se verifica)',
    );
  });
});
