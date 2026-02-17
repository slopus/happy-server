import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import Session from "supertokens-node/recipe/session";
import { db } from "@/storage/db";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            // First, try SuperTokens session authentication
            try {
                const session = await Session.getSession(request, reply, {
                    sessionRequired: false,
                });

                if (session) {
                    const supertokensUserId = session.getUserId();
                    const accessTokenPayload = session.getAccessTokenPayload();

                    // Try to get accountId from payload first (faster)
                    let accountId = accessTokenPayload.accountId;

                    if (!accountId) {
                        // Fall back to database lookup
                        const account = await db.account.findFirst({
                            where: { supertokensUserId }
                        });
                        accountId = account?.id;
                    }

                    if (accountId) {
                        log({ module: 'auth-decorator' }, `SuperTokens auth success - user: ${accountId}`);
                        request.userId = accountId;
                        request.supertokensSession = session;
                        return;
                    }
                }
            } catch (stErr) {
                // SuperTokens session not found or error, fall through to legacy auth
                log({ module: 'auth-decorator' }, `SuperTokens check failed, trying legacy auth: ${stErr}`);
            }

            // Fall back to legacy Bearer token authentication
            const authHeader = request.headers.authorization;
            log({ module: 'auth-decorator' }, `Auth check - path: ${request.url}, has header: ${!!authHeader}, header start: ${authHeader?.substring(0, 50)}...`);
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return reply.code(401).send({ error: 'Invalid token' });
            }

            log({ module: 'auth-decorator' }, `Legacy auth success - user: ${verified.userId}`);
            request.userId = verified.userId;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}