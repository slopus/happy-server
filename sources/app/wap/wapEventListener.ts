import { db } from "@/storage/db";
import { log, warn, error as logError } from "@/utils/log";
import { wapClient } from "./wapClient";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { buildContainerStatusUpdate } from "@/app/events/containerEvents";
import type { WapContainerEvent } from "./types";

const MODULE = 'wap-events';

let abortController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Connects to WAP's SSE endpoint for real-time Docker lifecycle events.
 * Complements the sync service with immediate status updates.
 */
async function connectSse(): Promise<void> {
    const sseUrl = wapClient.getSseUrl();
    const authHeader = wapClient.getAuthHeader();

    abortController = new AbortController();

    try {
        log({ module: MODULE }, `Connecting to WAP SSE: ${sseUrl}`);

        const response = await fetch(sseUrl, {
            headers: {
                'Authorization': authHeader,
                'Accept': 'text/event-stream',
            },
            signal: abortController.signal,
        });

        if (!response.ok) {
            throw new Error(`WAP SSE connection failed: ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
            throw new Error('WAP SSE response has no body');
        }

        log({ module: MODULE }, 'Connected to WAP SSE');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                log({ module: MODULE }, 'WAP SSE stream ended');
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE messages
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            let eventData = '';
            for (const line of lines) {
                if (line.startsWith('data:')) {
                    eventData += line.slice(5).trim();
                } else if (line === '' && eventData) {
                    // End of SSE message
                    try {
                        const event = JSON.parse(eventData) as WapContainerEvent;
                        await handleWapEvent(event);
                    } catch (err) {
                        warn({ module: MODULE }, `Failed to parse SSE event: ${err}`);
                    }
                    eventData = '';
                }
            }
        }
    } catch (err: any) {
        if (err.name === 'AbortError') {
            log({ module: MODULE }, 'WAP SSE connection aborted');
            return;
        }
        logError({ module: MODULE }, `WAP SSE error: ${err}`);
    }

    // Reconnect after delay
    scheduleReconnect();
}

async function handleWapEvent(event: WapContainerEvent): Promise<void> {
    // Only process events for forge-managed containers
    const launchId = event.labels?.['forge.launch.id'];
    if (!launchId) {
        return; // Not a forge container
    }

    log({ module: MODULE, launchId, eventType: event.type }, `WAP event: ${event.type}`);

    const launch = await db.containerLaunch.findUnique({
        where: { id: launchId }
    });

    if (!launch) {
        warn({ module: MODULE, launchId }, 'Received WAP event for unknown launch ID');
        return;
    }

    let newStatus: string | null = null;
    let statusMessage: string | null = null;
    const updateData: any = { lastSeenAt: new Date() };

    switch (event.type) {
        case 'start':
            newStatus = 'running';
            updateData.status = 'running';
            updateData.startedAt = launch.startedAt || new Date();
            updateData.wapContainerId = event.containerId || launch.wapContainerId;
            break;

        case 'stop':
            newStatus = 'stopped';
            updateData.status = 'stopped';
            updateData.stoppedAt = new Date();
            break;

        case 'die':
            newStatus = 'error';
            statusMessage = event.exitCode !== undefined ? `Exit code: ${event.exitCode}` : 'Container died';
            updateData.status = 'error';
            updateData.statusMessage = statusMessage;
            updateData.stoppedAt = new Date();
            break;

        case 'destroy':
            newStatus = 'removed';
            updateData.status = 'removed';
            break;

        case 'restart':
            newStatus = 'running';
            updateData.status = 'running';
            updateData.startedAt = new Date();
            break;

        case 'create':
            // Container created but not yet started
            if (launch.status === 'pending') {
                updateData.status = 'creating';
                updateData.wapContainerId = event.containerId || launch.wapContainerId;
                newStatus = 'creating';
            }
            break;

        default:
            return;
    }

    await db.containerLaunch.update({
        where: { id: launchId },
        data: updateData
    });

    if (newStatus) {
        try {
            const updSeq = await allocateUserSeq(launch.accountId);
            const payload = buildContainerStatusUpdate(
                launchId, newStatus, statusMessage, launch.wapContainerId, launch.machineId,
                updSeq, randomKeyNaked(12)
            );
            eventRouter.emitUpdate({
                userId: launch.accountId,
                payload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (err) {
            logError({ module: MODULE }, `Failed to emit status update: ${err}`);
        }
    }
}

function scheduleReconnect(): void {
    if (reconnectTimer) return;
    const delay = 10_000; // 10 seconds
    log({ module: MODULE }, `Reconnecting to WAP SSE in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSse();
    }, delay);
}

// === Startup / Shutdown ===

export function startWapEventListener(): void {
    if (!wapClient.isConfigured()) {
        warn({ module: MODULE }, 'WAP not configured. SSE listener disabled.');
        return;
    }

    log({ module: MODULE }, 'Starting WAP event listener');
    connectSse();
}

export function stopWapEventListener(): void {
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    log({ module: MODULE }, 'WAP event listener stopped');
}
