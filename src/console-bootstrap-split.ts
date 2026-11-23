import { AppliedConfigurationKeys } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { ComponentConfigurationMounts, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

type ManifestItem = { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }; data?: unknown; stringData?: unknown }

/**
 * A console bootstrap manifest split by when each part may land (C3.1 upgrade path, step 3):
 *
 * - `Console`: everything but the parts below, applied first. The console rolls onto the release with it, and prepares
 *   every configuration for the release's descriptors before anything else moves.
 * - `ConfigurationObjects`: the empty `pragmatic-config-<component>` ConfigMaps and `pragmatic-secrets-<component>`
 *   Secrets the manifests render so the console never needs `create` beside them. They go server-side: a client-side
 *   apply of an object with no `data` deletes the data its last client-side apply recorded (a hand-built configuration).
 * - `IdpDeployment`: the realm sign-in service's Deployment, which carries the release's IdP image, applied only once
 *   its configuration is prepared for that image's descriptor (applying it rolls the IdP). `IdpLabels` is its metadata
 *   alone, applied first to a running IdP so the console finds it as a configuration target without anything rolling.
 */
export class ConsoleBootstrapSplit
{
    private static readonly DeploymentKind = 'Deployment'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly SecretKind = 'Secret'
    private static readonly ListKind = 'List'
    private static readonly ApiVersionCore = 'v1'

    private constructor(
        public readonly Console: string,
        public readonly ConfigurationObjects: string | undefined,
        public readonly IdpDeployment: string | undefined,
        public readonly IdpLabels: string | undefined,
    )
    {
        Object.freeze(this)
    }

    public static Of(manifestJson: string, tenantId: string): ConsoleBootstrapSplit
    {
        const S = ConsoleBootstrapSplit
        const parsed = JSON.parse(manifestJson) as { kind?: string; items?: ManifestItem[] }
        const items = parsed.kind === S.ListKind ? parsed.items ?? [] : [parsed as ManifestItem]
        const idp = K8sManifestBuilder.IdpNameOf(tenantId)
        const isIdp = (i: ManifestItem): boolean => i.kind === S.DeploymentKind && i.metadata?.namespace === idp && i.metadata?.name === idp
        const deployment = items.find(isIdp)
        const objects = items.filter(i => S.IsConfigurationObject(i))
        const rest = items.filter(i => !isIdp(i) && !S.IsConfigurationObject(i))
        const labels = deployment === undefined ? undefined : S.List([{ apiVersion: deployment.apiVersion, kind: deployment.kind, metadata: { name: deployment.metadata?.name, namespace: deployment.metadata?.namespace, labels: deployment.metadata?.labels ?? {} } }])
        return new ConsoleBootstrapSplit(S.List(rest), objects.length === 0 ? undefined : S.List(objects), deployment === undefined ? undefined : S.List([deployment]), labels)
    }

    // An empty configuration object (no data): the console writes into it by name.
    private static IsConfigurationObject(item: ManifestItem): boolean
    {
        const S = ConsoleBootstrapSplit
        const name = item.metadata?.name ?? ''
        if (item.data !== undefined || item.stringData !== undefined) return false
        return (item.kind === S.ConfigMapKind && name.startsWith(AppliedConfigurationKeys.ObjectNamePrefix))
            || (item.kind === S.SecretKind && name.startsWith(ComponentConfigurationMounts.SecretNamePrefix))
    }

    private static List(items: readonly unknown[]): string
    {
        return JSON.stringify({ apiVersion: ConsoleBootstrapSplit.ApiVersionCore, kind: ConsoleBootstrapSplit.ListKind, items })
    }
}
