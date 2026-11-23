import { ComponentConfigurationMounts, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { ComponentDescriptorSet } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

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
    private static readonly ApiVersionCore = 'v1'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly ConfigMapResource = 'configmap/'

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
        const descriptors = [...set.All()].sort((a, b) => a.Name.localeCompare(b.Name))
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

    /** The full object for a server-side apply: every key it carries replaces what an earlier install wrote. */
    public static ManifestOf(set: ComponentDescriptorSet, hiveId: string, version: string): string
    {
        const C = ReleaseDescriptorsConfigMap
        return JSON.stringify({
            [C.ApiVersionKey]: C.ApiVersionCore,
            [C.KindKey]: C.ConfigMapKind,
            [C.MetadataKey]: {
                [C.NameKey]: C.Name,
                [C.NamespaceKey]: C.Namespace,
                [C.LabelsKey]: K8sManifestBuilder.HiveLabelsOf(hiveId),
                [C.AnnotationsKey]: { [C.ReleaseAnnotation]: version },
            },
            [C.DataKey]: C.DataOf(set),
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
        if (json === undefined)
        {
            return false
        }
        return K8sManifestBuilder.HiveOf(JSON.parse(json)) === hiveId
    }
}
