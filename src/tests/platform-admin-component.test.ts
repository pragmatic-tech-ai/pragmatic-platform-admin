import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlatformAdminComponent } from '../platform-admin-component.js'
import { TenantAdminEnv } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ComponentGolden } from './component-golden.js'
import { PlatformAdminGolden } from './platform-admin-golden.js'
import { ComponentSources } from './component-sources.js'

class PlatformAdminComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Readers = [['..', 'server.ts'], ['..', 'key-stores.ts'], ['..', 'infra-target-mode.ts'], ['..', 'hosted-kubeconfig.ts'], ['..', 'release', 'release-catalog-config.ts'], ['..', 'platform-admin-database.ts'], ['..', 'operator-sign-in', 'operator-oidc-settings.ts']].map(path => join(PlatformAdminComponentFixture.Here, ...path))
        .concat([join(dirname(fileURLToPath(import.meta.resolve('@pragmatic-tech-ai/pragmatic-platform-link'))), 'internal-api-link.js')])
    /**
     * PRAGMATIC_ADMIN_OPERATOR_PASSWORD: the inline alternative of operatorPassword (the declared source is the file).
     * PRAGMATIC_AGENT_CHANNEL_PORT: the console serves no agent channel (the edge image does); the port only names it.
     * PRAGMATIC_TENANT_PORTAL_DIR: a local-stack override of the co-hosted tenant plane's SPA folder, which the image does
     * not ship (declaring it would change the signed descriptor).
     */
    public static readonly Undeclared: readonly string[] = ['PRAGMATIC_ADMIN_OPERATOR_PASSWORD', 'PRAGMATIC_AGENT_CHANNEL_PORT', 'PRAGMATIC_TENANT_PORTAL_DIR']
    /** The co-hosted tenant plane reads its trusted-proxy flag through TenantAdminEnv.TrustedProxy. */
    public static readonly ReadThrough: readonly string[] = [TenantAdminEnv.TrustedProxy]
}

describe('PlatformAdminComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(PlatformAdminComponent.Descriptor(), PlatformAdminGolden.Fixture, PlatformAdminGolden.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(PlatformAdminComponent.Descriptor(), PlatformAdminComponentFixture.Readers, PlatformAdminComponentFixture.Undeclared, PlatformAdminComponentFixture.ReadThrough)
    })

    it('is named for its release image', () =>
    {
        assert.equal(PlatformAdminComponent.Descriptor().Name, 'pragmatic-platform-admin')
    })
})
