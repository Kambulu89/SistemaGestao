import type { EntityDefinition } from '../models/entity-definition.model';
import type { FormDefinition } from '../models/form-definition.model';
import { CADASTRO_CLIENTE, CLIENTE } from '../../testing/form-fixtures';
import { formCandidates, formRank, resolveForm } from './form-resolver';

const form = (key: string, extra: Partial<FormDefinition> = {}): FormDefinition => ({
  ...CADASTRO_CLIENTE,
  key,
  name: key,
  ...extra,
});
const entityWith = (...forms: FormDefinition[]): EntityDefinition => ({ ...CLIENTE, forms });

describe('resolução de formulários e precedência', () => {
  it('sem formulários próprios gera-se um com todos os campos', () => {
    const resolved = resolveForm(CLIENTE, 'create');
    expect(resolved.key).toBe('auto');
    expect(resolved.sections[0]!.items).toHaveLength(CLIENTE.fields.length);
  });

  it('a precedência é tenant > global > embutido', () => {
    expect(formRank(form('a', { scope: 'tenant' }))).toBeGreaterThan(
      formRank(form('a', { scope: 'global' })),
    );
    expect(formRank(form('a', { scope: 'global' }))).toBeGreaterThan(formRank(form('a')));
    const entity = entityWith(
      form('embutido'),
      form('global', { scope: 'global', state: 'published', version: 1 }),
      form('tenant', { scope: 'tenant', state: 'published', version: 1 }),
    );
    expect(formCandidates(entity.forms, 'create').map((f) => f.key)).toEqual([
      'tenant',
      'global',
      'embutido',
    ]);
    expect(resolveForm(entity, 'create').key).toBe('tenant');
  });

  it('um formulário do tenant com a mesma chave substitui o global só para esse tenant', () => {
    const global = form('cadastro', {
      scope: 'global',
      state: 'published',
      version: 3,
      name: 'Global',
    });
    const custom = form('cadastro', {
      scope: 'tenant',
      state: 'published',
      version: 1,
      name: 'Do tenant',
    });
    expect(resolveForm(entityWith(global, custom), 'create').name).toBe('Do tenant');
    expect(resolveForm(entityWith(global), 'create').name).toBe('Global'); // outro tenant: não vê a personalização
    expect(formCandidates([global, custom], 'create')).toHaveLength(1);
  });

  it('dentro do mesmo âmbito prefere o formulário por omissão e depois a versão mais recente', () => {
    const a = form('a', { scope: 'tenant', state: 'published', version: 1 });
    const b = form('b', { scope: 'tenant', state: 'published', version: 1, isDefault: true });
    expect(resolveForm(entityWith(a, b), 'create').key).toBe('b');
    const v1 = form('c', { scope: 'tenant', state: 'published', version: 1, name: 'v1' });
    const v2 = form('c', { scope: 'tenant', state: 'published', version: 2, name: 'v2' });
    expect(resolveForm(entityWith(v1, v2), 'create').name).toBe('v2');
  });

  it('rascunhos e arquivados nunca são usados pelos utilizadores', () => {
    const draft = form('x', { scope: 'tenant', state: 'draft', version: 2 });
    const archived = form('y', { scope: 'tenant', state: 'archived', version: 1 });
    expect(resolveForm(entityWith(draft, archived), 'create').key).toBe('auto');
  });

  it('a versão publicada mantém-se estável enquanto existe um rascunho mais recente', () => {
    const published = form('x', {
      scope: 'tenant',
      state: 'published',
      version: 1,
      name: 'estável',
    });
    const draft = form('x', { scope: 'tenant', state: 'draft', version: 2, name: 'em edição' });
    expect(resolveForm(entityWith(published, draft), 'create').name).toBe('estável');
  });

  it('escolhe pelo modo e aceita um formulário pedido pela chave', () => {
    const create = form('novo', { modes: ['create'] });
    const view = form('ficha', { modes: ['read'] });
    const entity = entityWith(create, view);
    expect(resolveForm(entity, 'read').key).toBe('ficha');
    expect(resolveForm(entity, 'create', 'novo').key).toBe('novo');
    expect(resolveForm(entity, 'create', 'ficha').key).toBe('novo'); // a chave pedida não serve este modo
    expect(resolveForm(entity, 'edit').key).toBe('auto');
  });

  it('uma entidade pode ter vários formulários para o mesmo modo', () => {
    const simples = form('simples', { scope: 'tenant', state: 'published', version: 1 });
    const completo = form('completo', {
      scope: 'tenant',
      state: 'published',
      version: 1,
      isDefault: true,
    });
    const entity = entityWith(simples, completo);
    expect(resolveForm(entity, 'create').key).toBe('completo');
    expect(resolveForm(entity, 'create', 'simples').key).toBe('simples');
  });
});
