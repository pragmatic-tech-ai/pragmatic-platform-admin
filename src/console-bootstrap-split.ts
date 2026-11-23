import { AppliedConfigurationKeys } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { ComponentConfigurationMounts, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

type ManifestItem = { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }; spec?: Record<string, unknown>; data?: unknown; stringData?: unknown }

/**
 * A console bootstrap manifest split by when each part may land (C3.1 upgrade path, step 3):
 *
 * - `Console`: everything but the parts below, applied first. The console rolls onto the release with it, and prepares
 *   every configuration for the release's descriptors before anything else moves.
 * - `ConfigurationObjects`: the empty `pragmatic-config-<component>` ConfigMaps and `pragmatic-secrets-<component>`
 *   Secrets the manifests render so the console never needs `create` beside them. They are created when missing and never
 *   applied: a client-side apply of an object with no `data` deletes the data its last client-side apply recorded (a
 *   hand-built configuration), and kubectl's server-side apply migrates that ownership to its field manager, so a later
 *   server-side apply without `data` would drop it.
 * - `IdpDeployment`: the realm sign-in service's Deployment, which carries the release's IdP image, applied only once
 *   its configuration is prepared for that image's descriptor (applying it rolls the IdP). `IdpHold` is that Deployment
 *   with the running IdP's own pod template and replica count, applied first (server-side) so the IdP gets the labels the
 *   console finds its configuration target by while nothing rolls (a labels-only object fails kubectl's validation).
 */
export class ConsoleBootstrapSplit
{
    private static readonly DeploymentKind = 'Deployment'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly SecretKind = 'Secret'
    private static readonly ListKind = 'List'
    private static readonly ApiVersionCore = 'v1'
    private static readonly TemplateKey = 'template'
    private static readonly ReplicasKey = 'replicas'
    private static readonly MetadataKey = 'metadata'
    private static readonly AnnotationsKey = 'annotations'
    /** What `kubectl rollout restart` sets: a new value rolls the pods. */
    public static readonly RestartedAtAnnotation = 'kubectl.kubernetes.io/restartedAt'
    private static readonly NoIdpDeployment = 'the bootstrap renders no IdP Deployment'
    private static readonly SpecKey = 'spec'
    private static readonly NameKey = 'name'
    private static readonly TerminationPolicyKey = 'terminationMessagePolicy'
    private static readonly FallbackToLogsOnError = 'FallbackToLogsOnError'
    private static readonly DefaultIdpContainer = 'idp'
    private static readonly KeptAnnotations: readonly string[] = [AppliedConfigurationKeys.HashAnnotation, AppliedConfigurationKeys.SecretsRevisionAnnotation]

    private constructor(
        public readonly Console: string,
        /** One manifest per object (each created on its own when missing). */
        public readonly ConfigurationObjects: readonly string[],
        public readonly IdpDeployment: string | undefined,
        private readonly idp: ManifestItem | undefined,
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
        return new ConsoleBootstrapSplit(S.List(rest), objects.map(o => JSON.stringify(o)), deployment === undefined ? undefined : S.List([deployment]), deployment)
    }

    /**
     * The IdP Deployment to roll onto: `kubectl.kubernetes.io/restartedAt` = `at` on its pod template, so applying it rolls
     * the pods once even when the image is unchanged (a reinstall's new Secrets), one revision instead of an apply and a
     * restart; the console's configuration-hash and secrets-revision annotations of the running template (`live`) kept (a
     * client-side apply would otherwise drop them); and the IdP container's termination message taken from its last log
     * lines when it exits on an error, so the install can say why it did not start.
     */
    public IdpDeploymentRestartedAt(at: string, live?: string): string
    {
        const S = ConsoleBootstrapSplit
        if (this.idp === undefined) throw new Error(S.NoIdpDeployment)
        const spec = (this.idp.spec ?? {}) as Record<string, Record<string, Record<string, unknown>>>
        const template = spec[S.TemplateKey] ?? {}
        const metadata = (template[S.MetadataKey] ?? {}) as Record<string, Record<string, string>>
        const running = S.RunningAnnotations(live)
        const stamped = { ...metadata, [S.AnnotationsKey]: { ...metadata[S.AnnotationsKey], ...running, [S.RestartedAtAnnotation]: at } }
        const pod = (template[S.SpecKey] ?? {}) as { containers?: Array<Record<string, unknown>> }
        const containers = (pod.containers ?? []).map(c => c[S.NameKey] === this.IdpContainer ? { ...c, [S.TerminationPolicyKey]: S.FallbackToLogsOnError } : c)
        return S.List([{ ...this.idp, spec: { ...spec, [S.TemplateKey]: { ...template, [S.MetadataKey]: stamped, [S.SpecKey]: { ...pod, containers } } } }])
    }

    /** The container that runs the IdP (the component label names it). */
    public get IdpContainer(): string
    {
        return this.idp?.metadata?.labels?.[ComponentConfigurationMounts.ConfiguresLabelPrefix + ReleaseApp.TenantIdp] ?? ConsoleBootstrapSplit.DefaultIdpContainer
    }

    /** The image the release runs the IdP on; undefined without a rendered IdP Deployment. */
    public get IdpImage(): string | undefined
    {
        const containers = ((this.idp?.spec?.[ConsoleBootstrapSplit.TemplateKey] as { spec?: { containers?: Array<{ name?: string; image?: string }> } } | undefined)?.spec?.containers) ?? []
        return containers.find(c => c.name === this.IdpContainer)?.image
    }

    // The console's annotations on the running pod template (configuration hash, secrets revision).
    private static RunningAnnotations(live: string | undefined): Record<string, string>
    {
        const S = ConsoleBootstrapSplit
        if (live === undefined) return {}
        const annotations = (JSON.parse(live) as { spec?: { template?: { metadata?: { annotations?: Record<string, unknown> } } } }).spec?.template?.metadata?.annotations ?? {}
        const out: Record<string, string> = {}
        for (const key of S.KeptAnnotations)
        {
            const value = annotations[key]
            if (typeof value === 'string') out[key] = value
        }
        return out
    }

    /** The rendered IdP Deployment holding the running one's pod template and replicas (`live`, as kubectl returns it), so
     *  applying it changes labels and nothing that rolls; undefined without a rendered or a running one with a template. */
    public IdpHold(live: string | undefined): string | undefined
    {
        const S = ConsoleBootstrapSplit
        if (this.idp === undefined || live === undefined) return undefined
        const running = (JSON.parse(live) as ManifestItem).spec
        if (running?.[S.TemplateKey] === undefined) return undefined
        const spec = { ...this.idp.spec, [S.TemplateKey]: running[S.TemplateKey], [S.ReplicasKey]: running[S.ReplicasKey] ?? this.idp.spec?.[S.ReplicasKey] }
        return S.List([{ ...this.idp, spec }])
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
