// hosts.resources.mu - the Hosts section's views.
//
// HostsPageViewModel (the host list) is presented full-width in the shell's
// content region, matched implicitly by type. Issue host code is the page's
// one action (operator.full); the code it answers is shown once by the shared
// one-time secret page (AppShellResources' template).
//
// The table uses a keyed row template set as the ListBox's ItemTemplate (a
// ListBox resolves implicit templates only for MuralBase items) and the shared
// PortalTable ListBox template.

import HostsPageViewModel from "./hosts-page-view-model.js"
import HostRowViewModel from "./hosts-page-view-model.js"

resources HostsResources {
    DataTemplate [ DataType = HostsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                Button [ DockPanel.Dock = Right, Variant = Primary, Command = $IssueCodeCommand, VerticalAlignment = Top ] {
                    TextBlock [ Text = "Issue host code" ]
                }
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Hosts", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Our machines that host Hosted hives. Each runs a host agent that reports its capacity and places the hives scheduled on it.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading hosts...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No host enrolled yet. Issue a host code and start a host agent with it.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    Grid [ Style = @PortalTableColumns ] {
                        RowDefinitions {
                            RowDefinition [ Height = GridLength.Auto ]
                        }
                        ColumnDefinitions {
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Machine", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Mesh address", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "Last report (UTC)", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 3, Text = "Free slots", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 4, Text = "Capacity", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 5, Text = "Placements", Style = @PortalTableHeader ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @HostRowTemplate ]
                }
            }
        }
    }

    // A host row.
    DataTemplate x:key="HostRowTemplate" [ DataType = HostRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            TextBlock [ Grid.Column = 0, Text = $Machine, Foreground = @Fg0, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 1, Text = $MeshAddress, Style = @Code, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $LastReportLabel, Style = @Code, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $SlotsLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $CapacityLabel, Foreground = @Fg1, VerticalAlignment = Center, TextWrapping = Wrap ]
            TextBlock [ Grid.Column = 5, Text = $PlacementsLabel, Foreground = @Fg1, VerticalAlignment = Center, TextWrapping = Wrap ]
        }
    }
}
