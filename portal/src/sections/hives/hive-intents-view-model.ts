import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { OptionViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { ApiError } from '../../api-client.js'
import { PortalDates } from '../../portal-dates.js'
import type { IntentDto } from '../../portal-types.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// What the operator can ask a hive managed by pulls to do (the protocol's action kinds; a trust-root rotation carries a
// new platform key and is not published from here).
export enum IntentChoice
{
    CreateEnvironment = 'create-environment',
    UpdateEnvironment = 'update-environment',
    DeleteEnvironment = 'delete-environment',
    RepairEngine = 'repair-engine',
    RepairComponent = 'repair-component',
    RepairEnvironment = 'repair-environment',
    RotateHiveKey = 'rotate-hive-key',
    RenewConsoleCertificate = 'renew-console-certificate',
}

// One intent in plain words: what it asks, where it stands, when it expires; reissue when it expired or failed.
export class HiveIntentRowViewModel extends Observable
{
    private static readonly Kind = 'Kind'
    private static readonly Environment = 'Environment'
    private static readonly Version = 'Version'
    private static readonly Component = 'Component'
    private static readonly Purpose = 'Purpose'
    private static readonly Subject = 'Subject'
    private static readonly Scope = 'Scope'
    private static readonly Name = 'Name'
    private static readonly Sentences: Readonly<Record<string, string>> = {
        'component-at-version': 'Upgrade {component} to {version}',
        'create-environment': 'Create environment {environment} ({purpose})',
        'update-environment': 'Move environment {environment} to {version}',
        'delete-environment': 'Delete environment {environment}',
    }
    private static readonly RotateSentences: Readonly<Record<string, string>> = {
        'hive-key': 'Rotate the hive key',
        'ingress-certificate': 'Renew the console certificate',
        'trust-root': 'Rotate the platform trust root',
    }
    private static readonly RepairSentences: Readonly<Record<string, string>> = {
        engine: 'Repair the engine',
        component: 'Repair {name}',
        environment: 'Repair environment {name}',
    }
    private static readonly RotateKind = 'rotate'
    private static readonly RepairKind = 'repair'
    private static readonly Progress: Readonly<Record<string, string>> = {
        'awaiting-approval': "Waiting for the customer's approval",
        applying: 'Applying',
        applied: 'Applied',
        rejected: 'Rejected by the customer',
        failed: 'Failed',
        expired: 'Expired',
    }
    private static readonly NotPulled = 'Published, not pulled yet'
    private static readonly ExpiredLabel = 'Expired'
    private static readonly SupersededPrefix = 'Reissued as '
    private static readonly FailurePrefix = 'Failed: '
    private static readonly ExpiresPrefix = 'Expires '
    private static readonly ExpiredPrefix = 'Expired '
    private static readonly Token = /\{(component|version|environment|purpose|name)\}/g
    private static readonly FailedProgress = 'failed'
    private static readonly AwaitingProgress = 'awaiting-approval'
    private static readonly ExpiredProgress = 'expired'
    private static readonly ReissuableProgress: ReadonlySet<string | null> = new Set([null, HiveIntentRowViewModel.AwaitingProgress, HiveIntentRowViewModel.FailedProgress, HiveIntentRowViewModel.ExpiredProgress])

    public constructor(public readonly Intent: IntentDto, public readonly ReissueCommand: RelayCommand)
    {
        super()
    }

    public get Id(): string
    {
        return this.Intent.id
    }

    public get Sentence(): string
    {
        return HiveIntentRowViewModel.SentenceOf(this.Intent.action)
    }

    public get StatusLabel(): string
    {
        const R = HiveIntentRowViewModel
        const intent = this.Intent
        if (intent.supersededBy !== null)
        {
            return R.SupersededPrefix + intent.supersededBy
        }
        if (intent.progress === R.FailedProgress && intent.failure !== null)
        {
            return R.FailurePrefix + intent.failure
        }
        if ((intent.progress === null || intent.progress === R.AwaitingProgress) && intent.expired)
        {
            return R.ExpiredLabel
        }
        return intent.progress === null ? R.NotPulled : (R.Progress[intent.progress] ?? intent.progress)
    }

    public get ExpiryLabel(): string
    {
        const R = HiveIntentRowViewModel
        return (this.Intent.expired ? R.ExpiredPrefix : R.ExpiresPrefix) + PortalDates.Label(this.Intent.expiresAt)
    }

    public get LevelLabel(): string
    {
        return this.Intent.level
    }

    // Reissue applies to an intent that is not applied, rejected or reissued and has expired or failed.
    public get CanReissue(): boolean
    {
        const intent = this.Intent
        const R = HiveIntentRowViewModel
        return intent.supersededBy === null && R.ReissuableProgress.has(intent.progress) && (intent.expired || intent.progress === R.FailedProgress || intent.progress === R.ExpiredProgress)
    }

    // An action in plain words ("Upgrade pragmatic-tenant-admin to 0.1.13", "Create environment prod (runtime)").
    public static SentenceOf(action: Record<string, unknown>): string
    {
        const R = HiveIntentRowViewModel
        const kind = String(action[R.Kind])
        const template = kind === R.RotateKind ? R.RotateSentences[String(action[R.Subject])]
            : kind === R.RepairKind ? R.RepairSentences[String(action[R.Scope])]
                : R.Sentences[kind]
        if (template === undefined)
        {
            return kind
        }
        const values: Readonly<Record<string, unknown>> = {
            component: action[R.Component], version: action[R.Version], environment: action[R.Environment], purpose: action[R.Purpose], name: action[R.Name],
        }
        return template.replace(R.Token, (_match, key: string) => String(values[key] ?? ''))
    }
}

// The intents panel of a hive managed by pulls (C3.4): its intents newest first, a form that publishes one, reissue of
// an expired or failed one, and moving the hive to a release.
export class HiveIntentsViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'
    private static readonly BoundProperties = ['HasIntents', 'HasNoIntents', 'ErrorText', 'HasError', 'NoticeText', 'HasNotice', 'NeedsEnvironment', 'NeedsVersion', 'NeedsComponent', 'NeedsPurpose', 'SelectedChoice', 'SelectedPurpose', 'EnvironmentName', 'Version', 'ComponentName', 'LifetimeDays', 'ReleaseVersion', 'IsBusy'] as const
    private static readonly ChoiceLabels: readonly [IntentChoice, string][] = [
        [IntentChoice.CreateEnvironment, 'Create an environment'],
        [IntentChoice.UpdateEnvironment, 'Move an environment to a version'],
        [IntentChoice.DeleteEnvironment, 'Delete an environment'],
        [IntentChoice.RepairEngine, 'Repair the engine'],
        [IntentChoice.RepairComponent, 'Repair a component'],
        [IntentChoice.RepairEnvironment, 'Repair an environment'],
        [IntentChoice.RotateHiveKey, 'Rotate the hive key'],
        [IntentChoice.RenewConsoleCertificate, 'Renew the console certificate'],
    ]
    private static readonly PurposeLabels: readonly [string, string][] = [['development', 'Development'], ['runtime', 'Runtime']]
    private static readonly PublishedTemplate = 'Published: {sentence}.'
    private static readonly ReissuedTemplate = 'Reissued as {id}.'
    private static readonly ReleaseTemplate = 'Release {version} selected: the changed components were published as intents.'
    private static readonly SentenceToken = '{sentence}'
    private static readonly IdToken = '{id}'
    private static readonly VersionToken = '{version}'
    private static readonly LifetimeText = 'The lifetime must be a whole number of days from 1 to 30.'
    private static readonly DefaultLifetime = '7'
    private static readonly MinLifetime = 1
    private static readonly MaxLifetime = 30
    // The protocol's action members and values the form writes.
    private static readonly Wire = {
        Kind: 'Kind', Environment: 'Environment', Purpose: 'Purpose', Version: 'Version', Scope: 'Scope', Name: 'Name', Subject: 'Subject', NewTrustRoot: 'NewTrustRoot',
        CreateEnvironment: 'create-environment', UpdateEnvironment: 'update-environment', DeleteEnvironment: 'delete-environment', Repair: 'repair', Rotate: 'rotate',
        EngineScope: 'engine', ComponentScope: 'component', EnvironmentScope: 'environment', HiveKey: 'hive-key', IngressCertificate: 'ingress-certificate', Development: 'development',
    } as const
    private static readonly EnvironmentChoices: ReadonlySet<IntentChoice> = new Set([IntentChoice.CreateEnvironment, IntentChoice.UpdateEnvironment, IntentChoice.DeleteEnvironment, IntentChoice.RepairEnvironment])

    private readonly rows = new ObservableCollection<HiveIntentRowViewModel>()
    private readonly choices: ObservableCollection<OptionViewModel<IntentChoice>> = new ObservableCollection()
    private readonly purposes: ObservableCollection<OptionViewModel<string>> = new ObservableCollection()
    private readonly commands: RelayCommand[] = []
    private readonly publishCommand: RelayCommand
    private readonly selectReleaseCommand: RelayCommand
    private selectedChoice: OptionViewModel<IntentChoice> | undefined
    private selectedPurpose: OptionViewModel<string> | undefined
    private environmentName = ''
    private version = ''
    private componentName = ''
    private lifetimeDays = HiveIntentsViewModel.DefaultLifetime
    private releaseVersion = ''
    private errorText = ''
    private noticeText = ''
    private busy = false

    public constructor(private readonly session: PortalSessionService, public readonly HiveId: string)
    {
        super()
        for (const [value, label] of HiveIntentsViewModel.ChoiceLabels)
        {
            this.choices.Add(new OptionViewModel(value, label))
        }
        for (const [value, label] of HiveIntentsViewModel.PurposeLabels)
        {
            this.purposes.Add(new OptionViewModel(value, label))
        }
        this.selectedChoice = this.choices.Get(0)
        this.selectedPurpose = this.purposes.Get(0)
        this.publishCommand = this.Command(() => this.Publish(), () => this.CanPublish)
        this.selectReleaseCommand = this.Command(() => this.SelectRelease(), () => this.session.CanMutate && !this.busy && this.releaseVersion.trim() !== '')
    }

    public get Rows(): ObservableCollection<HiveIntentRowViewModel>
    {
        return this.rows
    }

    public get Choices(): ObservableCollection<OptionViewModel<IntentChoice>>
    {
        return this.choices
    }

    public get Purposes(): ObservableCollection<OptionViewModel<string>>
    {
        return this.purposes
    }

    public get SelectedChoice(): OptionViewModel<IntentChoice> | undefined
    {
        return this.selectedChoice
    }

    public set SelectedChoice(value: OptionViewModel<IntentChoice> | undefined)
    {
        this.Change(() => { this.selectedChoice = value })
    }

    public get SelectedPurpose(): OptionViewModel<string> | undefined
    {
        return this.selectedPurpose
    }

    public set SelectedPurpose(value: OptionViewModel<string> | undefined)
    {
        this.Change(() => { this.selectedPurpose = value })
    }

    public get EnvironmentName(): string
    {
        return this.environmentName
    }

    public set EnvironmentName(value: string)
    {
        this.Change(() => { this.environmentName = value })
    }

    public get Version(): string
    {
        return this.version
    }

    public set Version(value: string)
    {
        this.Change(() => { this.version = value })
    }

    public get ComponentName(): string
    {
        return this.componentName
    }

    public set ComponentName(value: string)
    {
        this.Change(() => { this.componentName = value })
    }

    public get LifetimeDays(): string
    {
        return this.lifetimeDays
    }

    public set LifetimeDays(value: string)
    {
        this.Change(() => { this.lifetimeDays = value })
    }

    public get ReleaseVersion(): string
    {
        return this.releaseVersion
    }

    public set ReleaseVersion(value: string)
    {
        this.Change(() => { this.releaseVersion = value })
    }

    public get NeedsEnvironment(): boolean
    {
        const choice = this.selectedChoice?.Value
        return choice !== undefined && HiveIntentsViewModel.EnvironmentChoices.has(choice)
    }

    public get NeedsVersion(): boolean
    {
        return this.selectedChoice?.Value === IntentChoice.UpdateEnvironment
    }

    public get NeedsPurpose(): boolean
    {
        return this.selectedChoice?.Value === IntentChoice.CreateEnvironment
    }

    public get NeedsComponent(): boolean
    {
        return this.selectedChoice?.Value === IntentChoice.RepairComponent
    }

    public get HasIntents(): boolean
    {
        return this.rows.Count > 0
    }

    public get HasNoIntents(): boolean
    {
        return this.rows.Count === 0
    }

    public get ErrorText(): string
    {
        return this.errorText
    }

    public get HasError(): boolean
    {
        return this.errorText !== ''
    }

    public get NoticeText(): string
    {
        return this.noticeText
    }

    public get HasNotice(): boolean
    {
        return this.noticeText !== ''
    }

    public get IsBusy(): boolean
    {
        return this.busy
    }

    public get PublishCommand(): RelayCommand
    {
        return this.publishCommand
    }

    public get SelectReleaseCommand(): RelayCommand
    {
        return this.selectReleaseCommand
    }

    public get CanPublish(): boolean
    {
        if (!this.session.CanMutate || this.busy || this.selectedChoice === undefined)
        {
            return false
        }
        if (this.NeedsEnvironment && this.environmentName.trim() === '')
        {
            return false
        }
        if (this.NeedsVersion && this.version.trim() === '')
        {
            return false
        }
        return !this.NeedsComponent || this.componentName.trim() !== ''
    }

    // The action the form describes, in the protocol's closed shape.
    public ActionOf(): Record<string, unknown>
    {
        const A = HiveIntentsViewModel.Wire
        const environment = this.environmentName.trim()
        switch (this.selectedChoice?.Value)
        {
            case IntentChoice.CreateEnvironment:
                return { [A.Kind]: A.CreateEnvironment, [A.Environment]: environment, [A.Purpose]: this.selectedPurpose?.Value ?? A.Development, [A.Version]: null }
            case IntentChoice.UpdateEnvironment:
                return { [A.Kind]: A.UpdateEnvironment, [A.Environment]: environment, [A.Version]: this.version.trim() }
            case IntentChoice.DeleteEnvironment:
                return { [A.Kind]: A.DeleteEnvironment, [A.Environment]: environment }
            case IntentChoice.RepairComponent:
                return { [A.Kind]: A.Repair, [A.Scope]: A.ComponentScope, [A.Name]: this.componentName.trim() }
            case IntentChoice.RepairEnvironment:
                return { [A.Kind]: A.Repair, [A.Scope]: A.EnvironmentScope, [A.Name]: environment }
            case IntentChoice.RotateHiveKey:
                return { [A.Kind]: A.Rotate, [A.Subject]: A.HiveKey, [A.NewTrustRoot]: null }
            case IntentChoice.RenewConsoleCertificate:
                return { [A.Kind]: A.Rotate, [A.Subject]: A.IngressCertificate, [A.NewTrustRoot]: null }
            default:
                return { [A.Kind]: A.Repair, [A.Scope]: A.EngineScope, [A.Name]: null }
        }
    }

    public async Load(): Promise<void>
    {
        try
        {
            const intents = await this.session.Client.ListHiveIntents(this.HiveId)
            this.Change(() =>
            {
                this.rows.Clear()
                for (const intent of intents)
                {
                    const command = new RelayCommand(() => { void this.Reissue(intent.id) }, () => this.session.CanMutate && !this.busy)
                    this.rows.Add(new HiveIntentRowViewModel(intent, command))
                }
            })
        }
        catch (error)
        {
            this.Fail(error)
        }
    }

    private async Publish(): Promise<void>
    {
        const V = HiveIntentsViewModel
        const days = Number(this.lifetimeDays.trim())
        if (!Number.isInteger(days) || days < V.MinLifetime || days > V.MaxLifetime)
        {
            this.Change(() => { this.errorText = V.LifetimeText })
            return
        }
        await this.Busy(async () =>
        {
            const published = await this.session.Client.PublishHiveIntent(this.HiveId, this.ActionOf(), days)
            this.noticeText = V.PublishedTemplate.replace(V.SentenceToken, HiveIntentRowViewModel.SentenceOf(published.action))
        })
    }

    private async Reissue(intentId: string): Promise<void>
    {
        const V = HiveIntentsViewModel
        await this.Busy(async () =>
        {
            const fresh = await this.session.Client.ReissueIntent(intentId)
            this.noticeText = V.ReissuedTemplate.replace(V.IdToken, fresh.id)
        })
    }

    private async SelectRelease(): Promise<void>
    {
        const V = HiveIntentsViewModel
        const version = this.releaseVersion.trim()
        await this.Busy(async () =>
        {
            await this.session.Client.SelectHiveRelease(this.HiveId, version)
            this.noticeText = V.ReleaseTemplate.replace(V.VersionToken, version)
        })
    }

    // Runs one request with the form locked; its refusal's sentence shows; the list reloads after.
    private async Busy(run: () => Promise<void>): Promise<void>
    {
        this.Change(() => { this.busy = true; this.errorText = ''; this.noticeText = '' })
        try
        {
            await run()
        }
        catch (error)
        {
            this.Fail(error)
        }
        finally
        {
            this.Change(() => { this.busy = false })
        }
        await this.Load()
    }

    private Fail(error: unknown): void
    {
        this.Change(() => { this.errorText = error instanceof ApiError || error instanceof Error ? error.message : String(error) })
    }

    private Command(execute: () => Promise<void>, canExecute: () => boolean): RelayCommand
    {
        const command = new RelayCommand(() => { void execute() }, canExecute)
        this.commands.push(command)
        return command
    }

    private Change(apply: () => void): void
    {
        const V = HiveIntentsViewModel
        const before = V.BoundProperties.map(name => Reflect.get(this, name) as unknown)
        apply()
        V.BoundProperties.forEach((name, i) =>
        {
            const now = Reflect.get(this, name) as unknown
            if (before[i] !== now)
            {
                this.RaisePropertyChanged(name, before[i], now)
            }
        })
        for (const command of this.commands)
        {
            command.RaiseCanExecuteChanged()
        }
        for (let i = 0; i < this.rows.Count; i++)
        {
            this.rows.Get(i)?.ReissueCommand.RaiseCanExecuteChanged()
        }
    }
}
