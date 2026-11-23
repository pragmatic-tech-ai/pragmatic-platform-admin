import { ComponentConfigurationMounts, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { ComponentDescriptorSet } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** The descriptors exceed what one ConfigMap holds. */
export class ReleaseDescriptorsTooLargeError extends Error
{
    private static readonly ErrorName = 'ReleaseDescriptorsTooLargeError'
    private static readonly Prefix = 'The component descriptors of release '
    private static readonly Suffix = ' exceed what one ConfigMap holds (1 MiB, less 16 KiB kept for its metadata).'

    public constructor(version: string)
    {
        super(ReleaseDescriptorsTooLargeError.Prefix + version + ReleaseDescriptorsTooLargeError.Suffix)
        this.name = ReleaseDescriptorsTooLargeError.ErrorName
    }
}

/**
 * The ConfigMap `pragmatic-release-descriptors` in pragmatic-system: the component descriptors of the release a hive's
 * tenant console runs, which the console's Deployment (K8sManifestBuilder, from pragmatic-shared 0.18) mounts read-only at
 * /etc/pragmatic/descriptors and reads as a ComponentDescriptorSet directory: `digests.json` (component to content digest)
 * plus one `<component>.json` each, the descriptor's canonical JSON (whose digest is the one the release signs). The
 * platform admin console delivers the release to the hive, so it writes this object on every console install; it carries
 * the hive's label and the release version (an annotation), and nothing secret.
 */
export class ReleaseDescriptorsConfigMap
{
    public static readonly Name = ComponentConfigurationMounts.ReleaseDescriptorsConfigMap
    public static readonly Namespace = K8sManifestBuilder.SystemNamespace
    public static readonly DigestsKey = 'digests.json'
    /** The release whose descriptors the object holds. */
    public static readonly ReleaseAnnotation = 'pragmatic-tech.ai/release'
    private static readonly JsonExtension = '.json'
    private static readonly JsonIndent = 2
    private static readonly Newline = '\n'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly AnnotationsKey = 'annotations'
    private static readonly DataKey = 'data'
    private static readonly ResourceVersionKey = 'resourceVersion'
    private static readonly ApiVersionCore = 'v1'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly ConfigMapResource = 'configmap/'
    /** The API server's bound on a ConfigMap's data, less room for its metadata. */
    public static readonly MaxDataBytes = 1024 * 1024 - 16 * 1024

    private constructor()
    {
    }

    /** `configmap/pragmatic-release-descriptors`, as kubectl names it. */
    public static Resource(): string
    {
        return ReleaseDescriptorsConfigMap.ConfigMapResource + ReleaseDescriptorsConfigMap.Name
    }

    /** The data of the object: `digests.json` (sorted by component) and `<component>.json` per descriptor. */
    public static DataOf(set: ComponentDescriptorSet): Record<string, string>
    {
        const C = ReleaseDescriptorsConfigMap
        // Ordinal order (locale-independent), so the object's bytes are the same on every control plane.
        const descriptors = [...set.All()].sort((a, b) => a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0)
        const digests: Record<string, string> = {}
        const data: Record<string, string> = {}
        for (const descriptor of descriptors)
        {
            digests[descriptor.Name] = descriptor.ContentDigest()
            data[descriptor.Name + C.JsonExtension] = descriptor.ToCanonicalJson()
        }
        data[C.DigestsKey] = JSON.stringify(digests, null, C.JsonIndent) + C.Newline
        return data
    }

    /**
     * The full object for a server-side apply: every key it carries replaces what an earlier install wrote under the same
     * field manager. Throws ReleaseDescriptorsTooLargeError past MaxDataBytes.
     */
    public static ManifestOf(set: ComponentDescriptorSet, hiveId: string, version: string): string
    {
        const C = ReleaseDescriptorsConfigMap
        const data = C.DataOf(set)
        const bytes = Object.entries(data).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0)
        if (bytes > C.MaxDataBytes)
        {
            throw new ReleaseDescriptorsTooLargeError(version)
        }
        return JSON.stringify({
            [C.ApiVersionKey]: C.ApiVersionCore,
            [C.KindKey]: C.ConfigMapKind,
            [C.MetadataKey]: {
                [C.NameKey]: C.Name,
                [C.NamespaceKey]: C.Namespace,
                [C.LabelsKey]: K8sManifestBuilder.HiveLabelsOf(hiveId),
                [C.AnnotationsKey]: { [C.ReleaseAnnotation]: version },
            },
            [C.DataKey]: data,
        })
    }

    /** The object's identity (name and namespace only), to delete it. */
    public static IdentityManifest(): string
    {
        const C = ReleaseDescriptorsConfigMap
        return JSON.stringify({ [C.ApiVersionKey]: C.ApiVersionCore, [C.KindKey]: C.ConfigMapKind, [C.MetadataKey]: { [C.NameKey]: C.Name, [C.NamespaceKey]: C.Namespace } })
    }

    /** Whether the object as kubectl returned it (JSON) belongs to `hiveId` (carries its hive label). */
    public static BelongsTo(json: string | undefined, hiveId: string): boolean
    {
        return ReleaseDescriptorsConfigMap.HiveOf(json) === hiveId
    }

    /** The object's resourceVersion as kubectl returned it; undefined when it is absent or has none. */
    public static ResourceVersionOf(json: string | undefined): string | undefined
    {
        const version = json === undefined ? undefined : (JSON.parse(json) as { metadata?: { resourceVersion?: unknown } }).metadata?.resourceVersion
        return typeof version === 'string' && version.length > 0 ? version : undefined
    }

    /** `manifest` with `resourceVersion` set: the API server applies it only while the object is still at that version. */
    public static WithResourceVersion(manifest: string, resourceVersion: string): string
    {
        const C = ReleaseDescriptorsConfigMap
        const doc = JSON.parse(manifest) as Record<string, Record<string, unknown>>
        doc[C.MetadataKey] = { ...doc[C.MetadataKey], [C.ResourceVersionKey]: resourceVersion }
        return JSON.stringify(doc)
    }

    /** The descriptor digest `digests.json` of the object (a manifest or what kubectl returned) names for `component`;
     *  undefined when there is no object, no such key or no such component. */
    public static DigestOf(json: string | undefined, component: string): string | undefined
    {
        const C = ReleaseDescriptorsConfigMap
        if (json === undefined) return undefined
        const text = (JSON.parse(json) as { data?: Record<string, unknown> }).data?.[C.DigestsKey]
        if (typeof text !== 'string') return undefined
        try
        {
            const digest = (JSON.parse(text) as Record<string, unknown>)[component]
            return typeof digest === 'string' ? digest : undefined
        }
        catch
        {
            return undefined
        }
    }

    /** The hive whose label the object carries; undefined when it is absent or carries none. */
    public static HiveOf(json: string | undefined): string | undefined
    {
        return json === undefined ? undefined : K8sManifestBuilder.HiveOf(JSON.parse(json))
    }
}
