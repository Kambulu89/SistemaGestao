import { TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  DocumentsApi,
  type AttachmentDto,
  type DocumentDto,
  type TemplateDto,
  type TemplateVersionDto,
  type UploadState,
} from './documents.api';
import { DocumentsPage } from './documents-page';
import {
  declareUsed,
  documentError,
  formatSize,
  unavailableText,
  uploadLabel,
  usedVariables,
} from './documents-model';
import { LibraryTab } from './library-tab';
import { TemplatesTab } from './templates-tab';
import { UploadBox } from './upload-box';

const attachment = (over: Partial<AttachmentDto> = {}): AttachmentDto => ({
  id: 'a1',
  originalName: 'contrato.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  checksum: 'a'.repeat(64),
  status: 'AVAILABLE',
  rejectCode: null,
  scannedAt: '2026-10-01T10:00:00Z',
  createdAt: '2026-10-01T10:00:00Z',
  downloadable: true,
  ...over,
});

const doc = (over: Partial<DocumentDto> = {}): DocumentDto => ({
  id: 'd1',
  title: 'Contrato Acme',
  categoryCode: 'contratos',
  ownerMembershipId: 'm1',
  visibility: 'TENANT',
  resourceType: null,
  resourceId: null,
  retentionUntil: null,
  legalHold: false,
  version: 3,
  current: {
    versionId: 'v2',
    revision: 2,
    attachmentId: 'a1',
    fileName: 'contrato.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    status: 'AVAILABLE',
  },
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  ...over,
});

const template = (over: Partial<TemplateDto> = {}): TemplateDto => ({
  id: 't1',
  code: 'proposta',
  name: 'Proposta',
  channel: 'DOCUMENT',
  resourceType: null,
  publishedRevision: 1,
  latestRevision: 2,
  version: 1,
  createdAt: '2026-10-01T10:00:00Z',
  ...over,
});

const SCHEMA = {
  variables: [
    { name: 'cliente', label: 'Cliente', type: 'string' as const, required: true },
    { name: 'total', label: 'Total', type: 'decimal' as const, required: true },
  ],
};

const tversion = (over: Partial<TemplateVersionDto> = {}): TemplateVersionDto => ({
  id: 'tv1',
  revision: 1,
  body: 'Olá {{cliente}}, total {{total}}',
  variableSchema: SCHEMA,
  status: 'PUBLISHED',
  locale: 'pt-AO',
  publishedAt: '2026-10-01T10:00:00Z',
  version: 2,
  createdAt: '2026-10-01T10:00:00Z',
  ...over,
});

const ALL = [
  'document.read',
  'document.manage',
  'template.read',
  'template.manage',
  'template.publish',
];

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    documents: vi.fn(() => of({ items: [doc()], total: 1 })),
    document: vi.fn(() =>
      of({
        document: doc(),
        versions: [
          {
            id: 'v2',
            revision: 2,
            attachmentId: 'a1',
            fileName: 'contrato.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 2048,
            status: 'AVAILABLE',
            changeNote: 'Prazo corrigido',
            templateVersionId: null,
            createdAt: '2026-10-02T10:00:00Z',
          },
          {
            id: 'v1',
            revision: 1,
            attachmentId: 'a0',
            fileName: 'rascunho.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            status: 'AVAILABLE',
            changeNote: null,
            templateVersionId: null,
            createdAt: '2026-10-01T10:00:00Z',
          },
        ],
      }),
    ),
    createDocument: vi.fn(() => of(doc())),
    updateDocument: vi.fn(() => of(doc())),
    deleteDocument: vi.fn(() => of(undefined)),
    addVersion: vi.fn(() => of({})),
    downloadUrl: vi.fn(() => of('http://localhost:3333/api/v1/files/abc.def')),
    upload: vi.fn(() => of({ stage: 'done', attachment: attachment() } as UploadState)),
    templates: vi.fn(() => of([template()])),
    template: vi.fn(() =>
      of({
        template: template(),
        versions: [tversion({ id: 'tv2', revision: 2, status: 'DRAFT', version: 1 }), tversion()],
      }),
    ),
    createTemplate: vi.fn(() => of(template())),
    addTemplateVersion: vi.fn(() => of(tversion())),
    updateTemplateDraft: vi.fn(() => of(tversion())),
    deleteTemplateDraft: vi.fn(() => of(undefined)),
    publishTemplate: vi.fn(() => of(tversion())),
    previewTemplate: vi.fn(() =>
      of({ text: 'Olá Ana, total 10', html: 'Olá &lt;b&gt;Ana&lt;/b&gt;' }),
    ),
    generate: vi.fn(() => of(doc())),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: DocumentsApi, useValue: full },
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
  return document.body.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `#${lab?.htmlFor}`,
  )!;
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

