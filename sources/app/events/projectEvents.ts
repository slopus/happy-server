import { UpdatePayload } from "./eventRouter";

// === PROJECT EVENT TYPES ===

export interface ProjectData {
    id: string;
    accountId: string;
    parentId: string | null;
    path: string;
    depth: number;
    name: string;
    description: string | null;
    metadata: unknown;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface RoomData {
    id: string;
    accountId: string;
    projectId: string;
    name: string;
    description: string | null;
    metadata: unknown;
    status: string;
    createdAt: Date;
    updatedAt: Date;
}

// === PROJECT EVENT BUILDERS ===

export function buildNewProjectUpdate(project: ProjectData, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-project',
            id: project.id,
            accountId: project.accountId,
            parentId: project.parentId,
            path: project.path,
            depth: project.depth,
            name: project.name,
            description: project.description,
            metadata: project.metadata,
            sortOrder: project.sortOrder,
            createdAt: project.createdAt.getTime(),
            updatedAt: project.updatedAt.getTime(),
        },
        createdAt: Date.now()
    };
}

export function buildUpdateProjectUpdate(
    projectId: string,
    updateSeq: number,
    updateId: string,
    updates: {
        name?: string;
        description?: string | null;
        metadata?: unknown;
        sortOrder?: number;
    }
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-project',
            id: projectId,
            ...updates,
        },
        createdAt: Date.now()
    };
}

export function buildMoveProjectUpdate(
    projectId: string,
    newParentId: string | null,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'move-project',
            id: projectId,
            parentId: newParentId,
        },
        createdAt: Date.now()
    };
}

export function buildDeleteProjectUpdate(
    projectId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-project',
            projectId,
        },
        createdAt: Date.now()
    };
}

// === ROOM EVENT BUILDERS ===

export function buildNewRoomUpdate(room: RoomData, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-room',
            id: room.id,
            accountId: room.accountId,
            projectId: room.projectId,
            name: room.name,
            description: room.description,
            metadata: room.metadata,
            status: room.status,
            createdAt: room.createdAt.getTime(),
            updatedAt: room.updatedAt.getTime(),
        },
        createdAt: Date.now()
    };
}

export function buildUpdateRoomUpdate(
    roomId: string,
    projectId: string,
    updateSeq: number,
    updateId: string,
    updates: {
        name?: string;
        description?: string | null;
        metadata?: unknown;
        status?: string;
    }
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-room',
            id: roomId,
            projectId,
            ...updates,
        },
        createdAt: Date.now()
    };
}

export function buildDeleteRoomUpdate(
    roomId: string,
    projectId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-room',
            roomId,
            projectId,
        },
        createdAt: Date.now()
    };
}
