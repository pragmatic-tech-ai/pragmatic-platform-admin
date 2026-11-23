import { ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { AppSessionClient, BrowserPage, SignInPageViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { PlatformShell } from '../shell/platform-shell.js'
import { OperatorSignInViewModel } from './operator-sign-in-view-model.js'
import { SessionMethodsClient } from './session-methods-client.js'

// Hosts the operator sign-in page for sign-in.mu, the small application booted when there is no session: staff sign-in
// (the console's OIDC begin) first, the break-glass password form (the shared shell's page over the password-only
// configuration) behind its disclosure.
export class OperatorSignInHost extends ServiceBase
{
    public static readonly Key = new ServiceKey<OperatorSignInHost>('OperatorSignInHost')
    private static readonly PageShowEvent = 'pageshow'

    private readonly page: OperatorSignInViewModel

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        const browser = new BrowserPage()
        const breakGlass = new SignInPageViewModel(PlatformShell.BreakGlassConfig, new AppSessionClient(PlatformShell.BreakGlassConfig), browser)
        this.page = new OperatorSignInViewModel(PlatformShell.Config.ProductName, breakGlass, new SessionMethodsClient(), new AppSessionClient(PlatformShell.Config), browser)
        // Back from the realm through the back/forward cache: the page is live again, nothing is in flight.
        if (typeof window !== 'undefined')
        {
            window.addEventListener(OperatorSignInHost.PageShowEvent, () => this.page.Resume())
        }
    }

    public get Page(): OperatorSignInViewModel
    {
        return this.page
    }
}