function pickFile(name = 'contrato.pdf') {
  const input = document.body.querySelector<HTMLInputElement>('input[type=file]')!;
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(input, 'files', {
    value: { item: () => file, length: 1 },
    configurable: true,
  });
  input.dispatchEvent(new Event('change'));
}

afterEach(() => TestBed.resetTestingModule());

describe('modelo', () => {
  it('formata tamanhos, estados e erros', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 kB');
    expect(formatSize(5 * 1048576)).toBe('5.0 MB');
    expect(uploadLabel('uploading', 40)).toBe('A enviar… 40%');
    expect(unavailableText('QUARANTINED', null)).toContain('quarentena');
    expect(unavailableText('REJECTED', 'MIME_MISMATCH')).toContain('não corresponde');
    expect(documentError({ code: 'QUOTA_EXCEEDED' }, 'x')).toContain('espaço');
    expect(
      documentError({ fieldErrors: [{ code: 'FILE_TOO_LARGE', message: 'm' }] }, 'x'),
    ).toContain('tamanho máximo');
    expect(documentError({}, 'fallback')).toBe('fallback');
  });

  it('descobre as variáveis do corpo e declara as que faltam', () => {
    expect(usedVariables('{{ a }} e {{b}} e {{a}}')).toEqual(['a', 'b']);
    expect(usedVariables('{{ now() }} {{> x}}')).toEqual([]);
    const declared = declareUsed('{{cliente}} {{novo}}', SCHEMA.variables);
    expect(declared.map((v) => v.name)).toEqual(['cliente', 'total', 'novo']);
    expect(declared[2]).toMatchObject({ type: 'string', required: true });
  });
});

describe('UploadBox', () => {
  async function open(upload: Observable<UploadState>) {
    configure({ upload: vi.fn(() => upload) });
    const fixture = TestBed.createComponent(UploadBox);
    const emitted: (AttachmentDto | null)[] = [];
    fixture.componentInstance.attachmentChange.subscribe((a) => emitted.push(a));
    await settle(fixture);
    return { fixture, emitted };
  }

  it('mostra o progresso e entrega o anexo disponível', async () => {
    const stream = new Subject<UploadState>();
    const { fixture, emitted } = await open(stream);
    pickFile();
    stream.next({ stage: 'uploading', percent: 40 });
    await settle(fixture);
    expect(text()).toContain('A enviar… 40%');
    expect(document.body.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe(
      '40',
    );
    stream.next({ stage: 'done', attachment: attachment() });
    stream.complete();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=upload-status]')?.textContent).toContain(
      'Disponível',
    );
    expect(emitted.at(-1)?.id).toBe('a1');
  });

  it('um ficheiro em quarentena fica visível e não é entregue a quem o usaria', async () => {
    const { fixture, emitted } = await open(
      of({
        stage: 'done',
        attachment: attachment({ status: 'QUARANTINED', downloadable: false }),
      } as UploadState),
    );
    pickFile('virus.txt');
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=upload-status]')?.textContent).toContain(
      'Em quarentena',
    );
    expect(text()).toContain('não pode ser usado nem descarregado');
    expect(emitted.every((e) => e === null)).toBe(true);
    expect(buttons('Tentar de novo')).toHaveLength(1);
  });

  it('mostra o erro do servidor, permite tentar de novo e cancelar', async () => {
    const calls: Observable<UploadState>[] = [
      throwError(() => ({ code: 'QUOTA_EXCEEDED' })),
      new Subject<UploadState>(),
    ];
    configure({ upload: vi.fn(() => calls.shift()!) });
    const fixture = TestBed.createComponent(UploadBox);
    await settle(fixture);
    pickFile();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=upload-error]')?.textContent).toContain(
      'espaço',
    );
    button('Tentar de novo').click();
    await settle(fixture);
    expect(buttons('Cancelar')).toHaveLength(1);
    button('Cancelar').click();
    await settle(fixture);
    expect(text()).toContain('Envio cancelado.');
  });
});

