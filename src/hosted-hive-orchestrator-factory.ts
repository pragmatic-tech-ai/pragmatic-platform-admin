import { EffectiveRegistry, HiveBackend, InfraMode, K8sManifestBuilder, KubectlHiveOrchestrator, UnsupportedBackendError, type HiveRecord, type IHiveOrchestrator } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IImageDigest, ISignatureStore } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ClusterCredentialHandover } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { CredentialKubeconfigExec, HostedClusterKubectl, type IClusterCredentialSource } from './hosted-cluster-kubectl.js'
import { NoInfraTargetBackendError } from './no-infra-target.js'
import { PlatformHiveOrchestratorFactory } from './platform-hive-orchestrator-factory.js'
import { HiveReach } from './hive-reach.js'

/** A hosted hive was registered without the kubeconfig context of its cluster, so there is nothing to drive. Maps to 400. */
export class HostedClusterRefMissingError extends UnsupportedBackendError
{
    private static readonly BackendErrorName = 'HostedClusterRefMissingError'
    private static readonly Message = "a hosted hive must name its cluster's kubeconfig context (configRef)"

    public constructor(hive: HiveRecord)
    {
        super(hive.cluster.backend, hive.cluster.mode)
        this.message = HostedClusterRefMissingError.Message
        this.name = HostedClusterRefMissingError.BackendErrorName
    }
}

/**
 * `PRAGMATIC_ADMIN_INFRA_TARGET=hosted`: drives only clusters on our machines, over the mesh. A hive placed by a host
 * agent (C5.1) names its own credential (configRef `clusters/<placement>`): every kubectl call reads it from the sealed
 * secret store into a private temp kubeconfig, removed after the call (also when it fails), so a rotated credential is
 * used from the next call on. A legacy record names a context of the single shared kubeconfig (HostedKubeconfig). It
 * never falls back to the local development cluster and never provisions (kind is never reached); images are verified
 * by registry digest through the digests the platform factory is given.
 */
export class HostedHiveOrchestratorFactory extends PlatformHiveOrchestratorFactory
{
    private static readonly CredentialPrefix = ClusterCredentialHandover.ReferenceFor('')

    /** `credentials`: the sealed secret store; without it a placed hive's credential reference is unsupported. */
    public constructor(localContext?: string, dataRoot?: string, digests?: IImageDigest, signatures?: ISignatureStore, private readonly credentials?: IClusterCredentialSource, private readonly tempRoot?: string)
    {
        super(localContext, dataRoot, digests, signatures)
    }

    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        HiveReach.Require(hive)
        const { backend, mode, configRef } = hive.cluster
        if (backend === HiveBackend.Local && mode === InfraMode.Attach)
        {
            if (configRef === undefined || configRef.length === 0)
            {
                throw new HostedClusterRefMissingError(hive)
            }
            if (HostedHiveOrchestratorFactory.IsCredentialReference(configRef))
            {
                return this.BuildHosted(hive, configRef)
            }
            return this.BuildKubectl(hive, configRef)
        }
        if (backend === HiveBackend.Local && mode === InfraMode.Provision)
        {
            throw new NoInfraTargetBackendError(hive)
        }
        throw new UnsupportedBackendError(backend, mode)
    }

    /** Whether a configRef names a per-cluster credential in the secret store (`clusters/<placement>`), not a context. */
    public static IsCredentialReference(configRef: string): boolean
    {
        return configRef.startsWith(HostedHiveOrchestratorFactory.CredentialPrefix)
    }

    private BuildHosted(hive: HiveRecord, ref: string): IHiveOrchestrator
    {
        if (this.credentials === undefined)
        {
            throw new UnsupportedBackendError(hive.cluster.backend, hive.cluster.mode)
        }
        const kubectl = new HostedClusterKubectl(new CredentialKubeconfigExec(this.credentials, ref, undefined, this.tempRoot))
        return new KubectlHiveOrchestrator(kubectl, new K8sManifestBuilder(), EffectiveRegistry.For(hive), this.Verifier(), hive.trustRootRef)
    }
}
