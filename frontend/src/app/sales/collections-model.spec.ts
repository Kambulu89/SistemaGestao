import { BUCKET, bucketTone, PROMISE_STATUS, promiseTone } from './collections-model';

describe('collections-model', () => {
  it('rótulos e tons semânticos', () => {
    expect(BUCKET['D90_PLUS']).toBe('Mais de 90 dias');
    expect(PROMISE_STATUS['KEPT']).toBe('Cumprida');
    expect(promiseTone('BROKEN')).toContain('danger');
    expect(bucketTone('CURRENT')).toContain('muted');
    expect(bucketTone('D61_90')).toContain('danger');
  });
});
