-- CreateEnum
CREATE TYPE "NoteSource" AS ENUM ('VOICE', 'MANUAL', 'IMPORT');

-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('SCHEDULED', 'DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationStatus" ADD VALUE 'SENDING';
ALTER TYPE "NotificationStatus" ADD VALUE 'UNDELIVERABLE';

-- AlterEnum
ALTER TYPE "ReminderStatus" ADD VALUE 'SNOOZED';

-- AlterTable
-- Hand-edited: Prisma generates DROP "text" + ADD "content", which would
-- discard every existing note. A rename keeps the data, and is what the
-- change actually is.
ALTER TABLE "notes" RENAME COLUMN "text" TO "content";

ALTER TABLE "notes"
ADD COLUMN     "language" VARCHAR(24),
ADD COLUMN     "source" "NoteSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "title" VARCHAR(200),
ADD COLUMN     "updatedByDeviceId" UUID;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dedupeKey" VARCHAR(200),
ADD COLUMN     "failureCode" VARCHAR(40),
ADD COLUMN     "providerId" VARCHAR(40),
ADD COLUMN     "providerRef" VARCHAR(200);

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "snoozeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "snoozedUntil" TIMESTAMP(3),
ADD COLUMN     "updatedByDeviceId" UUID;

-- CreateTable
CREATE TABLE "reminder_occurrences" (
    "id" UUID NOT NULL,
    "reminderId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "firedAt" TIMESTAMP(3),
    "notificationId" UUID,
    "failureCode" VARCHAR(40),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "notesCursor" TIMESTAMP(3),
    "remindersCursor" TIMESTAMP(3),
    "lastPulledAt" TIMESTAMP(3),
    "lastPushedAt" TIMESTAMP(3),
    "pushedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("userId","deviceId")
);

-- CreateIndex
CREATE INDEX "reminder_occurrences_userId_scheduledFor_idx" ON "reminder_occurrences"("userId", "scheduledFor" DESC);

-- CreateIndex
CREATE INDEX "reminder_occurrences_status_scheduledFor_idx" ON "reminder_occurrences"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_occurrences_reminderId_scheduledFor_key" ON "reminder_occurrences"("reminderId", "scheduledFor");

-- CreateIndex
CREATE INDEX "sync_cursors_userId_idx" ON "sync_cursors"("userId");

-- CreateIndex
CREATE INDEX "notes_userId_updatedAt_idx" ON "notes"("userId", "updatedAt" ASC);

-- CreateIndex
CREATE INDEX "notes_userId_pinned_deletedAt_idx" ON "notes"("userId", "pinned", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "reminders_userId_updatedAt_idx" ON "reminders"("userId", "updatedAt" ASC);

-- AddForeignKey
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

