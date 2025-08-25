/*
  Warnings:

  - A unique constraint covering the columns `[userId,commentId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,bookVersionId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."PublicationStatus" AS ENUM ('draft', 'published');

-- AlterTable
ALTER TABLE "public"."BookVersion" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "status" "public"."PublicationStatus" NOT NULL DEFAULT 'published';
