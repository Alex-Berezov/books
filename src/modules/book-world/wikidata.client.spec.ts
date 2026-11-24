import {
  sameHostLocation,
  WikidataClient,
  WIKIDATA_MAX_BYTES,
  WIKIDATA_MAX_REDIRECTS,
  WIKIDATA_USER_AGENT,
} from './wikidata.client';

/** Узкий клиент Wikidata (`F08-12a`, решение арбитра `F08 | F08-12` Q2). */
describe('WikidataClient (F08-12a, Q2: постоянный хост, предел, без чужих переходов)', () => {
  const respond = (status: number, body = '', headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : body, { status, headers });
  const clientWith = (impl: (url: string) => Response) => {
    const calls: string[] = [];
    const inits: RequestInit[] = [];
    const client = new WikidataClient((url, init) => {
      calls.push(url);
      inits.push(init);
      return Promise.resolve(impl(url));
    });
    return { client, calls, inits };
  };

  it('переходы вручную, таймаут на запрос, свой User-Agent и Accept JSON', async () => {
    const { client, inits } = clientWith(() => respond(200, '{"entities":{}}'));
    await client.entity('Q656');
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe('manual');
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
    expect(inits[0].headers).toEqual({
      'User-Agent': WIKIDATA_USER_AGENT,
      Accept: 'application/json',
    });
  });

  it('транспорт оборвал запрос (таймаут) — unavailable', async () => {
    const client = new WikidataClient(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
    );
    await expect(client.entity('Q656')).resolves.toEqual({ kind: 'unavailable' });
  });

  it('читает постоянный адрес Special:EntityData', async () => {
    const { client, calls } = clientWith(() => respond(200, JSON.stringify({ entities: {} })));
    await expect(client.entity('Q656')).resolves.toEqual({ kind: 'ok', body: { entities: {} } });
    expect(calls).toEqual(['https://www.wikidata.org/wiki/Special:EntityData/Q656.json']);
  });

  it('номер не по форме — запроса нет', async () => {
    const { client, calls } = clientWith(() => respond(200, '{}'));
    await expect(client.entity('../etc')).resolves.toEqual({ kind: 'not_found' });
    expect(calls).toEqual([]);
  });

  it('переход на чужой хост — unavailable, второго запроса нет', async () => {
    const { client, calls } = clientWith(() =>
      respond(302, '', { location: 'https://evil.example/Q656.json' }),
    );
    await expect(client.entity('Q656')).resolves.toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('переход внутри Wikidata — идёт по нему', async () => {
    const { client, calls } = clientWith((url) =>
      url.endsWith('Q656.json')
        ? respond(303, '', { location: '/wiki/Special:EntityData/Q2.json' })
        : respond(200, '{"entities":{}}'),
    );
    await expect(client.entity('Q656')).resolves.toMatchObject({ kind: 'ok' });
    expect(calls[1]).toBe('https://www.wikidata.org/wiki/Special:EntityData/Q2.json');
  });

  it('404 — not_found; 500 и битый JSON — unavailable', async () => {
    await expect(clientWith(() => respond(404)).client.entity('Q1')).resolves.toEqual({
      kind: 'not_found',
    });
    await expect(clientWith(() => respond(500)).client.entity('Q1')).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(clientWith(() => respond(200, '{oops')).client.entity('Q1')).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('переходов внутри хоста больше предела — unavailable, запросов ровно предел + 1', async () => {
    const { client, calls } = clientWith(() =>
      respond(303, '', { location: '/wiki/Special:EntityData/Q2.json' }),
    );
    await expect(client.entity('Q656')).resolves.toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(WIKIDATA_MAX_REDIRECTS + 1);
  });

  it('тело больше предела без content-length — чтение обрывается, unavailable', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 11) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const big = clientWith(() => new Response(stream, { status: 200 }));
    await expect(big.client.entity('Q1')).resolves.toEqual({ kind: 'unavailable' });
    expect(sent).toBeLessThanOrEqual(12);
  });

  it('ответ больше предела — unavailable', async () => {
    const big = clientWith(() =>
      respond(200, '{}', { 'content-length': String(WIKIDATA_MAX_BYTES + 1) }),
    );
    await expect(big.client.entity('Q1')).resolves.toEqual({ kind: 'unavailable' });
  });

  it('sameHostLocation: только https на www.wikidata.org', () => {
    const base = 'https://www.wikidata.org/wiki/Special:EntityData/Q1.json';
    expect(sameHostLocation('http://www.wikidata.org/x', base)).toBeNull();
    expect(sameHostLocation('https://wikidata.org.evil/x', base)).toBeNull();
    expect(sameHostLocation(null, base)).toBeNull();
    expect(sameHostLocation('/wiki/x', base)).toBe('https://www.wikidata.org/wiki/x');
  });
});
