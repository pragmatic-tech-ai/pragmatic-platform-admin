import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { EngineInstallCommand, InvalidInstallReleaseError } from '../engine-install-command.js'

class CommandCases
{
    public static readonly Release = '0.1.0-early.7'
    public static readonly Expected = 'helm install pragmatic-engine oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine --version 0.1.0-early.7 --namespace pragmatic-system --create-namespace'
    public static readonly StandaloneSuffix = ' --set level=standalone'
    public static readonly Unsafe = '0.1.0; rm -rf /'
    public static readonly CodePrefix = 'pe1-'
}

describe('EngineInstallCommand', () =>
{
    const C = CommandCases
    it('enrolled and delegated install the chart at the release, no level flag', () =>
    {
        assert.equal(EngineInstallCommand.For(HiveLevel.Enrolled, C.Release), C.Expected)
        assert.equal(EngineInstallCommand.For(HiveLevel.Delegated, C.Release), C.Expected)
    })

    it('install command for standalone carries --set level=standalone and no code', () =>
    {
        const command = EngineInstallCommand.For(HiveLevel.Standalone, C.Release)
        assert.equal(command, C.Expected + C.StandaloneSuffix)
        assert.ok(!command.includes(C.CodePrefix))
    })

    it('a release that is not a version is refused', () =>
    {
        assert.throws(() => EngineInstallCommand.For(HiveLevel.Enrolled, C.Unsafe), InvalidInstallReleaseError)
    })
})