describe('LibraryTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(LibraryTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('lista os documentos e descarrega por URL curta', async () => {
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    const { fixture, mocked } = await open();
    expect(text()).toContain('Contrato Acme');
    expect(text()).toContain('contrato.pdf · v2');
    button('Descarregar').click();
    await settle(fixture);
    expect(mocked.downloadUrl).toHaveBeenCalledWith('a1');
    expect(openWindow).toHaveBeenCalledWith(
      'http://localhost:3333/api/v1/files/abc.def',
      '_blank',
      'noopener',
    );
    openWindow.mockRestore();
  });

  it('pesquisa pelo título', async () => {
    const { fixture, mocked } = await open();
    type('Pesquisar', 'acme');
    await settle(fixture);
    expect(mocked.documents).toHaveBeenLastCalledWith({
      search: 'acme',
      categoryCode: '',
      limit: 100,
    });
  });

  it('só cria o documento depois do ficheiro verificado', async () => {
    const { fixture, mocked } = await open();
    button('Novo documento').click();
    await settle(fixture);
    expect(button('Criar').disabled).toBe(true);
    pickFile();
    await settle(fixture);
    type('Título', 'Novo contrato');
    await settle(fixture);
    button('Criar').click();
    await settle(fixture);
    expect(mocked.createDocument).toHaveBeenCalledWith({
      title: 'Novo contrato',
      attachmentId: 'a1',
      categoryCode: 'general',
      visibility: 'PRIVATE',
    });
    expect(text()).toContain('Documento criado.');
  });

  it('abre o documento, mostra as versões e acrescenta uma nova', async () => {
    const { fixture, mocked } = await open();
    button('Abrir').click();
    await settle(fixture);
    const versions = document.body.querySelector('[data-testid=versions]')?.textContent ?? '';
    expect(versions).toContain('v2');
    expect(versions).toContain('Prazo corrigido');
    expect(versions).toContain('rascunho.pdf');
    // A caixa de envio da nova versão é a segunda.
    const input = document.body.querySelectorAll<HTMLInputElement>('input[type=file]')[0]!;
    const file = new File(['x'], 'v3.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', {
      value: { item: () => file, length: 1 },
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await settle(fixture);
    type('Nota da alteração', 'Terceira');
    await settle(fixture);
    button('Acrescentar versão').click();
    await settle(fixture);
    expect(mocked.addVersion).toHaveBeenCalledWith('d1', {
      attachmentId: 'a1',
      changeNote: 'Terceira',
    });
  });

  it('guarda com a versão do servidor e apaga com confirmação', async () => {
    const { fixture, mocked } = await open();
    button('Abrir').click();
    await settle(fixture);
    type('Título', 'Contrato Acme (final)');
    type('Retido até (AAAA-MM-DD)', '2030-01-01');
    await settle(fixture);
    button('Guardar').click();
    await settle(fixture);
    expect(mocked.updateDocument).toHaveBeenCalledWith('d1', {
      version: 3,
      title: 'Contrato Acme (final)',
      categoryCode: 'contratos',
      visibility: 'TENANT',
      retentionUntil: '2030-01-01',
      legalHold: false,
    });
    button('Apagar').click();
    await settle(fixture);
    expect(mocked.deleteDocument).not.toHaveBeenCalled();
    button('Confirmar: apagar').click();
    await settle(fixture);
    expect(mocked.deleteDocument).toHaveBeenCalledWith('d1');
  });

  it('recusa uma data de retenção inválida e mostra o erro do servidor', async () => {
    const updateDocument = vi.fn(() => throwError(() => ({ code: 'DOCUMENT_LEGAL_HOLD' })));
    const { fixture } = await open({ updateDocument });
    button('Abrir').click();
    await settle(fixture);
    type('Retido até (AAAA-MM-DD)', '30/01/2030');
    button('Guardar').click();
    await settle(fixture);
    expect(text()).toContain('AAAA-MM-DD');
    expect(updateDocument).not.toHaveBeenCalled();
    type('Retido até (AAAA-MM-DD)', '');
    button('Guardar').click();
    await settle(fixture);
    expect(text()).toContain('retenção legal');
  });

  it('sem document.manage só se lê e descarrega', async () => {
    await open({}, ['document.read']);
    expect(buttons('Novo documento')).toHaveLength(0);
    button('Abrir').click();
    expect(buttons('Guardar')).toHaveLength(0);
    expect(buttons('Apagar')).toHaveLength(0);
  });

  it('mostra o estado de quarentena de um documento', async () => {
    const quarantined = doc({
      current: { ...doc().current!, status: 'QUARANTINED' },
    });
    await open({ documents: () => of({ items: [quarantined], total: 1 }) });
    expect(text()).toContain('Em quarentena');
    expect(buttons('Descarregar')).toHaveLength(0);
  });
});

