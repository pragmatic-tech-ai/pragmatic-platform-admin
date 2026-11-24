import { AppliedConfigurationKeys } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ComponentConfigurationMounts, K8sManifestBuilder, WorkloadRoll } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

type ManifestItem = { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: Record<string, unknown> }
type PodTemplate = { spec?: { containers?: Array<{ name?: string }> } }

/**
 * Makes the hive agent of an existing hive a configuration target, on every console install (C3.1 final review I2). The
 * console install reuses the agent token, so it renders no agent: an agent an earlier bundle rendered keeps no
 * configuration labels, mounts or empty objects, and the console's Role names objects that do not exist.
 *
 * The hold is the running agent's own Deployment (as kubectl returns it) with what the 0.18 builder attaches to every hive
 * workload (ComponentConfigurationMounts): the component labels, the configuration volumes and its container's mounts,
 * the surge roll and minReadySeconds. Its image, environment, command, probes and pod-template annotations are the
 * running ones: an agent image that reads no `_FILE` token or writes no ready file keeps running as it does, and a
 * configuration hash the console put there stays. Attaching mounts changes the pod template, so the agent rolls once on
 * its own image (surge, the old pod serving until the new one is available); nothing else moves. Its RBAC and token are
 * never re-applied. The empty `pragmatic-config-` / `pragmatic-secrets-` objects come from the agent bundle the builder
 * renders and are created when missing, never applied (C3.1 Ledger R8). The agent's own image moves with the agent
 * install (or its bundle) and with every console install (ReleaseRoll), which renders the release's agent with its ready
 * probe and token file.
 */
export class AgentConfigurationHold
{
    private static readonly DeploymentKind = 'Deployment'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly SecretKind = 'Secret'
    private static readonly ListKind = 'List'
    private static readonly ApiVersionCore = 'v1'
    /** The agent's container name in every bundle the builder rendered. */
    private static readonly AgentContainer = 'agent'
    /** What the server writes or kubectl records: never applied back. */
    private static readonly ServerAnnotations: readonly string[] = ['kubectl.kubernetes.io/last-applied-configuration', 'deployment.kubernetes.io/revision']
    private static readonly NoText = ''
    /** The console's annotations on a running pod template: a roll keeps them, or the applied configuration would be lost. */
    private static readonly KeptAnnotations: readonly string[] = [AppliedConfigurationKeys.HashAnnotation, AppliedConfigurationKeys.SecretsRevisionAnnotation]

    private constructor()
    {
    }

    /** The running agent Deployment with the configuration attached; undefined when none runs or it has no agent container. */
    public static Of(live: string | undefined): string | undefined
    {
        const H = AgentConfigurationHold
        if (live === undefined) return undefined
        const deployment = JSON.parse(live) as ManifestItem
        const template = deployment.spec?.template as PodTemplate | undefined
        if (template?.spec?.containers?.some(c => c.name === H.AgentContainer) !== true) return undefined
        const annotations = Object.fromEntries(Object.entries(deployment.metadata?.annotations ?? {}).filter(([key]) => !H.ServerAnnotations.includes(key)))
        const held: Record<string, unknown> = {
            apiVersion: deployment.apiVersion,
            kind: H.DeploymentKind,
            metadata: { name: deployment.metadata?.name, namespace: deployment.metadata?.namespace, labels: { ...deployment.metadata?.labels }, annotations },
            spec: structuredClone(deployment.spec),
        }
        ComponentConfigurationMounts.Attach(held, [{ Container: H.AgentContainer, Component: ReleaseApp.HiveAgent }], WorkloadRoll.Surge)
        return H.List([held])
    }

