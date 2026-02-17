// WAP (Docker Management Platform) type definitions

// === Container Types ===

export interface WapContainer {
    id: string;
    name: string;
    image: string;
    status: string; // "running", "stopped", "created", "exited", etc.
    labels: Record<string, string>;
    createdAt: string;
    startedAt?: string;
    stoppedAt?: string;
    exitCode?: number;
    ports?: WapPortBinding[];
    network?: string;
}

export interface WapPortBinding {
    containerPort: number;
    hostPort?: number;
    protocol: string; // "tcp" | "udp"
}

// === Template Types ===

export interface WapTemplate {
    id: string;
    name: string;
    description?: string;
    image: string;
    tag: string;
    config: WapTemplateConfig;
    category?: string;
}

export interface WapTemplateConfig {
    env?: string[];
    ports?: WapPortBinding[];
    volumes?: string[];
    network?: string;
    restartPolicy?: string;
    resources?: ContainerResources;
    labels?: Record<string, string>;
}

// === Container Creation ===

export interface CreateContainerRequest {
    name: string;
    image: string;
    tag?: string;
    env?: string[];
    network?: string;
    labels?: Record<string, string>;
    restartPolicy?: string;
    resources?: ContainerResources;
    ports?: WapPortBinding[];
    volumes?: string[];
}

export interface ContainerResources {
    cpuLimit?: number;     // CPU cores (e.g., 2.0)
    memoryLimit?: string;  // e.g., "2g", "512m"
    cpuReserve?: number;
    memoryReserve?: string;
}

// === API Responses ===

export interface WapCreateContainerResponse {
    id: string;
    name: string;
    image: string;
    status: string;
}

export interface WapContainerListResponse {
    containers: WapContainer[];
}

export interface WapTemplateListResponse {
    applications: WapTemplate[];
}

// === SSE Event Types ===

export interface WapContainerEvent {
    type: 'create' | 'start' | 'stop' | 'die' | 'destroy' | 'restart';
    containerId: string;
    containerName: string;
    labels: Record<string, string>;
    timestamp: number;
    exitCode?: number;
}
