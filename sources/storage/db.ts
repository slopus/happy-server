import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
});