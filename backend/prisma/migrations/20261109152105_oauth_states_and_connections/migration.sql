-- AlterTable
ALTER TABLE "connected_accounts" ADD COLUMN     "lastErrorCode" VARCHAR(40),
ADD COLUMN     "lastRefreshAt" TIMESTAMP(3),
ADD COLUMN     "refreshFailures" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL,
    "state" VARCHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "provider" "ConnectionProvider" NOT NULL,
    "codeVerifierEnc" BYTEA,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "redirectUri" VARCHAR(500) NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ipAddress" INET,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX "oauth_states_userId_createdAt_idx" ON "oauth_states"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "oauth_states_expiresAt_idx" ON "oauth_states"("expiresAt");

-- CreateIndex
CREATE INDEX "connected_accounts_status_expiresAt_idx" ON "connected_accounts"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

