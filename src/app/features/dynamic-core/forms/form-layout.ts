import type { FormBindingDto, FormSectionDto } from '../../../core/dynamic/http/dynamic-dto';

/**
 * Operações puras sobre as secções de um formulário em edição (o estado do builder é a própria lista de secções do
 * servidor, imutável): cada operação devolve uma nova lista. Nada aqui duplica a definição de um campo — os itens só
 * referem o campo por código.
 */
export type Sections = readonly FormSectionDto[];

export interface ItemRef {
  readonly section: number;
  readonly item: number;
}

const replace = <T>(list: readonly T[], index: number, value: T): T[] =>
  list.map((entry, i) => (i === index ? value : entry));

const without = <T>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);

/** Chave da próxima secção: `secao`, `secao_2`, … sem repetir. */
export function nextSectionKey(sections: Sections): string {
  const taken = new Set(sections.map((s) => s.key));
  if (!taken.has('secao')) return 'secao';
  let n = 2;
  while (taken.has(`secao_${n}`)) n += 1;
  return `secao_${n}`;
}

export function addSection(sections: Sections): FormSectionDto[] {
  return [
    ...sections,
    { key: nextSectionKey(sections), title: 'Nova secção', columns: 2, items: [] },
  ];
}

export function updateSection(
  sections: Sections,
  index: number,
  patch: Partial<Omit<FormSectionDto, 'items'>>,
): FormSectionDto[] {
  const current = sections[index];
  if (!current) return [...sections];
  const next = { ...current, ...patch } as Record<string, unknown>;
  // Um valor `undefined` retira a chave (ex.: tirar a condição de visibilidade).
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return replace(sections, index, next as unknown as FormSectionDto);
}

export function removeSection(sections: Sections, index: number): FormSectionDto[] {
  return without(sections, index);
}

export function moveSection(sections: Sections, index: number, delta: -1 | 1): FormSectionDto[] {
  const target = index + delta;
  if (target < 0 || target >= sections.length) return [...sections];
  const list = [...sections];
  const [moved] = list.splice(index, 1);
  list.splice(target, 0, moved as FormSectionDto);
  return list;
}

/** Liga um campo ao fim de uma secção; um campo já ligado não se repete. */
export function addItem(sections: Sections, sectionIndex: number, field: string): FormSectionDto[] {
  if (boundFields(sections).has(field)) return [...sections];
  const section = sections[sectionIndex];
  if (!section) return [...sections];
  return replace(sections, sectionIndex, {
    ...section,
    items: [...section.items, { kind: 'field', field }],
  });
}

export function updateItem(
  sections: Sections,
  ref: ItemRef,
  patch: Partial<Omit<FormBindingDto, 'kind' | 'field'>>,
): FormSectionDto[] {
  const section = sections[ref.section];
  const current = section?.items[ref.item];
  if (!section || !current) return [...sections];
  const next = { ...current, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return replace(sections, ref.section, {
    ...section,
    items: replace(section.items, ref.item, next as unknown as FormBindingDto),
  });
}

export function removeItem(sections: Sections, ref: ItemRef): FormSectionDto[] {
  const section = sections[ref.section];
  if (!section) return [...sections];
  return replace(sections, ref.section, { ...section, items: without(section.items, ref.item) });
}

/**
 * Move um item para a posição `to` (antes do item que lá está; `item` igual ao tamanho = no fim), possivelmente
 * noutra secção. É o que o arrastar e os botões «subir/descer» fazem.
 */
export function moveItem(sections: Sections, from: ItemRef, to: ItemRef): FormSectionDto[] {
  const source = sections[from.section];
  const moved = source?.items[from.item];
  if (!source || !moved || !sections[to.section]) return [...sections];
  const list = sections.map((s) => ({ ...s, items: [...s.items] }));
  (list[from.section] as FormSectionDto & { items: FormBindingDto[] }).items.splice(from.item, 1);
  let index = to.item;
  // Na mesma secção, retirar o item antes do destino desloca o destino uma posição.
  if (from.section === to.section && from.item < to.item) index -= 1;
  const target = list[to.section] as FormSectionDto & { items: FormBindingDto[] };
  target.items.splice(Math.max(0, Math.min(index, target.items.length)), 0, moved);
  return list;
}

export function boundFields(sections: Sections): Set<string> {
  return new Set(sections.flatMap((s) => s.items.map((i) => i.field)));
}

/** Campos (por código) que ainda não estão em nenhuma secção, pela ordem dada. */
export function unassignedFields(sections: Sections, codes: readonly string[]): string[] {
  const bound = boundFields(sections);
  return codes.filter((code) => !bound.has(code));
}
