import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { FakeControlPlane, PortalTestHost } from '../../../shell/tests/portal-test-fixtures.js'
import { HiveIntentRowViewModel, HiveIntentsViewModel, IntentChoice } from '../hive-intents-view-model.js'

class IntentsFixture
{
    public readonly Api = new FakeControlPlane()
    public readonly Host = new PortalTestHost(this.Api.AsClient())
    public readonly Panel = new HiveIntentsViewModel(this.Host.Session, 'hv0000000001')

    public Choose(choice: IntentChoice): void
    {
        for (let i = 0; i < this.Panel.Choices.Count; i++)
        {
            const option = this.Panel.Choices.Get(i)
            if (option?.Value === choice)
            {
                this.Panel.SelectedChoice = option
            }
        }
    }
}

describe('HiveIntentsViewModel', () =>
{
    it('each action kind renders its sentence', () =>
    {
        const S = (action: Record<string, unknown>): string => HiveIntentRowViewModel.SentenceOf(action)
        assert.equal(S({ Kind: 'component-at-version', Component: 'pragmatic-tenant-admin', Version: '0.1.13' }), 'Upgrade pragmatic-tenant-admin to 0.1.13')
        assert.equal(S({ Kind: 'create-environment', Environment: 'prod', Purpose: 'runtime', Version: null }), 'Create environment prod (runtime)')
        assert.equal(S({ Kind: 'update-environment', Environment: 'prod', Version: '0.1.0-early.20' }), 'Move environment prod to 0.1.0-early.20')
        assert.equal(S({ Kind: 'delete-environment', Environment: 'old' }), 'Delete environment old')
        assert.equal(S({ Kind: 'rotate', Subject: 'hive-key', NewTrustRoot: null }), 'Rotate the hive key')
        assert.equal(S({ Kind: 'rotate', Subject: 'ingress-certificate', NewTrustRoot: null }), 'Renew the console certificate')
        assert.equal(S({ Kind: 'repair', Scope: 'engine', Name: null }), 'Repair the engine')
        assert.equal(S({ Kind: 'repair', Scope: 'environment', Name: 'prod' }), 'Repair environment prod')
    })

    it('publishes the form\'s closed action with its lifetime and lists it; an environment kind needs a name', async () =>
    {
        const f = new IntentsFixture()
        f.Choose(IntentChoice.CreateEnvironment)
        assert.equal(f.Panel.CanPublish, false)
        f.Panel.EnvironmentName = 'prod'
        f.Panel.LifetimeDays = '3'
        assert.equal(f.Panel.CanPublish, true)
        f.Panel.PublishCommand.Execute(undefined)
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => setTimeout(resolve, 0))
        assert.deepEqual(f.Api.PublishedIntents, [['hv0000000001', { Kind: 'create-environment', Environment: 'prod', Purpose: 'development', Version: null }, 3]])
        assert.equal(f.Panel.Rows.Count, 1)
        assert.equal(f.Panel.NoticeText, 'Published: Create environment prod (development).')
    })

    it('an expired or failed intent offers reissue; an applied one does not; a refusal shows its sentence', async () =>
    {
        const f = new IntentsFixture()
        f.Api.Intents = [
            FakeControlPlane.Intent('inaaaaaaaaaaaa', { Kind: 'delete-environment', Environment: 'old' }, null, true),
            FakeControlPlane.Intent('inbbbbbbbbbbbb', { Kind: 'delete-environment', Environment: 'old' }, 'applied'),
        ]
        await f.Panel.Load()
        assert.equal(f.Panel.Rows.Get(0)?.CanReissue, true)
        assert.equal(f.Panel.Rows.Get(0)?.StatusLabel, 'Expired')
        assert.equal(f.Panel.Rows.Get(1)?.CanReissue, false)
        assert.equal(f.Panel.Rows.Get(1)?.StatusLabel, 'Applied')
        f.Api.IntentFailure = new ApiError(409, 'This hive is not managed by pulled intents.', 'hive-takes-no-intents')
        f.Choose(IntentChoice.RepairEngine)
        f.Panel.PublishCommand.Execute(undefined)
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => setTimeout(resolve, 0))
        assert.equal(f.Panel.ErrorText, 'This hive is not managed by pulled intents.')
    })
})
