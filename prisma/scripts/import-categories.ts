import 'dotenv/config';
import { PrismaClient, Language, CategoryType } from '@prisma/client';
import * as path from 'path';
import * as xlsx from 'xlsx';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Initialize Prisma with PG Adapter (matching the main seed file style)
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const EXCEL_FILE_PATH =
  process.env.EXCEL_PATH ||
  path.resolve(__dirname, '../../../books-front/book_full_categories_en_es_fr_pt.xlsx');
const DRY_RUN = process.env.DRY_RUN === 'true';

interface ExcelCategoryMeta {
  slug: string;
  parentSlug?: string;
  level: number;
  categoryKind: string;
  sortOrder?: number;
  isActive?: boolean;
}

interface ExcelTranslation {
  slug: string;
  languageCode: string;
  name: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
}

// Map excel categoryKind to database CategoryType enum
function mapCategoryType(kind: string): CategoryType {
  switch (kind) {
    case 'CONTENT_CATEGORY':
      return CategoryType.genre;
    case 'FORMAT_CATEGORY':
    case 'SEO_CATEGORY':
    case 'COMMERCIAL_CATEGORY':
    default:
      return CategoryType.etc;
  }
}

async function main() {
  console.log(`🚀 Starting Category Import from: ${EXCEL_FILE_PATH}`);
  console.log(
    `Dry-run mode: ${DRY_RUN ? '✅ ENABLED (database will NOT be modified)' : '❌ DISABLED (database WILL be updated)'}`,
  );

  // 1. Read Excel workbook
  let workbook: xlsx.WorkBook;
  try {
    workbook = xlsx.readFile(EXCEL_FILE_PATH);
  } catch (err) {
    console.error(`❌ Failed to read Excel file at ${EXCEL_FILE_PATH}:`, err);
    process.exit(1);
  }

  // 2. Parse Sheets
  const hierarchySheet = workbook.Sheets['Hierarchy'];
  const translationsSheet = workbook.Sheets['Translations'];

  if (!hierarchySheet || !translationsSheet) {
    console.error('❌ Excel file must contain "Hierarchy" and "Translations" sheets.');
    process.exit(1);
  }

  const rawHierarchy = xlsx.utils.sheet_to_json<any>(hierarchySheet);
  const rawTranslations = xlsx.utils.sheet_to_json<any>(translationsSheet);

  console.log(`📊 Found ${rawHierarchy.length} categories in Hierarchy sheet.`);
  console.log(`📊 Found ${rawTranslations.length} translations in Translations sheet.`);

  // 3. Process categories metadata
  const categories: ExcelCategoryMeta[] = rawHierarchy.map((row) => ({
    slug: String(row.slug).trim(),
    parentSlug: row.parentSlug ? String(row.parentSlug).trim() : undefined,
    level: Number(row.level),
    categoryKind: String(row.categoryKind).trim(),
    sortOrder: row.sortOrder ? Number(row.sortOrder) : undefined,
    isActive: row.isActive === undefined ? true : Boolean(row.isActive),
  }));

  // Group translations by slug
  const translationsBySlug: Record<string, ExcelTranslation[]> = {};
  rawTranslations.forEach((row) => {
    const slug = String(row.slug).trim();
    const trans: ExcelTranslation = {
      slug,
      languageCode: String(row.languageCode).trim().toLowerCase(),
      name: String(row.name).trim(),
      description: row.description ? String(row.description).trim() : undefined,
      seoTitle: row.seoTitle ? String(row.seoTitle).trim() : undefined,
      seoDescription: row.seoDescription ? String(row.seoDescription).trim() : undefined,
    };
    if (!translationsBySlug[slug]) {
      translationsBySlug[slug] = [];
    }
    translationsBySlug[slug].push(trans);
  });

  // Sort categories by level (Level 1 first, Level 2 next, etc.)
  categories.sort((a, b) => a.level - b.level);

  // Map to store created category slug -> DB ID
  const categorySlugToIdMap: Record<string, string> = {};

  // Track summary
  let createdCount = 0;
  let updatedCount = 0;
  let translationCount = 0;
  let seoCount = 0;

  try {
    await prisma.$transaction(
      async (tx) => {
        for (const catMeta of categories) {
          const type = mapCategoryType(catMeta.categoryKind);

          // Find default English name from translations for Category.name
          const catTranslations = translationsBySlug[catMeta.slug] || [];
          const enTrans = catTranslations.find((t) => t.languageCode === 'en');
          const defaultName = enTrans ? enTrans.name : catMeta.slug;

          // Resolve Parent ID if subcategory
          let parentId: string | null = null;
          if (catMeta.parentSlug) {
            parentId = categorySlugToIdMap[catMeta.parentSlug] || null;
            if (!parentId) {
              // Check in the database just in case parent was created outside this script
              const dbParent = await tx.category.findFirst({
                where: { slug: catMeta.parentSlug },
                select: { id: true },
              });
              if (dbParent) {
                parentId = dbParent.id;
              } else {
                console.warn(
                  `⚠️ Parent category with slug '${catMeta.parentSlug}' not found for child '${catMeta.slug}'. Creating without parent.`,
                );
              }
            }
          }

          // Upsert Category
          let category = await tx.category.findFirst({
            where: { slug: catMeta.slug },
          });

          if (category) {
            category = await tx.category.update({
              where: { id: category.id },
              data: {
                type,
                name: defaultName,
                parentId,
              },
            });
            updatedCount++;
          } else {
            category = await tx.category.create({
              data: {
                slug: catMeta.slug,
                type,
                name: defaultName,
                parentId,
              },
            });
            createdCount++;
          }

          categorySlugToIdMap[catMeta.slug] = category.id;

          // Upsert Category Translations (4 languages: en, es, fr, pt)
          for (const trans of catTranslations) {
            const lang = trans.languageCode as Language;
            if (!Object.values(Language).includes(lang)) {
              console.warn(
                `⚠️ Skipped translation with unsupported language code: ${trans.languageCode}`,
              );
              continue;
            }

            // Handle SEO
            let seoId: number | null = null;
            const hasSeoData = trans.seoTitle || trans.seoDescription;

            // Check if translation already exists
            const existingTrans = await tx.categoryTranslation.findUnique({
              where: {
                categoryId_language: {
                  categoryId: category.id,
                  language: lang,
                },
              },
              include: { seo: true },
            });

            if (hasSeoData) {
              const seoData = {
                metaTitle: trans.seoTitle || null,
                metaDescription: trans.seoDescription || null,
                canonicalUrl: `https://bibliaris.com/${lang}/categories/${trans.slug}`,
                robots: 'index, follow',
                ogTitle: trans.seoTitle || null,
                ogDescription: trans.seoDescription || null,
                ogType: 'website',
                ogUrl: `https://bibliaris.com/${lang}/categories/${trans.slug}`,
              };

              if (existingTrans?.seoId) {
                await tx.seo.update({
                  where: { id: existingTrans.seoId },
                  data: seoData,
                });
                seoId = existingTrans.seoId;
              } else {
                const newSeo = await tx.seo.create({
                  data: seoData,
                });
                seoId = newSeo.id;
                seoCount++;
              }
            } else if (existingTrans?.seoId) {
              // Delete SEO if it existed but is no longer present in Excel
              const oldSeoId = existingTrans.seoId;
              await tx.categoryTranslation.update({
                where: { id: existingTrans.id },
                data: { seoId: null },
              });
              await tx.seo.delete({ where: { id: oldSeoId } });
            }

            // Upsert Translation
            if (existingTrans) {
              await tx.categoryTranslation.update({
                where: { id: existingTrans.id },
                data: {
                  name: trans.name,
                  slug: trans.slug,
                  description: trans.description || null,
                  seoId,
                },
              });
            } else {
              await tx.categoryTranslation.create({
                data: {
                  categoryId: category.id,
                  language: lang,
                  name: trans.name,
                  slug: trans.slug,
                  description: trans.description || null,
                  seoId,
                },
              });
            }
            translationCount++;
          }
        }

        if (DRY_RUN) {
          throw new Error('DRY_RUN_ROLLBACK');
        }
      },
      { maxWait: 20000, timeout: 120000 },
    );

    console.log('\n✨ Database operation completed successfully!');
    console.log(`📁 Categories created: ${createdCount}`);
    console.log(`📁 Categories updated: ${updatedCount}`);
    console.log(`🌍 Translations created/updated: ${translationCount}`);
    console.log(`🔍 SEO records created: ${seoCount}`);
  } catch (err: any) {
    if (err.message === 'DRY_RUN_ROLLBACK') {
      console.log('\n🛡️ Dry-run rollback successful! No changes were saved to the database.');
      console.log(`📁 Categories that would be created: ${createdCount}`);
      console.log(`📁 Categories that would be updated: ${updatedCount}`);
      console.log(`🌍 Translations that would be created/updated: ${translationCount}`);
      console.log(`🔍 SEO records that would be created: ${seoCount}`);
    } else {
      console.error('\n❌ Import failed with error:', err);
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
