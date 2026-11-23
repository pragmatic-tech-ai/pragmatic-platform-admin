import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppShellConfig, SignInMethod, SignInPageViewModel, type IPageNavigator, type ISignInClient, type ISignInPage } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { OperatorSignInViewModel, type ISessionMethodsSource, type IStaffSignInClient } from '../operator-sign-in-view-model.js'
import { SessionMethodsClient } from '../session-methods-client.js'

/** The console's answer to GET /api/session/methods, or a failure. */
class FakeMethods implements ISessionMethodsSource
{
    public constructor(private readonly staff: boolean | Error)
    {
    }

    public async StaffSignInOffered(): Promise<boolean>
    {
        if (this.staff instanceof Error)
        {
            throw this.staff
        }
        return this.staff
    }
}

/** Records where the browser was sent. */
class FakeBrowser implements IPageNavigator, ISignInPage, IStaffSignInClient, ISignInClient
{
    public static readonly BeginPath = '/auth/oidc/begin'
    public readonly Assigned: string[] = []
    public Reloads = 0
    public Logins = 0

    public Assign(url: string): void
    {
        this.Assigned.push(url)
    }

    public Reload(): void
    {
        this.Reloads++
    }

    public BeginOidcSignIn(navigator: IPageNavigator): void
    {
        navigator.Assign(FakeBrowser.BeginPath)
    }

    public async PasswordLogin(): Promise<void>
    {
        this.Logins++
    }
}

class SignInFixture
{
    public static readonly ProductName = 'Platform Admin'
    public static readonly Watched: readonly string[] = ['ShowsPasswordForm', 'BreakGlassToggleText', 'ShowBreakGlass']
    public static readonly Password = new AppShellConfig({ ProductName: SignInFixture.ProductName, SignInMethods: [SignInMethod.Password] })

    public readonly Browser = new FakeBrowser()
    public readonly Page: OperatorSignInViewModel
    public readonly Raised: string[] = []

    public constructor(staff: boolean | Error)
    {
        const breakGlass = new SignInPageViewModel(SignInFixture.Password, this.Browser, this.Browser)
        this.Page = new OperatorSignInViewModel(SignInFixture.ProductName, breakGlass, new FakeMethods(staff), this.Browser, this.Browser)
        for (const name of SignInFixture.Watched)
        {
            this.Page.PropertyChanged(name).subscribe(() => { this.Raised.push(name) })
        }
    }

    public static async Loaded(staff: boolean | Error): Promise<SignInFixture>
    {
        const fixture = new SignInFixture(staff)
        await fixture.Page.Load()
        return fixture
    }
}

