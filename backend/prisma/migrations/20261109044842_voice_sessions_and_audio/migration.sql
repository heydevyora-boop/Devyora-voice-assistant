-- CreateEnum
CREATE TYPE "VoiceInputMode" AS ENUM ('TEXT', 'UPLOAD', 'STREAM');

-- CreateEnum
CREATE TYPE "VoiceSessionState" AS ENUM ('CREATED', 'LISTENING', 'TRANSCRIBING', 'INTERPRETING', 'AWAITING_CLARIFICATION', 'AWAITING_CONFIRMATION', 'QUEUED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "AudioKind" AS ENUM ('INPUT', 'SPEECH');

-- CreateEnum
CREATE TYPE "AudioRetention" AS ENUM ('DISCARD', 'SESSION', 'RETAIN');

-- CreateTable
CREATE TABLE "voice_sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "state" "VoiceSessionState" NOT NULL DEFAULT 'CREATED',
    "inputMode" "VoiceInputMode" NOT NULL,
    "wakeWordTriggered" BOOLEAN NOT NULL DEFAULT false,
    "languageHint" VARCHAR(24),
    "transcript" TEXT,
    "detectedLanguage" VARCHAR(24),
    "sttProviderId" VARCHAR(40),
    "sttConfidence" DOUBLE PRECISION,
    "sttLatencyMs" INTEGER,
    "conversationId" UUID,
    "commandId" UUID,
    "pendingActionId" UUID,
    "replyText" TEXT,
    "failureCode" VARCHAR(40),
    "lastEventSeq" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_session_events" (
    "id" UUID NOT NULL,
    "voiceSessionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_session_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_assets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "voiceSessionId" UUID,
    "kind" "AudioKind" NOT NULL DEFAULT 'INPUT',
    "mimeType" VARCHAR(80) NOT NULL,
    "storageKey" VARCHAR(128),
    "byteSize" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "sampleRate" INTEGER,
    "checksum" VARCHAR(64) NOT NULL,
    "retention" "AudioRetention" NOT NULL DEFAULT 'DISCARD',
    "deleteAfter" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audio_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_sessions_userId_createdAt_idx" ON "voice_sessions"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "voice_sessions_deviceId_state_idx" ON "voice_sessions"("deviceId", "state");

-- CreateIndex
CREATE INDEX "voice_sessions_expiresAt_idx" ON "voice_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "voice_session_events_voiceSessionId_seq_idx" ON "voice_session_events"("voiceSessionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "voice_session_events_voiceSessionId_seq_key" ON "voice_session_events"("voiceSessionId", "seq");

-- CreateIndex
CREATE INDEX "audio_assets_userId_createdAt_idx" ON "audio_assets"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audio_assets_deletedAt_idx" ON "audio_assets"("deletedAt");

-- CreateIndex
CREATE INDEX "audio_assets_deleteAfter_idx" ON "audio_assets"("deleteAfter");

-- AddForeignKey
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_session_events" ADD CONSTRAINT "voice_session_events_voiceSessionId_fkey" FOREIGN KEY ("voiceSessionId") REFERENCES "voice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_voiceSessionId_fkey" FOREIGN KEY ("voiceSessionId") REFERENCES "voice_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

