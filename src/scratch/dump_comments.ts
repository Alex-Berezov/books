import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  await prisma.$connect();

  const comments = await prisma.comment.findMany({
    include: {
      user: true,
      parent: {
        include: {
          user: true,
        },
      },
    },
  });

  console.log('=== COMMENTS DUMP ===');
  for (const c of comments) {
    console.log({
      id: c.id,
      text: c.text,
      userId: c.userId,
      userNickname: c.user?.nickname,
      userName: c.user?.name,
      isDeleted: c.isDeleted,
      parentId: c.parentId,
      parentText: c.parent?.text,
      parentUser: c.parent?.user?.nickname || c.parent?.user?.name,
    });
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