describe('OperatorSignInViewModel', () =>
{
    it('staff sign-in is the primary action when offered', async () =>
    {
        const f = await SignInFixture.Loaded(true)
        assert.equal(f.Page.StaffSignInOffered, true)
        assert.equal(f.Page.ShowsPasswordForm, false)
        assert.equal(f.Page.StaffSignInCommand.CanExecute(undefined), true)
        f.Page.StaffSignInCommand.Execute(undefined)
        assert.deepEqual(f.Browser.Assigned, [FakeBrowser.BeginPath])
        assert.equal(f.Page.IsBusy, true)
        assert.equal(f.Page.StaffSignInCommand.CanExecute(undefined), false, 'no second redirect while leaving')
        f.Page.BeginStaffSignIn()
        assert.equal(f.Browser.Assigned.length, 1)
    })

    it('break-glass is reachable behind its disclosure', async () =>
    {
        const f = await SignInFixture.Loaded(true)
        assert.equal(f.Page.ShowsBreakGlassToggle, true)
        assert.equal(f.Page.ShowBreakGlass, false)
        f.Page.ToggleBreakGlassCommand.Execute(undefined)
        assert.equal(f.Page.ShowBreakGlass, true)
        assert.equal(f.Page.ShowsPasswordForm, true)
        assert.ok(f.Raised.includes('ShowsPasswordForm') && f.Raised.includes('BreakGlassToggleText'))
        assert.equal(f.Page.BreakGlass.OffersPassword, true)
        assert.equal(f.Page.BreakGlass.OffersOidc, false)
        f.Page.BreakGlass.Email = 'owner@pragmatic.test'
        f.Page.BreakGlass.Password = 'the-break-glass-password'
        await f.Page.BreakGlass.PasswordSignIn()
        assert.equal(f.Browser.Logins, 1)
        assert.equal(f.Browser.Reloads, 1)
        f.Page.ToggleBreakGlassCommand.Execute(undefined)
        assert.equal(f.Page.ShowsPasswordForm, false)
    })

    it('without staff sign-in the password form shows directly', async () =>
    {
        const f = await SignInFixture.Loaded(false)
        assert.equal(f.Page.StaffSignInOffered, false)
        assert.equal(f.Page.ShowsPasswordForm, true)
        assert.equal(f.Page.ShowsBreakGlassToggle, false)
        assert.equal(f.Page.StaffSignInCommand.CanExecute(undefined), false)
        f.Page.BeginStaffSignIn()
        assert.deepEqual(f.Browser.Assigned, [])
    })

    it('a console that cannot say shows the password form', async () =>
    {
        const f = await SignInFixture.Loaded(new Error('down'))
        assert.equal(f.Page.StaffSignInOffered, false)
        assert.equal(f.Page.ShowsPasswordForm, true)
    })

    it('the 403 page names "no operator role" without detail', async () =>
    {
        const f = new SignInFixture(true)
        f.Page.ApplyMarker('?sign_in=forbidden&error=access_denied&detail=leaked')
        await f.Page.Load()
        assert.equal(f.Page.NoticeText, OperatorSignInViewModel.ForbiddenText)
        assert.match(f.Page.NoticeText, /no operator role/)
        assert.doesNotMatch(f.Page.NoticeText, /leaked|access_denied/)
        assert.equal(f.Page.ShowsNoticeAbovePassword, false, 'with staff sign-in the notice sits in the staff card')
    })

    it('a failed staff sign-in says so, and signing in again clears the notice', async () =>
    {
        const f = new SignInFixture(true)
        f.Page.ApplyMarker('?sign_in=failed')
        await f.Page.Load()
        assert.equal(f.Page.NoticeText, OperatorSignInViewModel.FailedText)
        f.Page.BeginStaffSignIn()
        assert.equal(f.Page.NoticeText, '')
    })

    it('an unknown marker is ignored; an unreachable console shows its reason above the password form', async () =>
    {
        const f = await SignInFixture.Loaded(false)
        f.Page.ApplyMarker('?sign_in=whatever')
        assert.equal(f.Page.NoticeText, '')
        f.Page.ShowError("Can't reach Platform Admin: boom")
        assert.equal(f.Page.ShowsNoticeAbovePassword, true)
    })
})

describe('SessionMethodsClient', () =>
{
    it('asks GET /api/session/methods with the page credentials and reads staff', async () =>
    {
        const calls: Array<{ url: string; init: RequestInit }> = []
        const client = new SessionMethodsClient(async (url, init) =>
        {
            calls.push({ url, init })
            return new Response(JSON.stringify({ staff: true }), { status: 200 })
        })
        assert.equal(await client.StaffSignInOffered(), true)
        assert.equal(calls[0]?.url, SessionMethodsClient.MethodsPath)
        assert.equal(calls[0]?.init.method, 'GET')
        assert.equal(calls[0]?.init.credentials, 'same-origin')
    })

    it('reads anything but staff true as no staff sign-in, and rejects on an HTTP error', async () =>
    {
        assert.equal(await new SessionMethodsClient(async () => new Response(JSON.stringify({ staff: 'yes' }), { status: 200 })).StaffSignInOffered(), false)
        await assert.rejects(new SessionMethodsClient(async () => new Response('', { status: 500 })).StaffSignInOffered())
    })
})
