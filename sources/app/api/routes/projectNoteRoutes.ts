import { eventRouter } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import type { UpdatePayload } from "@/app/events/eventRouter";

// === EVENT BUILDERS ===

function buildNewProjectNoteUpdate(note: {
    id: string;
    projectId: string;
    sourceAgentType: string;
    targetAgentType: string;
    title: string;
    status: string;
    createdAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-project-note',
            noteId: note.id,
            projectId: note.projectId,
            sourceAgentType: note.sourceAgentType,
            targetAgentType: note.targetAgentType,
            title: note.title,
            status: note.status,
            createdAt: note.createdAt.getTime(),
        },
        createdAt: Date.now()
    };
}

// === ROUTES ===

export function projectNoteRoutes(app: Fastify) {

    // List notes for a project (filterable)
    app.get('/v1/projects/:projectId/notes', {
        schema: {
            params: z.object({ projectId: z.string() }),
            querystring: z.object({
                targetAgentType: z.string().optional(),
                status: z.string().optional(),
            }).optional()
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;
        const query = request.query as { targetAgentType?: string; status?: string } | undefined;

        // Verify project belongs to user
        const project = await db.project.findFirst({
            where: { id: projectId, accountId: userId }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        const where: any = { projectId };
        if (query?.targetAgentType) {
            where.targetAgentType = query.targetAgentType;
        }
        if (query?.status) {
            where.status = query.status;
        }

        const notes = await db.projectNote.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });

        return reply.send({
            notes: notes.map(n => ({
                id: n.id,
                projectId: n.projectId,
                accountId: n.accountId,
                sourceAgentType: n.sourceAgentType,
                targetAgentType: n.targetAgentType,
                title: n.title,
                content: n.content,
                status: n.status,
                metadata: n.metadata,
                createdAt: n.createdAt.getTime(),
                updatedAt: n.updatedAt.getTime(),
            }))
        });
    });

    // Create a project note
    app.post('/v1/projects/:projectId/notes', {
        schema: {
            params: z.object({ projectId: z.string() }),
            body: z.object({
                targetAgentType: z.string().min(1),
                title: z.string().min(1),
                content: z.string().min(1),
                metadata: z.record(z.unknown()).optional(),
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;
        const { targetAgentType, title, content, metadata } = request.body;

        // Verify project belongs to user
        const project = await db.project.findFirst({
            where: { id: projectId, accountId: userId }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        // Determine sourceAgentType: from container's agentType (machine auth) or "user"
        let sourceAgentType = 'user';
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer mkt_')) {
            const machineToken = await db.machineToken.findFirst({
                where: { accountId: userId },
                include: {
                    ContainerLaunch: {
                        where: { accountId: userId, projectId },
                        select: { agentType: true },
                        take: 1,
                    }
                }
            });
            if (machineToken?.ContainerLaunch[0]?.agentType) {
                sourceAgentType = machineToken.ContainerLaunch[0].agentType;
            }
        }

        const note = await db.projectNote.create({
            data: {
                projectId,
                accountId: userId,
                sourceAgentType,
                targetAgentType,
                title,
                content,
                metadata: metadata || undefined,
            }
        });

        log({ module: 'project-note', projectId, userId }, `New note: ${note.id} (${sourceAgentType} → ${targetAgentType})`);

        // Emit event
        const updSeq = await allocateUserSeq(userId);
        const payload = buildNewProjectNoteUpdate(note, updSeq, randomKeyNaked(12));
        eventRouter.emitUpdate({
            userId,
            payload,
            recipientFilter: { type: 'all-user-authenticated-connections' }
        });

        return reply.send({
            note: {
                id: note.id,
                projectId: note.projectId,
                accountId: note.accountId,
                sourceAgentType: note.sourceAgentType,
                targetAgentType: note.targetAgentType,
                title: note.title,
                content: note.content,
                status: note.status,
                metadata: note.metadata,
                createdAt: note.createdAt.getTime(),
                updatedAt: note.updatedAt.getTime(),
            }
        });
    });

    // Update note status
    app.patch('/v1/notes/:id', {
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                status: z.enum(['pending', 'acknowledged', 'completed']).optional(),
                content: z.string().optional(),
                title: z.string().optional(),
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { status, content, title } = request.body;

        const existing = await db.projectNote.findFirst({
            where: { id, project: { accountId: userId } }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Note not found' });
        }

        const updated = await db.projectNote.update({
            where: { id },
            data: {
                status: status ?? undefined,
                content: content ?? undefined,
                title: title ?? undefined,
            }
        });

        log({ module: 'project-note', noteId: id, userId }, `Note updated`);

        return reply.send({
            note: {
                id: updated.id,
                projectId: updated.projectId,
                accountId: updated.accountId,
                sourceAgentType: updated.sourceAgentType,
                targetAgentType: updated.targetAgentType,
                title: updated.title,
                content: updated.content,
                status: updated.status,
                metadata: updated.metadata,
                createdAt: updated.createdAt.getTime(),
                updatedAt: updated.updatedAt.getTime(),
            }
        });
    });

    // Delete note
    app.delete('/v1/notes/:id', {
        schema: {
            params: z.object({ id: z.string() })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const existing = await db.projectNote.findFirst({
            where: { id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Note not found' });
        }

        await db.projectNote.delete({ where: { id } });

        log({ module: 'project-note', noteId: id, userId }, `Note deleted`);

        return reply.send({ success: true });
    });
}
