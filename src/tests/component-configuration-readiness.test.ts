import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, AppliedConfigurationKeys, ConfigurationPreparationRefusal, ConfigurationPreparationStatus,
} from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { ComponentConfigurationReadiness, ConfigurationReadinessState } from '../component-configuration-readiness.js'

type AppliedMap = ReturnType<typeof AppliedConfigurationCodec.ToConfigMap>

class ReadinessCase
{
    public static readonly Old = `sha256:${'0'.repeat(64)}`
    public static readonly New = `sha256:${'b'.repeat(64)}`
    public static readonly Other = `sha256:${'c'.repeat(64)}`

    public static Applied(digest: string = ReadinessCase.Old): AppliedConfiguration
    {
        return new AppliedConfiguration('t1', 'pragmatic-tenant-idp', 3, '0.2.0', digest, { options: {} })
    }

    public static Map(): AppliedMap
    {
        return AppliedConfigurationCodec.ToConfigMap(ReadinessCase.Applied(), 'ns')
    }

    public static Entry(digest: string = ReadinessCase.New): AppliedConfiguration
    {
        return new AppliedConfiguration('t1', 'pragmatic-tenant-idp', 1, '0.2.4', digest, { options: {} })
    }

    public static Status(map: AppliedMap, status: (s: ConfigurationPreparationStatus) => ConfigurationPreparationStatus, from: string = ReadinessCase.Applied().ContentHash()): AppliedMap
    {
        map.metadata.annotations = status(ConfigurationPreparationStatus.Of(map.metadata.annotations).DerivedFrom(from)).Over(map.metadata.annotations)
        return map
    }

    public static Of(map: unknown, digest: string = ReadinessCase.New): ConfigurationReadinessState
    {
        return ComponentConfigurationReadiness.Of(map === undefined ? undefined : JSON.stringify(map), digest).State
    }
}

describe('ComponentConfigurationReadiness', () =>
{
    const C = ReadinessCase
    const R = ConfigurationReadinessState

    it('is ready with nothing configured, or a configuration already for the digest', () =>
    {
        assert.equal(C.Of(undefined), R.Ready)
        assert.equal(C.Of({ metadata: {} }), R.Ready)
        assert.equal(C.Of(AppliedConfigurationCodec.ToConfigMap(C.Applied(C.New), 'ns')), R.Ready)
    })

    it('is ready when the holding status marks the digest prepared and its entry reads', () =>
    {
        const map = C.Status(AppliedConfigurationEntries.With(C.Map(), C.Entry()), s => s.WithPrepared(C.New))
        assert.equal(C.Of(map), R.Ready)
    })

    it('waits while prepared but the entry is missing, or the status is stale', () =>
    {
        assert.equal(C.Of(C.Status(C.Map(), s => s.WithPrepared(C.New))), R.Waiting)
        assert.equal(C.Of(C.Status(AppliedConfigurationEntries.With(C.Map(), C.Entry()), s => s.WithPrepared(C.New), C.Other)), R.Waiting)
        assert.equal(C.Of(C.Map()), R.Waiting)
    })

    it('a refusal counts only under a holding status', () =>
    {
        const refusal = new ConfigurationPreparationRefusal(C.New, '0.2.4', ['core.x'], 'rule')
        const refused = ComponentConfigurationReadiness.Of(JSON.stringify(C.Status(C.Map(), s => s.WithRefusal(refusal))), C.New)
        assert.equal(refused.State, R.Refused)
        assert.deepEqual(refused.Refusal?.Settings, ['core.x'])
        assert.equal(C.Of(C.Status(C.Map(), s => s.WithRefusal(refusal), C.Other)), R.Waiting)
    })

    it('without a hash annotation the file content hash is used; an undecodable file waits; another bad entry does not hold up this one', () =>
    {
        const noHash = C.Status(AppliedConfigurationEntries.With(C.Map(), C.Entry()), s => s.WithPrepared(C.New))
        delete noHash.metadata.annotations[AppliedConfigurationKeys.HashAnnotation]
        assert.equal(C.Of(noHash), R.Ready)
        assert.equal(C.Of({ data: { [AppliedConfigurationKeys.FileName]: 'not json' } }), R.Waiting)
        const withBad = C.Status(AppliedConfigurationEntries.With(C.Map(), C.Entry()), s => s.WithPrepared(C.New))
        withBad.data[AppliedConfigurationEntries.KeyOf(C.Other)] = 'not json'
        assert.equal(C.Of(withBad), R.Ready)
    })
})
