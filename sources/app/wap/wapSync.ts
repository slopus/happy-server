import { db } from "@/storage/db";
import { log, warn, error as logError } from "@/utils/log";
import { wapClient } from "./wapClient";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { buildContainerStatusUpdate } from "@/app/events/containerEvents";
import type { WapContainer } from "./types";

const MODULE = 'wap-sync';

interface WapSyncOptions {
    containerIntervalMs?: number;
    templateIntervalMs?: number;
}

let containerTimer: ReturnType<typeof setInterval> | null = null;
let templateTimer: ReturnType<typeof setInterval> | null = null;

// === Container Sync ===

async function syncContainers(): Promise<void> {
    try {
        // Get all containers from WAP that have forge labels
        const wapContainers = await wapClient.listContainers('forge.container.type');

        // Build a map of WAP container IDs for fast lookup
        const wapMap = new Map<string, WapContainer>();
        for (const wc of wapContainers) {
            if (wc.id) {
                wapMap.set(wc.id, wc);
            }
            // Also index by launch ID label
            const launchId = wc.labels?.['forge.launch.id'];
            if (launchId) {
                wapMap.set(`launch:${launchId}`, wc);
            }
        }

        // Find all active ContainerLaunch records
        const activeLaunches = await db.containerLaunch.findMany({
            where: {
                status: { in: ['running', 'starting', 'creating'] }
            }
        });

        for (const launch of activeLaunches) {
            const wapContainer = launch.wapContainerId
                ? wapMap.get(launch.wapContainerId)
                : wapMap.get(`launch:${launch.id}`);

            if (wapContainer) {
                const wapStatus = wapContainer.status?.toLowerCase();

                if (wapStatus === 'running') {
                    // Container is running in WAP — update lastSeenAt
                    if (launch.status !== 'running') {
                        await db.containerLaunch.update({
                            where: { id: launch.id },
                            data: {
                                status: 'running',
                                lastSeenAt: new Date(),
                                startedAt: launch.startedAt || new Date(),
                            }
                        });
                        await emitStatusUpdate(launch.accountId, launch.id, 'running', null, launch.wapContainerId, launch.machineId);
                    } else {
                        await db.containerLaunch.update({
                            where: { id: launch.id },
                            data: { lastSeenAt: new Date() }
                        });
                    }
                } else if (wapStatus === 'exited' || wapStatus === 'stopped') {
                    // Container stopped
                    await db.containerLaunch.update({
                        where: { id: launch.id },
                        data: {
                            status: 'stopped',
                            stoppedAt: new Date(),
                            lastSeenAt: new Date(),
                        }
                    });
                    await emitStatusUpdate(launch.accountId, launch.id, 'stopped', null, launch.wapContainerId, launch.machineId);
                }
            } else {
                // Container not found in WAP — mark as offline
                await db.containerLaunch.update({
                    where: { id: launch.id },
                    data: { status: 'offline' }
                });
                await emitStatusUpdate(launch.accountId, launch.id, 'offline', 'Container not found in WAP', launch.wapContainerId, launch.machineId);
                warn({ module: MODULE, launchId: launch.id }, 'Container not found in WAP, marked offline');
            }
        }

        log({ module: MODULE }, `Container sync complete. Checked ${activeLaunches.length} active launches against ${wapContainers.length} WAP containers`);
    } catch (err) {
        logError({ module: MODULE }, `Container sync failed: ${err}`);
    }
}

// === Template Sync ===

async function syncTemplates(): Promise<void> {
    try {
        const wapTemplates = await wapClient.listTemplates();
        const seenIds = new Set<string>();

        for (const tmpl of wapTemplates) {
            seenIds.add(tmpl.id);

            // Check if template config includes ai-forge-client indicators
            const isForgeReady = isTemplateForgeReady(tmpl);

            await db.wapTemplateCache.upsert({
                where: { wapTemplateId: tmpl.id },
                create: {
                    wapTemplateId: tmpl.id,
                    name: tmpl.name,
                    description: tmpl.description || null,
                    image: tmpl.image,
                    tag: tmpl.tag || 'latest',
                    config: tmpl.config as any,
                    category: tmpl.category || null,
                    isForgeReady,
                    lastSyncedAt: new Date(),
                },
                update: {
                    name: tmpl.name,
                    description: tmpl.description || null,
                    image: tmpl.image,
                    tag: tmpl.tag || 'latest',
                    config: tmpl.config as any,
                    category: tmpl.category || null,
                    isForgeReady,
                    lastSyncedAt: new Date(),
                }
            });
        }

        // Remove stale entries not seen in latest sync
        if (seenIds.size > 0) {
            await db.wapTemplateCache.deleteMany({
                where: {
                    wapTemplateId: { notIn: Array.from(seenIds) }
                }
            });
        }

        log({ module: MODULE }, `Template sync complete. ${wapTemplates.length} templates synced`);
    } catch (err) {
        logError({ module: MODULE }, `Template sync failed: ${err}`);
    }
}

function isTemplateForgeReady(tmpl: { config?: any; image?: string }): boolean {
    // Check if env vars reference forge-client or if image name suggests forge compatibility
    const envVars = tmpl.config?.env as string[] | undefined;
    if (envVars) {
        for (const env of envVars) {
            if (env.startsWith('FORGE_MACHINE_TOKEN=') || env.startsWith('FORGE_SERVER_URL=')) {
                return true;
            }
        }
    }
    // Check labels
    const labels = tmpl.config?.labels as Record<string, string> | undefined;
    if (labels?.['forge.ready'] === 'true') {
        return true;
    }
    return false;
}

// === Status Event Emission ===

async function emitStatusUpdate(
    accountId: string,
    launchId: string,
    status: string,
    statusMessage: string | null,
    wapContainerId: string | null,
    machineId: string | null,
): Promise<void> {
    try {
        const updSeq = await allocateUserSeq(accountId);
        const payload = buildContainerStatusUpdate(
            launchId, status, statusMessage, wapContainerId, machineId,
            updSeq, randomKeyNaked(12)
        );
        eventRouter.emitUpdate({
            userId: accountId,
            payload,
            recipientFilter: { type: 'user-scoped-only' }
        });
    } catch (err) {
        logError({ module: MODULE }, `Failed to emit status update: ${err}`);
    }
}

// === Startup / Shutdown ===

export function startWapSync(options: WapSyncOptions = {}): void {
    if (!wapClient.isConfigured()) {
        warn({ module: MODULE }, 'WAP not configured (missing WAP_API_URL/WAP_AUTH_USER/WAP_AUTH_PASS). Sync disabled.');
        return;
    }

    const containerInterval = options.containerIntervalMs || 30_000;
    const templateInterval = options.templateIntervalMs || 300_000;

    log({ module: MODULE }, `Starting WAP sync (containers: ${containerInterval}ms, templates: ${templateInterval}ms)`);

    // Run initial sync after a short delay
    setTimeout(() => {
        syncContainers();
        syncTemplates();
    }, 5_000);

    // Set up recurring sync
    containerTimer = setInterval(syncContainers, containerInterval);
    templateTimer = setInterval(syncTemplates, templateInterval);
}

export function stopWapSync(): void {
    if (containerTimer) {
        clearInterval(containerTimer);
        containerTimer = null;
    }
    if (templateTimer) {
        clearInterval(templateTimer);
        templateTimer = null;
    }
    log({ module: MODULE }, 'WAP sync stopped');
}

// Export for manual trigger from API
export { syncContainers, syncTemplates };
