import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { OperatorContext } from '../../operator-context.js'
import { PortalDates } from '../../portal-dates.js'
import type { StaffOperatorDto } from '../../portal-types.js'

// One staff operator (signed in through the Pragmatic staff realm): email, the operator role the realm last gave, the
// last sign-in, whether they are disabled here, and Disable / Enable (the page runs it; full operators only; never on
// the signed-in operator's own row, which the console refuses).
export class StaffOperatorRowViewModel extends Observable
{
    private static readonly NoRoleLabel = 'No operator role'
    private static readonly ActiveLabel = 'Active'
    private static readonly DisabledLabel = 'Disabled'
    private static readonly DisableText = 'Disable'
    private static readonly EnableText = 'Enable'

    private readonly toggleCommand: RelayCommand

    public constructor(public readonly Record: StaffOperatorDto, toggle: RelayCommand, private readonly isSelf: boolean)
    {
        super()
        this.toggleCommand = new RelayCommand(() => toggle.Execute(this), () => !isSelf && toggle.CanExecute(this))
    }

    // The signed-in operator's own row: no Disable.
    public get ShowsToggle(): boolean
    {
        return !this.isSelf
    }

    public get Email(): string
    {
        return this.Record.email
    }

    public get RoleLabel(): string
    {
        switch (this.Record.role)
        {
            case OperatorContext.FullAppRole:
            case OperatorContext.ReadOnlyAppRole:
                return OperatorContext.FromAppRoles([this.Record.role]).RoleLabel
            default:
                return StaffOperatorRowViewModel.NoRoleLabel
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