describe('TemplatesTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(TemplatesTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('lista os modelos e abre as versões', async () => {
    const { fixture } = await open();
    expect(text()).toContain('Proposta');
    expect(text()).toContain('v1');
    button('Abrir').click();
    await settle(fixture);
    const versions =
      document.body.querySelector('[data-testid=template-versions]')?.textContent ?? '';
    expect(versions).toContain('Rascunho');
    expect(versions).toContain('Publicada');
  });

  it('cria um modelo', async () => {
    const { fixture, mocked } = await open();
    button('Novo modelo').click();
    await settle(fixture);
    type('Código', 'contrato');
    type('Nome', 'Contrato');
    button('Criar').click();
    await settle(fixture);
    expect(mocked.createTemplate).toHaveBeenCalledWith({
      code: 'contrato',
      name: 'Contrato',
      channel: 'DOCUMENT',
    });
    expect(text()).toContain('Modelo criado.');
  });

  it('edita o rascunho: declara as variáveis usadas e guarda com a versão', async () => {
    const { fixture, mocked } = await open();
    button('Abrir').click();
    await settle(fixture);
    button('Editar').click();
    await settle(fixture);
    type('Corpo', 'Olá {{cliente}} {{total}} {{prazo}}');
    await settle(fixture);
    button('Declarar as usadas no corpo').click();
    await settle(fixture);
    expect(document.body.querySelectorAll('[data-testid=variables] li')).toHaveLength(3);
    button('Guardar').click();
    await settle(fixture);
    const [id, versionId, body] = mocked.updateTemplateDraft.mock.calls[0] as unknown as [
      string,
      string,
      { version: number; body: string; variableSchema: { variables: { name: string }[] } },
    ];
    expect([id, versionId, body.version, body.body]).toEqual([
      't1',
      'tv2',
      1,
      'Olá {{cliente}} {{total}} {{prazo}}',
    ]);
    expect(body.variableSchema.variables.map((v) => v.name)).toEqual(['cliente', 'total', 'prazo']);
  });

  it('uma versão publicada só serve de base para uma nova', async () => {
    const { fixture, mocked } = await open();
    button('Abrir').click();
    await settle(fixture);
    button('Nova versão a partir desta').click();
    await settle(fixture);
    button('Guardar').click();
    await settle(fixture);
    expect(mocked.updateTemplateDraft).not.toHaveBeenCalled();
    expect(mocked.addTemplateVersion).toHaveBeenCalled();
  });

  it('pré-visualiza com dados de teste e mostra o HTML escapado', async () => {
    const { fixture, mocked } = await open();
    button('Abrir').click();
    await settle(fixture);
    button('Pré-visualizar').click();
    await settle(fixture);
    type('Cliente (cliente)', '<b>Ana</b>');
    type('Total (total)', '10');
    await settle(fixture);
    buttons('Pré-visualizar')[buttons('Pré-visualizar').length - 1]!.click();
    await settle(fixture);
    expect(mocked.previewTemplate).toHaveBeenCalledWith('t1', 'tv2', {
      cliente: '<b>Ana</b>',
      total: '10',
    });
    expect(document.body.querySelector('[data-testid=preview-html]')?.textContent).toContain(
      '&lt;b&gt;',
    );
  });

  it('só publica quem tem template.publish; gerir não basta', async () => {
    const { fixture, mocked } = await open({}, ['template.read', 'template.manage']);
    button('Abrir').click();
    await settle(fixture);
    expect(buttons('Publicar')).toHaveLength(0);
    TestBed.resetTestingModule();
    const again = await open({}, ALL);
    button('Abrir').click();
    await settle(again.fixture);
    button('Publicar').click();
    await settle(again.fixture);
    expect(again.mocked.publishTemplate).toHaveBeenCalledWith('t1', 'tv2');
    expect(text()).toContain('imutável');
    expect(mocked.publishTemplate).not.toHaveBeenCalled();
  });

  it('gera um documento a partir da versão publicada', async () => {
    const { fixture, mocked } = await open();
    button('Abrir').click();
    await settle(fixture);
    button('Gerar documento (PDF)').click();
    await settle(fixture);
    button('Gerar PDF').click();
    await settle(fixture);
    expect(text()).toContain('Indique o título');
    type('Título do documento', 'Proposta Ana');
    type('Cliente', 'Ana');
    type('Total', '1500.50');
    await settle(fixture);
    button('Gerar PDF').click();
    await settle(fixture);
    expect(mocked.generate).toHaveBeenCalledWith('t1', {
      title: 'Proposta Ana',
      variables: { cliente: 'Ana', total: '1500.50' },
      visibility: 'PRIVATE',
    });
    expect(text()).toContain('Documento gerado');
  });

  it('mostra o erro do servidor ao gerar', async () => {
    const generate = vi.fn(() => throwError(() => ({ code: 'TEMPLATE_NOT_PUBLISHED' })));
    const { fixture } = await open({ generate });
    button('Abrir').click();
    await settle(fixture);
    button('Gerar documento (PDF)').click();
    await settle(fixture);
    type('Título do documento', 'x');
    button('Gerar PDF').click();
    await settle(fixture);
    expect(text()).toContain('ainda não tem uma versão publicada');
  });
});

describe('DocumentsPage', () => {
  it('mostra os separadores a que a pessoa tem acesso', async () => {
    configure({}, ['document.read']);
    const fixture = TestBed.createComponent(DocumentsPage);
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=tab-library]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid=tab-templates]')).toBeNull();
  });

  it('muda para os modelos', async () => {
    configure();
    const fixture = TestBed.createComponent(DocumentsPage);
    await settle(fixture);
    (document.body.querySelector('[data-testid=tab-templates]') as HTMLElement).click();
    await settle(fixture);
    expect(text()).toContain('Novo modelo');
  });
});
