import { createHash } from 'node:crypto';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { UploadsService } from '../uploads/uploads.service';
import type { Request } from 'express';

/**
 * WP-8.2 (R1-04). Обложка входит в content hash по контрольной сумме файла, а сумму никто
 * не считал: `MediaAsset.hash` приходил только из тела запроса, которого одношаговая загрузка
 * не присылает. Пустой хеш означал бы, что подмена файла остаётся невидимой и после WP-8.
 */
describe('MediaController — checksum on upload', () => {
  const buffer = Buffer.from('cover-bytes');
  const expectedHash = createHash('sha256').update(buffer).digest('hex');

  const service = { confirm: jest.fn().mockResolvedValue({ id: 'media-1' }) };
  const uploads = {
    presign: jest.fn().mockResolvedValue({ token: 'token-1', key: 'covers/cover.jpg' }),
    directUpload: jest.fn().mockResolvedValue({ publicUrl: 'https://cdn/covers/cover.jpg' }),
  };

  const req = { user: { userId: 'user-1' } } as unknown as Request;

  beforeEach(() => jest.clearAllMocks());

  it('stores the sha256 of the uploaded file', async () => {
    const controller = new MediaController(
      service as unknown as MediaService,
      uploads as unknown as UploadsService,
    );

    await controller.uploadOne(
      { buffer, mimetype: 'image/jpeg', size: buffer.length },
      undefined,
      req,
    );

    expect(service.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'covers/cover.jpg', hash: expectedHash }),
      'user-1',
    );
  });
});
