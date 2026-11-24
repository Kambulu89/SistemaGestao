import { documentLink, SUBMISSION_STATUS, submissionTone } from './fiscal-integration-model';

describe('fiscal-integration-model', () => {
  it('estados marcados como simulação e tons semânticos', () => {
    expect(SUBMISSION_STATUS['ACCEPTED']).toContain('simulação');
    expect(submissionTone('ACCEPTED')).toContain('success');
    expect(submissionTone('FAILED')).toContain('danger');
    expect(submissionTone('CONTINGENCY')).toContain('warning');
  });
  it('liga ao documento de origem', () => {
    expect(documentLink({ documentType: 'SALES_NOTE', documentId: 'x' })).toEqual([
      '/vendas/notas',
      'x',
    ]);
    expect(documentLink({ documentType: 'SALES_INVOICE', documentId: 'y' })).toEqual([
      '/vendas/facturas',
      'y',
    ]);
  });
});
