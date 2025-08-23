import { startApi } from "@/app/api";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/timeout";
import { redis } from "./services/redis";
import { startMetricsServer } from "@/app/metrics";
import { activityCache } from "@/modules/sessionCache";
import { auth } from "./modules/auth";
import { startDatabaseMetricsUpdater } from "@/modules/metrics";

async function main() {

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    });
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });
    await redis.ping();

    // Initialize auth module
    await auth.init();

    //
    // Start
    //

    await startApi();
    await startMetricsServer();
    startDatabaseMetricsUpdater();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
}).then(() => {
    process.exit(0);
});