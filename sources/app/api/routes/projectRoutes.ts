import { eventRouter } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildNewProjectUpdate, buildUpdateProjectUpdate, buildDeleteProjectUpdate, buildMoveProjectUpdate } from "@/app/events/projectEvents";

export function projectRoutes(app: Fastify) {

    // List all projects (flat with path info)
    app.get('/v1/projects', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const projects = await db.project.findMany({
            where: { accountId: userId },
            orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
            select: {
                id: true,
                parentId: true,
                path: true,
                depth: true,
                name: true,
                description: true,
                metadata: true,
                sortOrder: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        return reply.send({
            projects: projects.map((p) => ({
                id: p.id,
                accountId: userId,
                parentId: p.parentId,
                path: p.path,
                depth: p.depth,
                name: p.name,
                description: p.description,
                metadata: p.metadata,
                sortOrder: p.sortOrder,
                createdAt: p.createdAt.getTime(),
                updatedAt: p.updatedAt.getTime(),
            }))
        });
    });

    // Get full project tree structure
    app.get('/v1/projects/tree', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const projects = await db.project.findMany({
            where: { accountId: userId },
            orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
            select: {
                id: true,
                parentId: true,
                path: true,
                depth: true,
                name: true,
                description: true,
                metadata: true,
                sortOrder: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        // Build tree structure
        const projectMap = new Map<string, any>();
        const roots: any[] = [];

        // First pass: create all nodes
        for (const p of projects) {
            projectMap.set(p.id, {
                id: p.id,
                accountId: userId,
                parentId: p.parentId,
                path: p.path,
                depth: p.depth,
                name: p.name,
                description: p.description,
                metadata: p.metadata,
                sortOrder: p.sortOrder,
                createdAt: p.createdAt.getTime(),
                updatedAt: p.updatedAt.getTime(),
                children: [],
            });
        }

        // Second pass: build hierarchy
        for (const p of projects) {
            const node = projectMap.get(p.id);
            if (p.parentId && projectMap.has(p.parentId)) {
                projectMap.get(p.parentId).children.push(node);
            } else if (!p.parentId) {
                roots.push(node);
            }
        }

        return reply.send({ tree: roots });
    });

    // Get single project with children
    app.get('/v1/projects/:id', {
        schema: {
            params: z.object({
                id: z.string()
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const project = await db.project.findFirst({
            where: { id, accountId: userId },
            include: {
                children: {
                    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                    select: {
                        id: true,
                        parentId: true,
                        path: true,
                        depth: true,
                        name: true,
                        description: true,
                        metadata: true,
                        sortOrder: true,
                        createdAt: true,
                        updatedAt: true,
                    }
                },
                rooms: {
                    orderBy: { name: 'asc' },
                    select: {
                        id: true,
                        projectId: true,
                        name: true,
                        description: true,
                        metadata: true,
                        status: true,
                        createdAt: true,
                        updatedAt: true,
                    }
                }
            }
        });

        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        return reply.send({
            project: {
                id: project.id,
                accountId: userId,
                parentId: project.parentId,
                path: project.path,
                depth: project.depth,
                name: project.name,
                description: project.description,
                metadata: project.metadata,
                sortOrder: project.sortOrder,
                createdAt: project.createdAt.getTime(),
                updatedAt: project.updatedAt.getTime(),
                children: project.children.map(c => ({
                    id: c.id,
                    accountId: userId,
                    parentId: c.parentId,
                    path: c.path,
                    depth: c.depth,
                    name: c.name,
                    description: c.description,
                    metadata: c.metadata,
                    sortOrder: c.sortOrder,
                    createdAt: c.createdAt.getTime(),
                    updatedAt: c.updatedAt.getTime(),
                })),
                rooms: project.rooms.map(r => ({
                    id: r.id,
                    accountId: userId,
                    projectId: r.projectId,
                    name: r.name,
                    description: r.description,
                    metadata: r.metadata,
                    status: r.status,
                    createdAt: r.createdAt.getTime(),
                    updatedAt: r.updatedAt.getTime(),
                }))
            }
        });
    });

    // Get project ancestors (for breadcrumbs)
    app.get('/v1/projects/:id/ancestors', {
        schema: {
            params: z.object({
                id: z.string()
            })
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const project = await db.project.findFirst({
            where: { id, accountId: userId },
            select: { path: true }
        });

        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        // Parse path and fetch ancestors
        const ancestorIds = project.path.split('/').filter(Boolean);

        const ancestors = await db.project.findMany({
            where: {
                id: { in: ancestorIds },
                accountId: userId
            },
            select: {
                id: true,
                name: true,
                depth: true,
            },
            orderBy: { depth: 'asc' }
        });

        return reply.send({
            ancestors: ancestors.map(a => ({
                id: a.id,
                name: a.name,
                depth: a.depth,
            }))
        });
    });

    // Create project
    app.post('/v1/projects', {
        schema: {
            body: z.object({
                name: z.string().min(1).max(255),
                description: z.string().max(1000).optional(),
                parentId: z.string().optional(),
                metadata: z.record(z.unknown()).optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { name, description, parentId, metadata } = request.body;

        // If parentId is provided, verify it exists and belongs to user
        let parentPath = '/';
        let depth = 0;

        if (parentId) {
            const parent = await db.project.findFirst({
                where: { id: parentId, accountId: userId },
                select: { path: true, depth: true }
            });

            if (!parent) {
                return reply.code(404).send({ error: 'Parent project not found' });
            }

            parentPath = parent.path;
            depth = parent.depth + 1;
        }

        // Check for duplicate name under same parent
        const existing = await db.project.findFirst({
            where: {
                accountId: userId,
                parentId: parentId || null,
                name: name
            }
        });

        if (existing) {
            return reply.code(409).send({ error: 'A project with this name already exists in this location' });
        }

        // Create project
        const project = await db.project.create({
            data: {
                accountId: userId,
                parentId: parentId || null,
                name,
                description,
                metadata,
                depth,
                path: '/', // Will be updated after creation
            }
        });

        // Update path to include this project's ID
        const newPath = parentPath === '/' ? `/${project.id}/` : `${parentPath}${project.id}/`;
        await db.project.update({
            where: { id: project.id },
            data: { path: newPath }
        });

        const updatedProject = await db.project.findUnique({
            where: { id: project.id }
        });

        log({ module: 'project-create', projectId: project.id, userId }, `Created project: ${project.id}`);

        // Emit new project event
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildNewProjectUpdate({
            id: updatedProject!.id,
            accountId: userId,
            parentId: updatedProject!.parentId,
            path: updatedProject!.path,
            depth: updatedProject!.depth,
            name: updatedProject!.name,
            description: updatedProject!.description,
            metadata: updatedProject!.metadata,
            sortOrder: updatedProject!.sortOrder,
            createdAt: updatedProject!.createdAt,
            updatedAt: updatedProject!.updatedAt,
        }, updSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({
            project: {
                id: updatedProject!.id,
                accountId: userId,
                parentId: updatedProject!.parentId,
                path: updatedProject!.path,
                depth: updatedProject!.depth,
                name: updatedProject!.name,
                description: updatedProject!.description,
                metadata: updatedProject!.metadata,
                sortOrder: updatedProject!.sortOrder,
                createdAt: updatedProject!.createdAt.getTime(),
                updatedAt: updatedProject!.updatedAt.getTime(),
            }
        });
    });

    // Update project
    app.patch('/v1/projects/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                name: z.string().min(1).max(255).optional(),
                description: z.string().max(1000).nullable().optional(),
                metadata: z.record(z.unknown()).optional(),
                sortOrder: z.number().int().optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { name, description, metadata, sortOrder } = request.body;

        // Verify project exists and belongs to user
        const existing = await db.project.findFirst({
            where: { id, accountId: userId }
        });

        if (!existing) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        // Check for duplicate name if name is being changed
        if (name && name !== existing.name) {
            const duplicate = await db.project.findFirst({
                where: {
                    accountId: userId,
                    parentId: existing.parentId,
                    name: name,
                    id: { not: id }
                }
            });

            if (duplicate) {
                return reply.code(409).send({ error: 'A project with this name already exists in this location' });
            }
        }

        const project = await db.project.update({
            where: { id },
            data: {
                name: name ?? undefined,
                description: description !== undefined ? description : undefined,
                metadata: metadata ?? undefined,
                sortOrder: sortOrder ?? undefined,
            }
        });

        log({ module: 'project-update', projectId: id, userId }, `Updated project: ${id}`);

        // Emit update event
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildUpdateProjectUpdate(id, updSeq, randomKeyNaked(12), {
            name: name,
            description: description !== undefined ? description : undefined,
            metadata: metadata,
            sortOrder: sortOrder,
        });

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({
            project: {
                id: project.id,
                accountId: userId,
                parentId: project.parentId,
                path: project.path,
                depth: project.depth,
                name: project.name,
                description: project.description,
                metadata: project.metadata,
                sortOrder: project.sortOrder,
                createdAt: project.createdAt.getTime(),
                updatedAt: project.updatedAt.getTime(),
            }
        });
    });

    // Move project to new parent
    app.patch('/v1/projects/:id/move', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                parentId: z.string().nullable()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { parentId } = request.body;

        // Verify project exists and belongs to user
        const project = await db.project.findFirst({
            where: { id, accountId: userId }
        });

        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        // Cannot move to itself
        if (parentId === id) {
            return reply.code(400).send({ error: 'Cannot move project to itself' });
        }

        // Verify new parent exists and belongs to user (if specified)
        let newParentPath = '/';
        let newDepth = 0;

        if (parentId) {
            const newParent = await db.project.findFirst({
                where: { id: parentId, accountId: userId }
            });

            if (!newParent) {
                return reply.code(404).send({ error: 'Target parent project not found' });
            }

            // Prevent moving to a descendant
            if (newParent.path.includes(`/${id}/`)) {
                return reply.code(400).send({ error: 'Cannot move project to one of its descendants' });
            }

            newParentPath = newParent.path;
            newDepth = newParent.depth + 1;
        }

        // Check for duplicate name in new location
        const duplicate = await db.project.findFirst({
            where: {
                accountId: userId,
                parentId: parentId,
                name: project.name,
                id: { not: id }
            }
        });

        if (duplicate) {
            return reply.code(409).send({ error: 'A project with this name already exists in the target location' });
        }

        const oldPath = project.path;
        const newPath = newParentPath === '/' ? `/${id}/` : `${newParentPath}${id}/`;
        const depthDiff = newDepth - project.depth;

        // Update this project
        await db.project.update({
            where: { id },
            data: {
                parentId,
                path: newPath,
                depth: newDepth,
            }
        });

        // Update all descendants - update their paths and depths
        const descendants = await db.project.findMany({
            where: {
                accountId: userId,
                path: { startsWith: oldPath },
                id: { not: id }
            }
        });

        for (const desc of descendants) {
            const updatedDescPath = desc.path.replace(oldPath, newPath);
            await db.project.update({
                where: { id: desc.id },
                data: {
                    path: updatedDescPath,
                    depth: desc.depth + depthDiff,
                }
            });
        }

        const updatedProject = await db.project.findUnique({
            where: { id }
        });

        log({ module: 'project-move', projectId: id, userId, from: oldPath, to: newPath }, `Moved project: ${id}`);

        // Emit move event
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildMoveProjectUpdate(id, parentId, updSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({
            project: {
                id: updatedProject!.id,
                accountId: userId,
                parentId: updatedProject!.parentId,
                path: updatedProject!.path,
                depth: updatedProject!.depth,
                name: updatedProject!.name,
                description: updatedProject!.description,
                metadata: updatedProject!.metadata,
                sortOrder: updatedProject!.sortOrder,
                createdAt: updatedProject!.createdAt.getTime(),
                updatedAt: updatedProject!.updatedAt.getTime(),
            }
        });
    });

    // Delete project (cascades to children and rooms)
    app.delete('/v1/projects/:id', {
        schema: {
            params: z.object({
                id: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        // Verify project exists and belongs to user
        const project = await db.project.findFirst({
            where: { id, accountId: userId }
        });

        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }

        // Delete project (cascade will handle children and rooms)
        await db.project.delete({
            where: { id }
        });

        log({ module: 'project-delete', projectId: id, userId }, `Deleted project: ${id}`);

        // Emit delete event
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildDeleteProjectUpdate(id, updSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ success: true });
    });
}
