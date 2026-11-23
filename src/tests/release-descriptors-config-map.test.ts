import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComponentDescriptorSet, ReleaseApps } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ComponentConfigurationMounts, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseDescriptorsConfigMap } from '../release-descriptors-config-map.js'
import { ReleaseDescriptorFixtures as F } from './release-descriptor-fixtures.js'

type ConfigMapDoc = { apiVersion: string; kind: string; metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> }; data: Record<string, string> }

describe('ReleaseDescriptorsConfigMap', () =>
{
    it('is the ConfigMap the 0.18 console Deployment mounts, in pragmatic-system, hive-labelled, naming its release', () =>
    {
        const doc = JSON.parse(ReleaseDescriptorsConfigMap.ManifestOf(F.Set(), 'h1', F.Version)) as ConfigMapDoc
        assert.equal(doc.kind, 'ConfigMap')
        assert.equal(doc.metadata.name, ComponentConfigurationMounts.ReleaseDescriptorsConfigMap)
        assert.equal(doc.metadata.namespace, K8sManifestBuilder.SystemNamespace)
        assert.deepEqual(doc.metadata.labels, K8sManifestBuilder.HiveLabelsOf('h1'))
        assert.deepEqual(doc.metadata.annotations, { 'pragmatic-tech.ai/release': F.Version })
        assert.ok(ReleaseDescriptorsConfigMap.BelongsTo(JSON.stringify(doc), 'h1'))
        assert.ok(!ReleaseDescriptorsConfigMap.BelongsTo(JSON.stringify(doc), 'h2'))
        assert.ok(!ReleaseDescriptorsConfigMap.BelongsTo(undefined, 'h1'))
    })

    it('carries digests.json and one <app>.json per descriptor, canonical, which the console reads back as a pinned set', () =>
    {
        const set = F.Set()
        const data = ReleaseDescriptorsConfigMap.DataOf(set)
        assert.deepEqual(Object.keys(data).sort(), ['digests.json', ...ReleaseApps.All.map(app => app + '.json')].sort())
        assert.deepEqual(JSON.parse(data['digests.json'] as string), Object.fromEntries(set.All().map(d => [d.Name, d.ContentDigest()])))
        for (const descriptor of set.All())
        {
            assert.equal(data[descriptor.Name + '.json'], descriptor.ToCanonicalJson())
        }
        // The mounted directory, as the console's ReleaseDescriptorCatalogue reads it (ComponentDescriptorSet.FromDirectory checks every pin).
        const dir = mkdtempSync(join(tmpdir(), 'release-descriptors-'))
        try
        {
            for (const [key, value] of Object.entries(data))
            {
                writeFileSync(join(dir, key), value, 'utf8')
            }
            const read = ComponentDescriptorSet.FromDirectory(dir)
            assert.deepEqual(read.All().map(d => d.ContentDigest()).sort(), set.All().map(d => d.ContentDigest()).sort())
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('its identity names the object only, to delete it', () =>
    {
        assert.deepEqual(JSON.parse(ReleaseDescriptorsConfigMap.IdentityManifest()), {
            apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'pragmatic-release-descriptors', namespace: 'pragmatic-system' },
        })
        assert.equal(ReleaseDescriptorsConfigMap.Resource(), 'configmap/pragmatic-release-descriptors')
    })
})
