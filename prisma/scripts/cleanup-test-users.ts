/*
  Bulk cleanup of test users created by e2e.
  - Matches users by email prefix (configurable below)
  - Performs safe cascading cleanup similar to UsersService.deleteById
  - Dry-run by default; set APPLY=1 to actually delete
*/

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Adjust patterns if needed
const EMAIL_PREFIXES = [
  'roles_',
  'roles_forbid_',
  'rl_',
  'rp_',
  'refresh_',
  'user_',
  'o_',
  'nonadmin_',
];

const APPLY = process.env.APPLY === '1' || process.env.APPLY === 'true';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);

function isTestEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return EMAIL_PREFIXES.some((p) => lower.startsWith(p));
}

async function deleteUserCascade(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const comments = await tx.comment.findMany({ where: { userId }, select: { id: true } });
    const commentIds = comments.map((c) => c.id);

    await tx.like.deleteMany({ where: { userId } });
    if (commentIds.length > 0) {
      await tx.like.deleteMany({ where: { commentId: { in: commentIds } } });
      await tx.comment.updateMany({
        where: { parentId: { in: commentIds } },
        data: { parentId: null },
      });
      await tx.comment.deleteMany({ where: { id: { in: commentIds } } });
    }

    await tx.bookshelf.deleteMany({ where: { userId } });
    await tx.readingProgress.deleteMany({ where: { userId } });
    await tx.viewStat.updateMany({ where: { userId }, data: { userId: null } });
    await tx.mediaAsset.updateMany({ where: { createdById: userId }, data: { createdById: null } });
    await tx.userRole.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });
  });
}

async function main() {
  console.log(`[cleanup-test-users] APPLY=${APPLY ? 'yes' : 'no'} BATCH_SIZE=${BATCH_SIZE}`);

  let totalCandidates = 0;
  let deletedCount = 0;

  if (!APPLY) {
    // Dry-run: scan all users in pages and report candidates without deleting
    let page = 0;
    for (;;) {
      const users = await prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        skip: page * BATCH_SIZE,
        take: BATCH_SIZE,
        select: { id: true, email: true },
      });
      if (users.length === 0) break;
      for (const u of users) {
        if (!isTestEmail(u.email)) continue;
        totalCandidates++;
        console.log(`Candidate: ${u.email} (${u.id})`);
      }
      page++;
    }
  } else {
    // Apply: repeatedly fetch only candidates and delete them in batches until none remain
    const where = {
      OR: EMAIL_PREFIXES.map((p) => ({ email: { startsWith: p } })),
    } as const;

    for (;;) {
      const users = await prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: BATCH_SIZE,
        select: { id: true, email: true },
      });
      if (users.length === 0) break;
      totalCandidates += users.length;
      for (const u of users) {
        try {
          await deleteUserCascade(u.id);
          deletedCount++;
          console.log(`Deleted: ${u.email}`);
        } catch (e) {
          console.error(`Failed to delete ${u.email}:`, e);
        }
      }
    }
  }

  console.log(`[cleanup-test-users] candidates=${totalCandidates} deleted=${deletedCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
