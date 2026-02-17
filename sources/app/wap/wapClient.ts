import { log, warn, error as logError } from "@/utils/log";
import type {
    WapContainer,
    WapTemplate,
    CreateContainerRequest,
    WapCreateContainerResponse,
    WapContainerListResponse,
    WapTemplateListResponse,
} from "./types";

const MODULE = 'wap-client';

class WapClient {
    private baseUrl: string;
    private authHeader: string;

    constructor() {
        this.baseUrl = process.env.WAP_API_URL || 'https://wap.dev.ai-armory.com';
        const user = process.env.WAP_AUTH_USER || '';
        const pass = process.env.WAP_AUTH_PASS || '';
        this.authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }

    // === Container Operations ===

    async createContainer(params: CreateContainerRequest): Promise<WapCreateContainerResponse> {
        log({ module: MODULE }, `Creating container: ${params.name} (${params.image})`);
        return this.request<WapCreateContainerResponse>('POST', '/api/v1/containers/create', params);
    }

    async startContainer(id: string): Promise<void> {
        log({ module: MODULE }, `Starting container: ${id}`);
        await this.request('POST', `/api/v1/containers/${id}/start`);
    }

    async stopContainer(id: string): Promise<void> {
        log({ module: MODULE }, `Stopping container: ${id}`);
        await this.request('POST', `/api/v1/containers/${id}/stop`);
    }

    async restartContainer(id: string): Promise<void> {
        log({ module: MODULE }, `Restarting container: ${id}`);
        await this.request('POST', `/api/v1/containers/${id}/restart`);
    }

    async removeContainer(id: string): Promise<void> {
        log({ module: MODULE }, `Removing container: ${id}`);
        await this.request('DELETE', `/api/v1/containers/${id}`);
    }

    async getContainer(id: string): Promise<WapContainer> {
        return this.request<WapContainer>('GET', `/api/v1/containers/${id}`);
    }

    async listContainers(labelFilter?: string): Promise<WapContainer[]> {
        const query = labelFilter ? `?label=${encodeURIComponent(labelFilter)}` : '';
        const response = await this.request<WapContainerListResponse>('GET', `/api/v1/containers${query}`);
        return response.containers || [];
    }

    // === Template Operations ===

    async listTemplates(): Promise<WapTemplate[]> {
        const response = await this.request<WapTemplateListResponse>('GET', '/api/v1/applications');
        return response.applications || [];
    }

    async getTemplate(id: string): Promise<WapTemplate> {
        return this.request<WapTemplate>('GET', `/api/v1/applications/${id}`);
    }

    // === SSE Connection ===

    /**
     * Returns the SSE events URL for connecting to real-time Docker events.
     */
    getSseUrl(): string {
        return `${this.baseUrl}/sse/events`;
    }

    getAuthHeader(): string {
        return this.authHeader;
    }

    // === Private Request Helper ===

    private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
        const url = `${this.baseUrl}${path}`;

        const headers: Record<string, string> = {
            'Authorization': this.authHeader,
            'Accept': 'application/json',
        };

        const init: RequestInit = { method, headers };

        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        let response: Response;
        try {
            response = await fetch(url, init);
        } catch (err) {
            logError({ module: MODULE, url, method }, `WAP request failed: ${err}`);
            throw new Error(`WAP request failed: ${err}`);
        }

        if (!response.ok) {
            let errorBody = '';
            try {
                errorBody = await response.text();
            } catch {
                // ignore
            }
            const msg = `WAP API error ${response.status} ${method} ${path}: ${errorBody}`;
            logError({ module: MODULE, status: response.status, url }, msg);
            throw new Error(msg);
        }

        // Some endpoints (start, stop, restart, remove) may return no body
        const text = await response.text();
        if (!text) {
            return undefined as T;
        }

        try {
            return JSON.parse(text) as T;
        } catch {
            warn({ module: MODULE }, `WAP response not JSON for ${method} ${path}`);
            return text as unknown as T;
        }
    }

    isConfigured(): boolean {
        return !!(process.env.WAP_API_URL && process.env.WAP_AUTH_USER && process.env.WAP_AUTH_PASS);
    }
}

export const wapClient = new WapClient();
