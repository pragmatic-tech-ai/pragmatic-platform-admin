import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveHealth, HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { HiveBackend, InfraMode, IngressTlsSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { HiveObservationRecord } from '../../hive-observation-record.js'
import type { PlatformHiveRecord } from '../../platform-records.js'
import { HiveViews } from '../hive-views.js'

class ViewCases
{
    public static readonly Now = new Date('2026-11-23T12:00:00.000Z')
    public static readonly Image = 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server:0.1.0'
    public static readonly Hive: PlatformHiveRecord = {
        id: 'acme-hive', tenantId: 'acme-main', displayName: 'Hive', createdAt: '2026-11-01T00:00:00.000Z',
        cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach },
    }

    public static Report(ageMs: number, ready: readonly boolean[]): HiveObservationRecord
    {
        return {
            id: 'r', hiveId: ViewCases.Hive.id, reportedAt: new Date(ViewCases.Now.getTime() - ageMs).toISOString(),
            environments: ready.map((r, i) => ({ environmentName: 'env' + i, ready: r, runningImage: ViewCases.Image, detail: '' })),
        }
    }
}

describe('HiveViews', () =>
{
    const C = ViewCases
    const minute = 60 * 1000
    const table: ReadonlyArray<readonly [string, PlatformHiveRecord, HiveObservationRecord | undefined, HiveHealth]> = [
        ['no report is pending', C.Hive, undefined, HiveHealth.Pending],
        ['a fresh report, all ready, is healthy', C.Hive, C.Report(minute, [true, true]), HiveHealth.Healthy],
        ['a fresh report with no environment is healthy', C.Hive, C.Report(minute, []), HiveHealth.Healthy],
        ['a fresh report, one not ready, is degraded', C.Hive, C.Report(minute, [true, false]), HiveHealth.Degraded],
        ['a report between two and ten minutes old is degraded', C.Hive, C.Report(5 * minute, [true]), HiveHealth.Degraded],
        ['a report older than ten minutes is unreachable', C.Hive, C.Report(11 * minute, [true]), HiveHealth.Unreachable],
        ['a left hive is gone, whatever it reported', { ...C.Hive, leftAt: C.Now.toISOString() }, C.Report(minute, [true]), HiveHealth.Gone],
    ]
    for (const [name, hive, report, health] of table)
    {
        it(name, () =>
        {
            assert.equal(HiveViews.Of(hive, report, C.Now).Health, health)
        })
    }

    it('a hive without a level is hosted; home is the hive serving the console; environments carry name, readiness, image', () =>
    {
        const view = HiveViews.Of({ ...C.Hive, console: { baseDomain: 'acme.test', tls: { source: IngressTlsSource.Development } } } as PlatformHiveRecord, C.Report(minute, [true]), C.Now)
        assert.equal(view.Level, HiveLevel.Hosted)
        assert.equal(view.Home, true)
        assert.deepEqual(view.Environments.map(e => e.ToJson()), [{ Name: 'env0', Ready: true, Version: C.Image }])
        assert.equal(HiveViews.Of({ ...C.Hive, level: HiveLevel.Enrolled }, undefined, C.Now).Level, HiveLevel.Enrolled)
        assert.equal(HiveViews.Of(C.Hive, undefined, C.Now).Home, false)
    })
})
