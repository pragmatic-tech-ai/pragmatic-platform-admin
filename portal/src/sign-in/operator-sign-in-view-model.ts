import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { AppShellConfig, type IPageNavigator, type SignInPageViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'

/** Whether the console offers staff sign-in (GET /api/session/methods). */
export interface ISessionMethodsSource
{
    StaffSignInOffered(): Promise<boolean>
}

/** Starts the staff sign-in: the browser leaves for the console's OIDC begin route (AppSessionClient is one). */
export interface IStaffSignInClient
{
    BeginOidcSignIn(navigator: IPageNavigator): void
}

/** Why the browser came back to the sign-in page: the `sign_in` marker the console's OIDC callback sets (`failed` is
 *  the shared shell's AppShellConfig.SignInFailedValue). */
export enum SignInMarker
{
    Forbidden = 'forbidden',
}

/**
 * The operator sign-in page. When the console offers staff sign-in (the Pragmatic staff realm, OIDC) it is the primary
 * action and the break-glass password form sits behind its disclosure (ShowBreakGlass); without staff sign-in the
 * password form shows directly. The password form is the shared shell's SignInPageViewModel over the password-only
 * configuration, so break-glass signs in exactly as before. A staff sign-in that came back refused for want of an
 * operator role shows the forbidden notice (no detail: the realm's answer is not repeated); one that did not complete
 * shows the failed notice and Sign in again begins a new one.
 */
export class OperatorSignInViewModel extends Observable
{
    private static readonly StaffSignInOfferedProperty = 'StaffSignInOffered'
    private static readonly ShowBreakGlassProperty = 'ShowBreakGlass'
    private static readonly ShowsPasswordFormProperty = 'ShowsPasswordForm'
    private static readonly ShowsBreakGlassToggleProperty = 'ShowsBreakGlassToggle'
    private static readonly BreakGlassToggleTextProperty = 'BreakGlassToggleText'
    private static readonly NoticeTextProperty = 'NoticeText'
    private static readonly ShowsNoticeAbovePasswordProperty = 'ShowsNoticeAbovePassword'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly ShowBreakGlassText = 'Use the break-glass password'
    private static readonly HideBreakGlassText = 'Hide the break-glass password'
    /** The 403 page's text: it names the missing operator role and nothing the realm said. */
    public static readonly ForbiddenText = 'Signed in, but your account has no operator role for this console.'
    public static readonly FailedText = "Staff sign-in didn't complete."
    private static readonly NoText = ''

    private staffSignInOffered = false
    private showBreakGlass = false
    private noticeText = OperatorSignInViewModel.NoText
    private isBusy = false
    private readonly staffSignInCommand: RelayCommand
    private readonly toggleBreakGlassCommand: RelayCommand

    public constructor(
        private readonly productName: string,
        private readonly breakGlass: SignInPageViewModel,
        private readonly methods: ISessionMethodsSource,
        private readonly staff: IStaffSignInClient,
        private readonly navigator: IPageNavigator)
    {
        super()
        this.staffSignInCommand = new RelayCommand(() => this.BeginStaffSignIn(), () => this.staffSignInOffered && !this.isBusy)
        // Never gated on IsBusy: break-glass stays reachable while (or after) a staff sign-in leaves the page.
        this.toggleBreakGlassCommand = new RelayCommand(() => this.ToggleBreakGlass(), () => this.staffSignInOffered)
    }

    public get ProductName(): string
    {
        return this.productName
    }

    /** The break-glass password form (the shared shell's sign-in page view model, password only). */
    public get BreakGlass(): SignInPageViewModel
    {
        return this.breakGlass
    }

    /** The console offers staff sign-in: it is the primary action. */
    public get StaffSignInOffered(): boolean
    {
        return this.staffSignInOffered
    }

    /** The break-glass disclosure is open. */
    public get ShowBreakGlass(): boolean
    {
        return this.showBreakGlass
    }

    /** The password form shows: always without staff sign-in, behind the disclosure with it. */
    public get ShowsPasswordForm(): boolean
    {
        return !this.staffSignInOffered || this.showBreakGlass
    }

    public get ShowsBreakGlassToggle(): boolean
    {
        return this.staffSignInOffered
    }

    public get BreakGlassToggleText(): string
    {
        return this.showBreakGlass ? OperatorSignInViewModel.HideBreakGlassText : OperatorSignInViewModel.ShowBreakGlassText
    }

    /** Why the last staff sign-in came back, or why the console could not be reached; '' when none. */
    public get NoticeText(): string
    {
        return this.noticeText
    }

    /** Without staff sign-in the notice sits above the password form (with it, inside the staff card). */
    public get ShowsNoticeAbovePassword(): boolean
    {
        return !this.staffSignInOffered && this.noticeText !== OperatorSignInViewModel.NoText
    }

    public get IsBusy(): boolean
    {
        return this.isBusy
    }

    public get StaffSignInCommand(): RelayCommand
    {
        return this.staffSignInCommand
    }

    public get ToggleBreakGlassCommand(): RelayCommand
    {
        return this.toggleBreakGlassCommand
    }

    /** Asks the console whether staff sign-in is offered; if it cannot say, only the password form shows. */
    public async Load(): Promise<void>
    {
        let offered: boolean
        try
        {
            offered = await this.methods.StaffSignInOffered()
        }
        catch
        {
            offered = false
        }
        this.Update(() => {
            this.staffSignInOffered = offered
        })
    }

    /** Shows what the page's query says the last staff sign-in did (`?sign_in=forbidden|failed`); anything else is ignored. */
    public ApplyMarker(search: string): void
    {
        if (AppShellConfig.IsSignInFailure(search))
        {
            this.ShowSignInFailed()
            return
        }
        if (new URLSearchParams(search).get(AppShellConfig.SignInFailedParam) === SignInMarker.Forbidden)
        {
            this.SetNotice(OperatorSignInViewModel.ForbiddenText)
        }
    }

    /** The last staff sign-in did not complete. */
    public ShowSignInFailed(): void
    {
        this.SetNotice(OperatorSignInViewModel.FailedText)
    }

    /** The page is shown again without a reload (the browser's back/forward cache after a staff sign-in left it, or a
     *  navigation that never happened): nothing is in flight any more. */
    public Resume(): void
    {
        this.Update(() => {
            this.isBusy = false
        })
    }

    /** Why the console could not start (the session probe failed): on the notice line. */
    public ShowError(text: string): void
    {
        this.SetNotice(text)
    }

    /** The browser leaves for the staff realm (through the console's OIDC begin route). */
    public BeginStaffSignIn(): void
    {
        if (!this.staffSignInOffered || this.isBusy)
        {
            return
        }
        this.Update(() => {
            this.isBusy = true
            this.noticeText = OperatorSignInViewModel.NoText
        })
        this.staff.BeginOidcSignIn(this.navigator)
    }

    private ToggleBreakGlass(): void
    {
        this.Update(() => {
            this.showBreakGlass = !this.showBreakGlass
        })
    }

    private SetNotice(text: string): void
    {
        this.Update(() => {
            this.noticeText = text
        })
    }

    /** Applies a change and raises every derived property that moved, then refreshes the commands. */
    private Update(change: () => void): void
    {
        const V = OperatorSignInViewModel
        const before = this.Snapshot()
        change()
        const after = this.Snapshot()
        const names = [V.StaffSignInOfferedProperty, V.ShowBreakGlassProperty, V.ShowsPasswordFormProperty, V.ShowsBreakGlassToggleProperty, V.BreakGlassToggleTextProperty, V.NoticeTextProperty, V.ShowsNoticeAbovePasswordProperty, V.IsBusyProperty]
        names.forEach((name, i) => {
            if (before[i] !== after[i])
            {
                this.RaisePropertyChanged(name, before[i], after[i])
            }
        })
        this.staffSignInCommand.RaiseCanExecuteChanged()
        this.toggleBreakGlassCommand.RaiseCanExecuteChanged()
    }

    /** The derived properties, in the order Update names them. */
    private Snapshot(): readonly (boolean | string)[]
    {
        return [this.StaffSignInOffered, this.ShowBreakGlass, this.ShowsPasswordForm, this.ShowsBreakGlassToggle, this.BreakGlassToggleText, this.NoticeText, this.ShowsNoticeAbovePassword, this.IsBusy]
    }
}
