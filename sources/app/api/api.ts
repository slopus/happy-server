import fastify from "fastify";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { projectRoutes } from "./routes/projectRoutes";
import { roomRoutes } from "./routes/roomRoutes";
import { machineTokenRoutes } from "./routes/machineTokenRoutes";
import { containerRoutes } from "./routes/containerRoutes";
import { roomMessageRoutes } from "./routes/roomMessageRoutes";
import { projectNoteRoutes } from "./routes/projectNoteRoutes";
import { initSuperTokens } from "@/app/auth/supertokens";
import supertokens from "supertokens-node";
import { plugin as supertokensPlugin, errorHandler as supertokensErrorHandler } from "supertokens-node/framework/fastify";

export async function startApi() {

    // Configure
    log('Starting API...');

    // Initialize SuperTokens
    initSuperTokens();

    // Start API
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
    });

    // CORS configuration with SuperTokens headers
    app.register(import('@fastify/cors'), {
        origin: [
            process.env.WEBSITE_DOMAIN || 'http://15.204.94.200:5175',
            'http://localhost:5175',
            'http://localhost:5173',
        ],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            ...supertokens.getAllCORSHeaders(),
        ],
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
        credentials: true,
    });

    // Register SuperTokens plugin (handles /auth/* routes)
    await app.register(supertokensPlugin);

    // SuperTokens error handler
    app.setErrorHandler(supertokensErrorHandler());

    app.get('/', function (request, reply) {
        reply.send('Welcome to Happy Server!');
    });

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed);
    enableAuthentication(typed);

    // Routes
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    kvRoutes(typed);
    projectRoutes(typed);
    roomRoutes(typed);
    machineTokenRoutes(typed);
    containerRoutes(typed);
    roomMessageRoutes(typed);
    projectNoteRoutes(typed);

    // Start HTTP
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: '0.0.0.0' });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed);

    // End
    log('API ready on port http://localhost:' + port);
}