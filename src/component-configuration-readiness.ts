import {
    AppliedConfigurationCodec, AppliedConfigurationEntries, AppliedConfigurationKeys, ConfigurationPreparationStatus, type AppliedConfiguration, type ConfigurationPreparationRefusal,
} from '@pragmatic-tech-ai/pragmatic-configuration-runtime'

/** Where a component's configuration stands for the descriptor a release is about to run it on. */
export enum ConfigurationReadinessState
{
    /** Nothing configured, configured for that descriptor already, or prepared for it: the component may roll. */
    Ready = 'ready',
    /** The tenant admin console refused it for that descriptor: the settings named must change first. */
    Refused = 'refused',
    /** Not prepared yet (or the status is stale): wait for the console. */
    Waiting = 'waiting',
}

export class ConfigurationReadiness
{
    public constructor(public readonly State: ConfigurationReadinessState, public readonly Refusal?: ConfigurationPreparationRefusal)
    {
        Object.freeze(this)
    }
}

/**
 * Reads, never writes, the status the tenant admin console records on a component's `pragmatic-config-<component>`
 * ConfigMap (C3.1 Ledger R4): ready when the ConfigMap has no `configuration.json`, when that file was validated for
 * `digest`, or when the status holds (derived from the file the hash annotation names) and marks `digest` prepared with
 * its entry present; refused when the holding status refuses `digest`; waiting otherwise. Configuration stays tenant-owned.
 */
export class ComponentConfigurationReadiness
{
    public static Of(configMapJson: string | undefined, digest: string): ConfigurationReadiness
    {
        const R = ConfigurationReadinessState
        if (configMapJson === undefined) return new ConfigurationReadiness(R.Ready)
        const map = JSON.parse(configMapJson) as { data?: Record<string, unknown>; metadata?: { annotations?: Record<string, unknown> } }
        const file = map.data?.[AppliedConfigurationKeys.FileName]
        if (typeof file !== 'string') return new ConfigurationReadiness(R.Ready)
        let primary: AppliedConfiguration
        try
        {
            primary = AppliedConfigurationCodec.Decode(file)
        }
        catch
        {
            return new ConfigurationReadiness(R.Waiting)
        }
        if (primary.DescriptorDigest === digest) return new ConfigurationReadiness(R.Ready)
        const annotations = map.metadata?.annotations
        const hash = annotations?.[AppliedConfigurationKeys.HashAnnotation]
        const status = ConfigurationPreparationStatus.Of(annotations)
        if (!status.Holds(typeof hash === 'string' ? hash : primary.ContentHash())) return new ConfigurationReadiness(R.Waiting)
        const refusal = status.RefusalFor(digest)
        if (refusal !== undefined) return new ConfigurationReadiness(R.Refused, refusal)
        if (!status.IsPrepared(digest)) return new ConfigurationReadiness(R.Waiting)
        // Only the entry for `digest`: another one that does not read never holds this one up.
        const entry = map.data?.[AppliedConfigurationEntries.KeyOf(digest)]
        let present = false
        if (typeof entry === 'string')
        {
            try
            {
                present = AppliedConfigurationCodec.Decode(entry).DescriptorDigest === digest
            }
            catch
            {
                present = false
            }
        }
        return new ConfigurationReadiness(present ? R.Ready : R.Waiting)
    }
}
