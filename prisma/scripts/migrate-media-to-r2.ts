/*
  Migrate existing media files from local storage to Cloudflare R2.

  Scans MediaAsset and other tables for old URLs (not on media.bibliaris.com),
  uploads the files to R2, and updates the database records.

  Usage:
    # Dry-run (shows what would be migrated)
    npx ts-node prisma/scripts/migrate-media-to-r2.ts --dry-run

    # Execute migration
    npx ts-node prisma/scripts/migrate-media-to-r2.ts

    # Execute with custom batch size
    BATCH_SIZE=20 npx ts-node prisma/scripts/migrate-media-to-r2.ts

  Run inside the Docker container on production:
    docker compose exec app npx ts-node prisma/scripts/migrate-media-to-r2.ts --dry-run
    docker compose exec app npx ts-node prisma/scripts/migrate-media-to-r2.ts

  Safe to re-run: already-migrated URLs are skipped.
*/

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
const OLD_DOMAINS = [
  'https://api.bibliaris.com',
  'https://bibliaris.com',
  'http://localhost:5000',
  'http://localhost:8787',
];
const NEW_CDN_BASE = 'https://media.bibliaris.com';

interface MigrationCounts {
  mediaAssetsMigrated: number;
  mediaAssetsSkipped: number;
  mediaAssetsFailed: number;
  bookVersionCoversMigrated: number;
  bookVersionCoversSkipped: number;
  seoOgImagesMigrated: number;
  seoOgImagesSkipped: number;
  authorPhotosMigrated: number;
  authorPhotosSkipped: number;
  categoryOgImagesMigrated: number;
  categoryOgImagesSkipped: number;
  tagOgImagesMigrated: number;
  tagOgImagesSkipped: number;
}

function isOldUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return OLD_DOMAINS.some((d) => url.startsWith(d));
}

function getLocalPath(key: string): string {
  const baseDir = process.env.LOCAL_UPLOADS_DIR || './var/uploads';
  return resolve(join(baseDir, key.replace(/\\/g, '/')));
}

function newCdnUrl(key: string): string {
  const normalizedKey = key.replace(/\\/g, '/');
  const encoded = normalizedKey.split('/').map(encodeURIComponent).join('/');
  return `${NEW_CDN_BASE}/${encoded}`;
}

