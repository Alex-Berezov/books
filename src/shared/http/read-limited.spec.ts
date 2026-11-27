import { readLimitedBytes } from './read-limited';

describe('readLimitedBytes', () => {
  it('тело в пределе - байты целиком; тела нет - пустой буфер', async () => {
    expect(await readLimitedBytes(new Response('abc'), 10)).toEqual(Buffer.from('abc'));
    expect(await readLimitedBytes(new Response(null), 10)).toEqual(Buffer.alloc(0));
  });

  it('заявленный content-length больше предела - null без чтения', async () => {
    const res = new Response('abc', { headers: { 'content-length': '100' } });
    expect(await readLimitedBytes(res, 10)).toBeNull();
  });

  it('поток больше предела - null', async () => {
    expect(await readLimitedBytes(new Response('x'.repeat(11)), 10)).toBeNull();
  });
});
