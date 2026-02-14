-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "voiceConversationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voiceConversationFreeLimitOverride" INTEGER;
