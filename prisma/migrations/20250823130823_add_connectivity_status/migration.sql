-- CreateEnum
CREATE TYPE "public"."ConnectivityStatus" AS ENUM ('NEVER_CONNECTED', 'ONLINE', 'OFFLINE');

-- AlterTable
ALTER TABLE "public"."Machine" ADD COLUMN     "connectivityStatus" "public"."ConnectivityStatus" NOT NULL DEFAULT 'NEVER_CONNECTED',
ADD COLUMN     "connectivityStatusReason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "connectivityStatusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "public"."Session" ADD COLUMN     "connectivityStatus" "public"."ConnectivityStatus" NOT NULL DEFAULT 'NEVER_CONNECTED',
ADD COLUMN     "connectivityStatusReason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "connectivityStatusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
