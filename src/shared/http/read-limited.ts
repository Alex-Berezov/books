/**
 * Тело ответа узкого внешнего клиента не больше `max` байт (Wikidata `F08-12a`, тайлы OSM
 * `F08-12d`): заявленный `content-length` больше предела - отказ без чтения, поток сверх предела -
 * чтение обрывается, а не дочитывается. Тела нет - пустой буфер. Больше предела - `null`.
 */
export async function readLimitedBytes(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
