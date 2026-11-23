import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PortalDates } from '../../portal-dates.js'
import type { StaffOperatorDto } from '../../portal-types.js'

// One staff operator (signed in through the Pragmatic staff realm): email, the operator role the realm last gave, the
// last sign-in, whether they are disabled here, and Disable / Enable (the page runs it; full operators only).
export class StaffOperatorRowViewModel extends Observable
{
    private static readonly FullRole = 'operator.full'
    private static readonly ReadOnlyRole = 'operator.read-only'
    private static readonly OperatorLabel = 'Operator'
    private static readonly ObserverLabel = 'Observer'
    private static readonly NoRoleLabel = 'No operator role'
    private static readonly ActiveLabel = 'Active'
    private static readonly DisabledLabel = 'Disabled'
    private static readonly DisableText = 'Disable'
    private static readonly EnableText = 'Enable'

    private readonly toggleCommand: RelayCommand

    public constructor(public readonly Record: StaffOperatorDto, toggle: RelayCommand)
    {
        super()
        this.toggleCommand = new RelayCommand(() => toggle.Execute(this), () => toggle.CanExecute(this))
    }

    public get Email(): string
    {
        return this.Record.email
    }

    public get RoleLabel(): string
    {
        const R = StaffOperatorRowViewModel
        switch (this.Record.role)
        {
            case R.FullRole:
                return R.OperatorLabel
            case R.ReadOnlyRole:
                return R.ObserverLabel
            default:
                return R.NoRoleLabel
        }
    }

    public get LastSignInLabel(): string
    {
        return PortalDates.DateTimeLabel(this.Record.lastSignInAt)
    }

    public get StatusLabel(): string
    {
        return this.Record.disabled ? StaffOperatorRowViewModel.DisabledLabel : StaffOperatorRowViewModel.ActiveLabel
    }

    public get ToggleText(): string
    {
        return this.Record.disabled ? StaffOperatorRowViewModel.EnableText : StaffOperatorRowViewModel.DisableText
    }

    // Disables an active operator, enables a disabled one.
    public get ToggleCommand(): RelayCommand
    {
        return this.toggleCommand
    }
}
