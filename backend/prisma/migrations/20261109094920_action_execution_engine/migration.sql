-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExecutionStatus" ADD VALUE 'RUNNING';
ALTER TYPE "ExecutionStatus" ADD VALUE 'PARTIAL';
ALTER TYPE "ExecutionStatus" ADD VALUE 'UNVERIFIED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PendingActionStatus" ADD VALUE 'EXECUTING';
ALTER TYPE "PendingActionStatus" ADD VALUE 'EXECUTED';
ALTER TYPE "PendingActionStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "action_executions" ADD COLUMN     "actionId" VARCHAR(80) NOT NULL,
ADD COLUMN     "deviceId" UUID,
ADD COLUMN     "failureCode" VARCHAR(40),
ADD COLUMN     "idempotencyKey" VARCHAR(200) NOT NULL,
ADD COLUMN     "paramsDigest" VARCHAR(64) NOT NULL,
ADD COLUMN     "resultRef" VARCHAR(200),
ADD COLUMN     "sessionId" UUID,
ADD COLUMN     "userId" UUID NOT NULL,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "pending_actions" ADD COLUMN     "actionId" VARCHAR(80) NOT NULL,
ADD COLUMN     "deviceId" UUID NOT NULL,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "params" JSONB NOT NULL,
ADD COLUMN     "sessionId" UUID,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "voiceSessionId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "action_executions_idempotencyKey_key" ON "action_executions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "action_executions_userId_startedAt_idx" ON "action_executions"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "action_executions_actionId_status_idx" ON "action_executions"("actionId", "status");

-- CreateIndex
CREATE INDEX "pending_actions_deviceId_status_idx" ON "pending_actions"("deviceId", "status");

-- AddForeignKey
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

