/**
 * Image reference type - can be either:
 * - External URL (url field set)
 * - Legacy S3 path (path field set, for backwards compatibility)
 */
export type ImageRef = {
    url?: string;
    path?: string;
    width?: number;
    height?: number;
    thumbhash?: string;
}

/**
 * Get the public URL for an image reference.
 * Returns the url field if present, otherwise returns the path as-is.
 */
export function getPublicUrl(ref: ImageRef | string): string {
    if (typeof ref === 'string') {
        // Legacy: just a path string
        return ref;
    }
    if (ref.url) {
        return ref.url;
    }
    if (ref.path) {
        return ref.path;
    }
    return '';
}