    /**
     * The release's agent Deployment for `hiveId` (the builder's, on `image`, reading the hive's existing token Secret),
     * keeping the running template's console annotations (configuration hash, secrets revision) and replicas, so applying it
     * moves the agent onto the release without dropping its applied configuration; undefined without a running agent.
     * Applied server-side under the hold's field manager, then client-side (TenantConsoleInstaller.RollOutAgent): what the
     * earlier bundle rendered and this one no longer does (the token as an environment value) is owned by that manager
     * since the hold, so the server-side apply drops it.
     */
    public static ReleaseRoll(live: string | undefined, hiveId: string, channelUrl: string, image: string): string | undefined
    {
        const H = AgentConfigurationHold
        if (live === undefined) return undefined
        const running = JSON.parse(live) as ManifestItem
        const runningTemplate = running.spec?.template as { metadata?: { annotations?: Record<string, unknown> } } | undefined
        const rendered = JSON.parse(new K8sManifestBuilder().RenderHiveAgent(hiveId, channelUrl, K8sManifestBuilder.AgentTokenSecretNameOf(hiveId), image)) as { items: ManifestItem[] }
        const deployment = rendered.items.find(i => i.kind === H.DeploymentKind)
        if (deployment === undefined) return undefined
        const spec = deployment.spec as { replicas?: unknown; template: { metadata: { annotations?: Record<string, string> } } }
        spec.template.metadata.annotations = { ...spec.template.metadata.annotations, ...H.KeptOf(runningTemplate?.metadata?.annotations) }
        if (running.spec?.replicas !== undefined) spec.replicas = running.spec.replicas
        return H.List([deployment])
    }

    /**
     * An agent bundle (a List the agent install applies client-side) with the running agent's configuration annotations
     * kept on its Deployment's pod template: the client-side apply would otherwise delete the configuration hash and secrets
     * revision a console install's roll recorded, rolling the agent off its applied configuration. Unchanged without a
     * running agent or a Deployment in the bundle.
     */
    public static KeepingAnnotations(bundle: string, live: string | undefined): string
    {
        const H = AgentConfigurationHold
        if (live === undefined) return bundle
        const running = (JSON.parse(live) as ManifestItem).spec?.template as { metadata?: { annotations?: Record<string, unknown> } } | undefined
        const kept = H.KeptOf(running?.metadata?.annotations)
        if (Object.keys(kept).length === 0) return bundle
        const list = JSON.parse(bundle) as { items?: ManifestItem[] }
        for (const item of list.items ?? [])
        {
            if (item.kind !== H.DeploymentKind) continue
            const template = (item.spec as { template?: { metadata?: { annotations?: Record<string, string> } } } | undefined)?.template
            if (template === undefined) continue
            template.metadata = { ...template.metadata, annotations: { ...template.metadata?.annotations, ...kept } }
        }
        return JSON.stringify(list)
    }

    /** The agent's empty configuration ConfigMap and Secret (one manifest each), as its bundle renders them for `hiveId`. */
    public static ConfigurationObjects(hiveId: string): string[]
    {
        const H = AgentConfigurationHold
        const names = [ComponentConfigurationMounts.ConfigMapNameOf(ReleaseApp.HiveAgent), ComponentConfigurationMounts.SecretNameOf(ReleaseApp.HiveAgent)]
        const rendered = JSON.parse(new K8sManifestBuilder().RenderHiveAgent(hiveId, H.NoText, H.NoText, H.NoText)) as { items: ManifestItem[] }
        return rendered.items
            .filter(i => (i.kind === H.ConfigMapKind || i.kind === H.SecretKind) && names.includes(i.metadata?.name ?? H.NoText))
            .map(i => JSON.stringify(i))
    }

    // The console's annotations among a running template's.
    private static KeptOf(annotations: Record<string, unknown> | undefined): Record<string, string>
    {
        const kept: Record<string, string> = {}
        for (const key of AgentConfigurationHold.KeptAnnotations)
        {
            const value = annotations?.[key]
            if (typeof value === 'string') kept[key] = value
        }
        return kept
    }

    private static List(items: readonly unknown[]): string
    {
        return JSON.stringify({ apiVersion: AgentConfigurationHold.ApiVersionCore, kind: AgentConfigurationHold.ListKind, items })
    }
}
