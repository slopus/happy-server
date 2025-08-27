-- AlterEnum
-- Update enum values from SCREAMING_CASE to kebab-case
ALTER TYPE "ConnectivityStatus" RENAME VALUE 'NEVER_CONNECTED' TO 'never_connected';
ALTER TYPE "ConnectivityStatus" RENAME VALUE 'ONLINE' TO 'online';
ALTER TYPE "ConnectivityStatus" RENAME VALUE 'OFFLINE' TO 'offline';