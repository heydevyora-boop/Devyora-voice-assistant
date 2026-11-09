-- DropIndex
DROP INDEX "notifications_dedupeKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_dedupeKey_key" ON "notifications"("userId", "dedupeKey");

