import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConsoleBootstrapSplit } from '../console-bootstrap-split.js'

class SplitCase
{
    public static readonly Tenant = 'acme'
    public static readonly Idp = K8sManifestBuilder.IdpNameOf('acme')

    public static Manifest(): string
    {
        const S = SplitCase
        return JSON.stringify({ kind: 'List', items: [
            { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: S.Idp, namespace: S.Idp, labels: { a: 'b' } }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'idp', image: 'new' }] } } } },
            { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'console', namespace: 'pragmatic-system' }, spec: {} },
            { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'pragmatic-config-pragmatic-tenant-idp', namespace: S.Idp } },
            { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: 'pragmatic-secrets-pragmatic-tenant-idp', namespace: S.Idp } },
            { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'pragmatic-config-with-data', namespace: S.Idp }, data: { k: 'v' } },
        ] })
    }
}

describe('ConsoleBootstrapSplit', () =>
{
    it('splits off the IdP Deployment and the empty configuration objects (one manifest each); objects with data stay', () =>
    {
        const split = ConsoleBootstrapSplit.Of(SplitCase.Manifest(), SplitCase.Tenant)
        const names = (json: string): string[] => (JSON.parse(json) as { items: Array<{ metadata: { name: string } }> }).items.map(i => i.metadata.name)
        assert.deepEqual(names(split.Console), ['console', 'pragmatic-config-with-data'])
        assert.deepEqual(split.ConfigurationObjects.map(o => (JSON.parse(o) as { metadata: { name: string } }).metadata.name), ['pragmatic-config-pragmatic-tenant-idp', 'pragmatic-secrets-pragmatic-tenant-idp'])
        assert.deepEqual(names(split.IdpDeployment as string), [SplitCase.Idp])
    })

    it('stamps the IdP Deployment pod template with the restart time, keeping its other annotations', () =>
    {
        const split = ConsoleBootstrapSplit.Of(SplitCase.Manifest(), SplitCase.Tenant)
        const item = JSON.parse(split.IdpDeploymentRestartedAt('2026-11-23T22:00:00.000Z')).items[0]
        assert.equal(item.spec.template.metadata.annotations[ConsoleBootstrapSplit.RestartedAtAnnotation], '2026-11-23T22:00:00.000Z')
        assert.equal(item.spec.template.spec.containers[0].image, 'new')
        assert.throws(() => ConsoleBootstrapSplit.Of(JSON.stringify({ kind: 'List', items: [] }), SplitCase.Tenant).IdpDeploymentRestartedAt('x'))
    })

    it('holds a running IdP only when it has a pod template, keeping its replicas', () =>
    {
        const split = ConsoleBootstrapSplit.Of(SplitCase.Manifest(), SplitCase.Tenant)
        assert.equal(split.IdpHold(undefined), undefined)
        assert.equal(split.IdpHold(JSON.stringify({ metadata: {} })), undefined)
        const hold = JSON.parse(split.IdpHold(JSON.stringify({ spec: { replicas: 0, template: { spec: { containers: [{ name: 'idp', image: 'old' }] } } } })) as string).items[0]
        assert.deepEqual([hold.metadata.labels, hold.spec.replicas, hold.spec.template.spec.containers[0].image], [{ a: 'b' }, 0, 'old'])
        const none = ConsoleBootstrapSplit.Of(JSON.stringify({ kind: 'List', items: [] }), SplitCase.Tenant)
        assert.equal(none.IdpDeployment, undefined)
        assert.equal(none.IdpHold(JSON.stringify({ spec: { template: {} } })), undefined)
    })
})
