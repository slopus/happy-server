import type { UpdatePayload, EphemeralPayload } from "./eventRouter";

// === CONTAINER EVENT BUILDERS ===

export function buildNewContainerLaunchUpdate(launch: {
    id: string;
    name: string;
    image: string;
    status: string;
    containerType: string;
    agentType: string | null;
    projectRole: string | null;
    agentVersion: string | null;
    projectId: string | null;
    wapContainerId: string | null;
    machineId: string | null;
    createdAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-container-launch',
            launchId: launch.id,
            name: launch.name,
            image: launch.image,
            status: launch.status,
            containerType: launch.containerType,
            agentType: launch.agentType,
            projectRole: launch.projectRole,
            agentVersion: launch.agentVersion,
            projectId: launch.projectId,
            wapContainerId: launch.wapContainerId,
            machineId: launch.machineId,
            createdAt: launch.createdAt.getTime(),
        },
        createdAt: Date.now()
    };
}

export function buildContainerStatusUpdate(
    launchId: string,
    status: string,
    statusMessage: string | null,
    wapContainerId: string | null,
    machineId: string | null,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'container-status',
            launchId,
            status,
            statusMessage,
            wapContainerId,
            machineId,
            lastSeenAt: Date.now(),
        },
        createdAt: Date.now()
    };
}

export function buildDeleteContainerLaunchUpdate(
    launchId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-container-launch',
            launchId,
        },
        createdAt: Date.now()
    };
}

export function buildContainerRoomAssignedUpdate(
    launchId: string,
    roomId: string,
    role: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'container-room-assigned',
            launchId,
            roomId,
            role,
        },
        createdAt: Date.now()
    };
}

export function buildContainerRoomRemovedUpdate(
    launchId: string,
    roomId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'container-room-removed',
            launchId,
            roomId,
        },
        createdAt: Date.now()
    };
}

// === EPHEMERAL EVENTS ===

export function buildContainerActivityEphemeral(
    launchId: string,
    machineId: string | null,
    active: boolean
): EphemeralPayload {
    return {
        type: 'container-activity',
        launchId,
        machineId,
        active,
        timestamp: Date.now(),
    };
}
