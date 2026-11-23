import type { Application, IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { AppShellBoot, BrowserPage, BrowserShellMount, type AppSession, type IPageReloader, type IShellApplications } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { ControlPlaneClient } from '../api-client.js'
import { PortalLiveUpdateBridge } from './portal-live-update-bridge.js'
import { OperatorSignInHost } from '../sign-in/operator-sign-in-host.js'
import { PortalSessionService } from './portal-session-service.js'

// The console's two compiled applications for the shell's boot: sign-in.mu when there is no session (or the probe
// failed, with the reason on its page), app.mu (the shell) when there is one. Each is imported only when needed. The
// sign-in page asks the console whether staff sign-in is on and shows what the page's query says the last staff sign-in
// did (`search`: the console's callback lands a refused or failed one on `/?sign_in=forbidden|failed`).
export class PortalApplications implements IShellApplications<Application>
{
    private static readonly LiveUpdateFailed = 'PortalBoot: live update failed'

    public constructor(private readonly client: ControlPlaneClient, private readonly reloader: IPageReloader, private readonly search: string = '')
    {
    }

    public async LoadSignIn(): Promise<Application>
    {
        const app = (await import('../sign-in.mu.js')).app
        await PortalApplications.PrepareSignIn(app.Services, this.search)
        return app
    }

    // The sign-in page before it mounts: the staff sign-in offer, and the last staff sign-in's outcome from the query.
    public static async PrepareSignIn(services: IServiceProvider, search: string): Promise<void>
    {
        const page = services.getRequired(OperatorSignInHost.Key).Page
        page.ApplyMarker(search)
        await page.Load()
    }

    public async LoadShell(): Promise<Application>
    {
        return (await import('../app.mu.js')).app
    }

    public ShowSignInError(app: Application, message: string): void
    {
        PortalApplications.ShowSignInError(app.Services, message)
    }

    /** Back from a staff sign-in that did not complete (`?sign_in=failed`): the sign-in page's own failed notice. */
    public ShowSignInFailed(app: Application, _message: string): void
    {
        app.Services.getRequired(OperatorSignInHost.Key).Page.ShowSignInFailed()
    }

    public StartShell(app: Application, session: AppSession): Promise<void>
    {
        return PortalApplications.StartShell(app.Services, this.client, session, this.reloader)
    }

    public Mount(app: Application): void
    {
        BrowserShellMount.Mount(app)
    }

    // The sign-in page's message when the session probe failed for a reason other than "not signed in".
    public static ShowSignInError(services: IServiceProvider, message: string): void
    {
        services.getRequired(OperatorSignInHost.Key).Page.ShowError(message)
    }

    // Wires the imported shell to the signed-in session. Importing app.mu.js composes the shell and activates the
    // first section before the session exists, so that section's first load fails. This initializes the session
    // (synchronously, before the first await), routes every control-plane change notification to the active section,
    // and resolves once the active section's page has reloaded with the session.
    public static async StartShell(services: IServiceProvider, client: ControlPlaneClient, session: AppSession, reloader: IPageReloader): Promise<void>
    {
        services.getRequired(PortalSessionService.Key).Initialize(client, session, reloader)
        const bridge = new PortalLiveUpdateBridge(services.getRequired(NavigationService.Key))
        client.OnChanged(() =>
        {
            bridge.OnEvent().catch((e: unknown) => console.error(PortalApplications.LiveUpdateFailed, e))
        })
        await bridge.OnEvent()
    }
}

// Boots the portal into a plain browser tab through the shell's boot: probes the session cookie, then mounts the
// sign-in page or the shell. Signing in, signing out and expiry reload the page, so each boot starts clean.
export class PortalBoot
{
    public static async Run(): Promise<void>
    {
        const client = new ControlPlaneClient()
        const page = new BrowserPage()
        const search = window.location.search
        await new AppShellBoot(client, new PortalApplications(client, page, search), page, search, window.location.pathname).Run()
    }
}
