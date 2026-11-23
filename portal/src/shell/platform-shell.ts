import { AppShellConfig, SignInMethod } from '@pragmatic-tech-ai/pragmatic-app-shell'

// What the platform admin console tells the shared client shell about itself: the product name, its two sign-in methods
// (staff sign-in through the Pragmatic staff realm, the console's OIDC begin, and the operators' break-glass password),
// the host's default session, login, logout and WebSocket-ticket routes, and the operator's own-password change at
// /api/session/password. Both methods are offered, so a signed-out visitor sees the sign-in page (never an automatic
// redirect); the page asks the console whether staff sign-in is on. BreakGlassConfig is the password-only form inside it.
export class PlatformShell
{
    private static readonly ProductName = 'Platform Admin'
    private static readonly ChangePasswordPath = '/api/session/password'

    public static readonly Config = new AppShellConfig({
        ProductName: PlatformShell.ProductName,
        SignInMethods: [SignInMethod.Oidc, SignInMethod.Password],
        Paths: { ChangePassword: PlatformShell.ChangePasswordPath },
    })

    public static readonly BreakGlassConfig = new AppShellConfig({
        ProductName: PlatformShell.ProductName,
        SignInMethods: [SignInMethod.Password],
        Paths: { ChangePassword: PlatformShell.ChangePasswordPath },
    })
}