function initS3Client(): S3Client | null {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    if (!DRY_RUN) {
      console.error(
        'R2 env vars not fully set (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET). Cannot run without --dry-run.',
      );
      process.exit(1);
    }
    return null;
  }
  return new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function uploadToR2(
  s3: S3Client,
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const bucket = process.env.R2_BUCKET!;
  const keyPrefix = process.env.R2_KEY_PREFIX || '';
  const objectKey = keyPrefix
    ? `${keyPrefix.replace(/^\/+|\/+$/g, '')}/${key.replace(/\\/g, '/')}`
    : key.replace(/\\/g, '/');

  const fileBuffer = await fs.readFile(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

async function migrateMediaAssets(
  prisma: PrismaClient,
  s3: S3Client | null,
  counts: MigrationCounts,
): Promise<void> {
  console.log('\n=== Phase 1: MediaAsset ===');

  let page = 0;
  for (;;) {
    const assets = await prisma.mediaAsset.findMany({
      where: { url: { not: { startsWith: NEW_CDN_BASE } } },
      orderBy: { createdAt: 'asc' },
      skip: page * BATCH_SIZE,
      take: BATCH_SIZE,
    });
    if (assets.length === 0) break;
    page++;

    for (const asset of assets) {
      if (asset.url.startsWith(NEW_CDN_BASE)) {
        counts.mediaAssetsSkipped++;
        continue;
      }
      if (!isOldUrl(asset.url)) {
        console.log(`  SKIP ${asset.id}: url does not match known old domains (${asset.url})`);
        counts.mediaAssetsSkipped++;
        continue;
      }
      if (!asset.key) {
        console.log(`  SKIP ${asset.id}: no key field for url ${asset.url}`);
        counts.mediaAssetsSkipped++;
        continue;
      }

      const localPath = getLocalPath(asset.key);
      const contentType = asset.contentType || 'application/octet-stream';
      const newUrl = newCdnUrl(asset.key);

      console.log(`  ${DRY_RUN ? 'DRY-RUN' : 'MIGRATE'} ${asset.id}:`);
      console.log(`    key: ${asset.key}`);
      console.log(`    old: ${asset.url}`);
      console.log(`    new: ${newUrl}`);
      console.log(`    local: ${localPath}`);

      const fileExists = await fs
        .access(localPath)
        .then(() => true)
        .catch(() => false);
      if (!fileExists) {
        console.log(`    FAIL: local file not found at ${localPath}`);
        counts.mediaAssetsFailed++;
        continue;
      }

      if (DRY_RUN) {
        counts.mediaAssetsMigrated++;
        continue;
      }

      if (!s3) {
        console.log('    FAIL: R2 client not initialized');
        counts.mediaAssetsFailed++;
        continue;
      }

      try {
        await uploadToR2(s3, asset.key, localPath, contentType);
        await prisma.mediaAsset.update({
          where: { id: asset.id },
          data: { url: newUrl },
        });
        console.log('    OK');
        counts.mediaAssetsMigrated++;
      } catch (e) {
        console.error(`    FAIL: ${(e as Error).message}`);
        counts.mediaAssetsFailed++;
      }
    }
  }

  if (page === 0) {
    console.log('  No MediaAsset records to migrate.');
  }
}

async function migrateField(
  prisma: PrismaClient,
  s3: S3Client | null,
  counts: MigrationCounts,
  tableName: string,
  records: { id: string; url: string | null }[],
  updateFn: (id: string, newUrl: string) => Promise<unknown>,
  countMigrated: () => void,
  countSkipped: () => void,
): Promise<void> {
  let migrated = 0;
  let skipped = 0;

  for (const record of records) {
    if (!record.url || record.url.startsWith(NEW_CDN_BASE)) {
      skipped++;
      continue;
    }
    if (!isOldUrl(record.url)) {
      skipped++;
      continue;
    }

    const urlObj = new URL(record.url);
    const key = urlObj.pathname.replace(/^\/+/, '');
    const localPath = getLocalPath(key);
    const newUrl = newCdnUrl(key);
    const ext = key.split('.').pop()?.toLowerCase() || 'bin';
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      webm: 'audio/webm',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    console.log(`  ${DRY_RUN ? 'DRY-RUN' : 'MIGRATE'} ${tableName} ${record.id}:`);
    console.log(`    old: ${record.url}`);
    console.log(`    new: ${newUrl}`);
    console.log(`    local: ${localPath}`);

    const fileExists = await fs
      .access(localPath)
      .then(() => true)
      .catch(() => false);
    if (!fileExists) {
      console.log(`    FAIL: local file not found at ${localPath}`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      migrated++;
      continue;
    }

    if (!s3) {
      console.log('    FAIL: R2 client not initialized');
      skipped++;
      continue;
    }

    try {
      await uploadToR2(s3, key, localPath, contentType);
      await updateFn(record.id, newUrl);
      console.log('    OK');
      migrated++;
    } catch (e) {
      console.error(`    FAIL: ${(e as Error).message}`);
      skipped++;
    }
  }

  // Apply counts
  for (let i = 0; i < migrated; i++) countMigrated();
  for (let i = 0; i < skipped; i++) countSkipped();
}

async function migrateBookVersionCovers(
  prisma: PrismaClient,
  s3: S3Client | null,
  counts: MigrationCounts,
): Promise<void> {
  console.log('\n=== Phase 2: BookVersion.coverImageUrl ===');

  let page = 0;

  for (;;) {
    const records = await prisma.bookVersion.findMany({
      where: {
        coverImageUrl: { not: { startsWith: NEW_CDN_BASE } },
      },
      orderBy: { createdAt: 'asc' },
      skip: page * BATCH_SIZE,
      take: BATCH_SIZE,
      select: { id: true, coverImageUrl: true },
    });
    if (records.length === 0) break;
    page++;

    await migrateField(
      prisma,
      s3,
      counts,
      'BookVersion',
      records.map((r) => ({ id: r.id, url: r.coverImageUrl })),
      (id, newUrl) => prisma.bookVersion.update({ where: { id }, data: { coverImageUrl: newUrl } }),
      () => {
        counts.bookVersionCoversMigrated++;
      },
      () => {
        counts.bookVersionCoversSkipped++;
      },
    );
  }

  if (page === 0) console.log('  No BookVersion covers to migrate.');
}

async function migrateSeoOgImages(
  prisma: PrismaClient,
  s3: S3Client | null,
  counts: MigrationCounts,
): Promise<void> {
  console.log('\n=== Phase 3: Seo.ogImageUrl ===');

  let page = 0;

  for (;;) {
    const records = await prisma.seo.findMany({
      where: {
        ogImageUrl: { not: { startsWith: NEW_CDN_BASE } },
      },
      orderBy: { createdAt: 'asc' },
      skip: page * BATCH_SIZE,
      take: BATCH_SIZE,
      select: { id: true, ogImageUrl: true },
    });
    if (records.length === 0) break;
    page++;

    await migrateField(
      prisma,
      s3,
      counts,
      'Seo',
      records.map((r) => ({ id: String(r.id), url: r.ogImageUrl })),
      (id, newUrl) =>
        prisma.seo.update({ where: { id: Number(id) }, data: { ogImageUrl: newUrl } }),
      () => {
        counts.seoOgImagesMigrated++;
      },
      () => {
        counts.seoOgImagesSkipped++;
      },
    );
  }

  if (page === 0) console.log('  No Seo OG images to migrate.');
}

async function migrateAuthorPhotos(
  prisma: PrismaClient,
  s3: S3Client | null,
  counts: MigrationCounts,
): Promise<void> {
  console.log('\n=== Phase 4: AuthorTranslation.photoUrl ===');

  let page = 0;

  for (;;) {
    const records = await prisma.authorTranslation.findMany({
      where: {
        photoUrl: { not: { startsWith: NEW_CDN_BASE } },
      },
      orderBy: { id: 'asc' },
      skip: page * BATCH_SIZE,
      take: BATCH_SIZE,
      select: { id: true, photoUrl: true },
    });
    if (records.length === 0) break;
    page++;

    await migrateField(
      prisma,
      s3,
      counts,
      'AuthorTranslation',
      records.map((r) => ({ id: r.id, url: r.photoUrl })),
      (id, newUrl) =>
        prisma.authorTranslation.update({ where: { id }, data: { photoUrl: newUrl } }),
      () => {
        counts.authorPhotosMigrated++;
      },
      () => {
        counts.authorPhotosSkipped++;
      },
    );
  }

  if (page === 0) console.log('  No Author photos to migrate.');
}

async function migrateCategoryOgImages(
  prisma: PrismaClient,
  s3: S3Client | null,
  counts: MigrationCounts,
): Promise<void> {
  console.log('\n=== Phase 5: CategoryTranslation.ogImageUrl ===');

  let page = 0;

  for (;;) {
    const records = await prisma.categoryTranslation.findMany({
      where: {
        ogImageUrl: { not: { startsWith: NEW_CDN_BASE } },
      },
      orderBy: { createdAt: 'asc' },
      skip: page * BATCH_SIZE,
      take: BATCH_SIZE,
      select: { id: true, ogImageUrl: true },
    });
    if (records.length === 0) break;
    page++;

    await migrateField(
      prisma,
      s3,
      counts,
      'CategoryTranslation',
      records.map((r) => ({ id: r.id, url: r.ogImageUrl })),
      (id, newUrl) =>
        prisma.categoryTranslation.update({ where: { id }, data: { ogImageUrl: newUrl } }),
      () => {
        counts.categoryOgImagesMigrated++;
      },
      () => {
        counts.categoryOgImagesSkipped++;
      },
    );
  }

  if (page === 0) console.log('  No Category OG images to migrate.');
}

async function migrateTagOgImages(
  prisma: PrismaClient,
  s3: S3Client | null,
  counts: MigrationCounts,
): Promise<void> {
  console.log('\n=== Phase 6: TagTranslation.ogImageUrl ===');

  let page = 0;

  for (;;) {
    const records = await prisma.tagTranslation.findMany({
      where: {
        ogImageUrl: { not: { startsWith: NEW_CDN_BASE } },
      },
      orderBy: { createdAt: 'asc' },
      skip: page * BATCH_SIZE,
      take: BATCH_SIZE,
      select: { id: true, ogImageUrl: true },
    });
    if (records.length === 0) break;
    page++;

    await migrateField(
      prisma,
      s3,
      counts,
      'TagTranslation',
      records.map((r) => ({ id: r.id, url: r.ogImageUrl })),
      (id, newUrl) => prisma.tagTranslation.update({ where: { id }, data: { ogImageUrl: newUrl } }),
      () => {
        counts.tagOgImagesMigrated++;
      },
      () => {
        counts.tagOgImagesSkipped++;
      },
    );
  }

  if (page === 0) console.log('  No Tag OG images to migrate.');
}

async function main() {
  console.log('==========================================');
  console.log('  Media Migration: Local Storage → R2');
  console.log(`  Dry-run: ${DRY_RUN ? 'YES' : 'NO'}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log('==========================================\n');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const s3 = initS3Client();
  if (s3) {
    console.log('R2 client initialized');
  } else {
    console.log('R2 client not initialized (dry-run or missing env vars)');
  }

  const counts: MigrationCounts = {
    mediaAssetsMigrated: 0,
    mediaAssetsSkipped: 0,
    mediaAssetsFailed: 0,
    bookVersionCoversMigrated: 0,
    bookVersionCoversSkipped: 0,
    seoOgImagesMigrated: 0,
    seoOgImagesSkipped: 0,
    authorPhotosMigrated: 0,
    authorPhotosSkipped: 0,
    categoryOgImagesMigrated: 0,
    categoryOgImagesSkipped: 0,
    tagOgImagesMigrated: 0,
    tagOgImagesSkipped: 0,
  };

  try {
    await migrateMediaAssets(prisma, s3, counts);
    await migrateBookVersionCovers(prisma, s3, counts);
    await migrateSeoOgImages(prisma, s3, counts);
    await migrateAuthorPhotos(prisma, s3, counts);
    await migrateCategoryOgImages(prisma, s3, counts);
    await migrateTagOgImages(prisma, s3, counts);

    console.log('\n==========================================');
    console.log('  Migration Summary');
    console.log('==========================================');
    console.log(
      `  MediaAsset:         ${counts.mediaAssetsMigrated} migrated, ${counts.mediaAssetsSkipped} skipped, ${counts.mediaAssetsFailed} failed`,
    );
    console.log(
      `  BookVersion covers: ${counts.bookVersionCoversMigrated} migrated, ${counts.bookVersionCoversSkipped} skipped`,
    );
    console.log(
      `  Seo OG images:      ${counts.seoOgImagesMigrated} migrated, ${counts.seoOgImagesSkipped} skipped`,
    );
    console.log(
      `  Author photos:      ${counts.authorPhotosMigrated} migrated, ${counts.authorPhotosSkipped} skipped`,
    );
    console.log(
      `  Category OG images: ${counts.categoryOgImagesMigrated} migrated, ${counts.categoryOgImagesSkipped} skipped`,
    );
    console.log(
      `  Tag OG images:      ${counts.tagOgImagesMigrated} migrated, ${counts.tagOgImagesSkipped} skipped`,
    );
    console.log('==========================================');

    if (counts.mediaAssetsFailed > 0) {
      console.log(
        `\n⚠️  ${counts.mediaAssetsFailed} MediaAsset records failed. Check logs above for details.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
