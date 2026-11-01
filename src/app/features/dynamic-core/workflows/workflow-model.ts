import { nextCode } from '../states/state-machine-model';
import type { ApproverDto, Criteria, GraphDto, StageDto } from './workflows.api';

/**
 * Operações puras sobre o grafo de um workflow em edição (o estado do designer é o próprio modelo do servidor,
 * imutável): cada operação devolve um grafo novo. As etapas correm pela ordem da lista.
 */
export function addStage(graph: GraphDto): GraphDto {
  const code = nextCode(
    'etapa',
    graph.stages.map((s) => s.code),
  );
  const stage: StageDto = {
    code,
    label: graph.stages.length === 0 ? 'Aprovação' : 'Nova etapa',
    approvers: [],
    criteria: 'ALL',
    allowSelfApproval: false,
  };
  return { ...graph, stages: [...graph.stages, stage] };
}

export function updateStage(graph: GraphDto, index: number, patch: Partial<StageDto>): GraphDto {
  return {
    ...graph,
    stages: graph.stages.map((s, i) => {
      if (i !== index) return s;
      const next = { ...s, ...patch } as Record<string, unknown>;
      // Chaves a `undefined` saem do objecto: o servidor recusa campos que não conhece.
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return next as unknown as StageDto;
    }),
  };
}

/** Muda o critério; o quórum só existe em QUORUM (por omissão, a maioria simples dos responsáveis). */
export function setCriteria(graph: GraphDto, index: number, criteria: Criteria): GraphDto {
  const stage = graph.stages[index];
  if (!stage) return graph;
  if (criteria !== 'QUORUM') return updateStage(graph, index, { criteria, quorum: undefined });
  const quorum = Math.min(
    Math.max(stage.quorum ?? Math.floor(stage.approvers.length / 2) + 1, 1),
    Math.max(stage.approvers.length, 1),
  );
  return updateStage(graph, index, { criteria, quorum });
}

export function removeStage(graph: GraphDto, index: number): GraphDto {
  return { ...graph, stages: graph.stages.filter((_, i) => i !== index) };
}

export function moveStage(graph: GraphDto, index: number, direction: -1 | 1): GraphDto {
  const target = index + direction;
  if (target < 0 || target >= graph.stages.length) return graph;
  const stages = [...graph.stages];
  const [moved] = stages.splice(index, 1);
  stages.splice(target, 0, moved as StageDto);
  return { ...graph, stages };
}

/** Acrescenta um responsável (sem repetir); o quórum acompanha o número de responsáveis. */
export function addApprover(graph: GraphDto, index: number, approver: ApproverDto): GraphDto {
  const stage = graph.stages[index];
  if (!stage || stage.approvers.some((a) => a.type === approver.type && a.id === approver.id)) {
    return graph;
  }
  return updateStage(graph, index, { approvers: [...stage.approvers, approver] });
}

export function removeApprover(graph: GraphDto, index: number, approverIndex: number): GraphDto {
  const stage = graph.stages[index];
  if (!stage) return graph;
  const approvers = stage.approvers.filter((_, i) => i !== approverIndex);
  const quorum =
    stage.criteria === 'QUORUM' && stage.quorum !== undefined
      ? Math.min(stage.quorum, Math.max(approvers.length, 1))
      : stage.quorum;
  return updateStage(graph, index, { approvers, quorum });
}

/** Problemas que se vêem sem perguntar ao servidor (o servidor volta a verificar tudo ao publicar). */
export function localProblems(graph: GraphDto): readonly string[] {
  const problems: string[] = [];
  if (graph.stages.length === 0) problems.push('Acrescente pelo menos uma etapa.');
  graph.stages.forEach((stage, i) => {
    const name = stage.label.trim() || `Etapa ${i + 1}`;
    if (!stage.label.trim()) problems.push(`A etapa ${i + 1} precisa de um nome.`);
    if (stage.approvers.length === 0) problems.push(`«${name}» não tem responsáveis.`);
    if (
      stage.criteria === 'QUORUM' &&
      (stage.quorum === undefined ||
        stage.quorum < 1 ||
        stage.quorum > Math.max(stage.approvers.length, 1))
    ) {
      problems.push(`«${name}»: o quórum tem de estar entre 1 e o número de responsáveis.`);
    }
  });
  return problems;
}

export const CRITERIA_LABEL: Record<Criteria, string> = {
  ALL: 'Todos têm de aprovar',
  ANY: 'Basta um aprovar',
  QUORUM: 'Quórum (n aprovações)',
};

/** Frase curta do que uma etapa pede, para o resumo do fluxo. */
export function describeStage(stage: StageDto): string {
  const count = stage.approvers.length;
  const rule =
    stage.criteria === 'ALL'
      ? count === 1
        ? 'aprovação do responsável'
        : `aprovação dos ${count} responsáveis`
      : stage.criteria === 'ANY'
        ? `aprovação de qualquer um dos ${count} responsáveis`
        : `${stage.quorum ?? '?'} aprovações de ${count} responsáveis`;
  const due = stage.dueInHours ? ` em ${stage.dueInHours} h` : '';
  const when = stage.condition !== undefined ? ' (só quando a condição se verifica)' : '';
  return `${rule}${due}${when}`;
}
