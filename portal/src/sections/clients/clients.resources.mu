// clients.resources.mu - the Clients section's views.
//
// ClientsPageViewModel (the list) and ClientDetailPageViewModel are presented
// full-width in the shell's content region; their templates are matched
// implicitly by type. Both are read-only: clients come from the clients
// ledger's entitlement statements (plan, state, limits, version; never a
// price), so there is nothing to create, edit or delete here.
//
// Table rows use keyed templates set as the ListBox's ItemTemplate: a ListBox
// resolves implicit-by-type templates only for MuralBase items, and the row
// view-models are Observables. Tables use the PortalTable ListBox template
// (shell resources) so rows span the table width.

import ClientsPageViewModel from "./clients-page-view-model.js"
import ClientRowViewModel from "./clients-page-view-model.js"
import ClientDetailPageViewModel from "./client-detail-page-view-model.js"
import ClientTenantRowViewModel from "./client-detail-page-view-model.js"

resources ClientsResources {
    DataTemplate [ DataType = ClientsPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Clients", Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Organisations and people the clients ledger states, with their plan and limits. Each has tenants; each tenant runs in exactly one hive.",
                                Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            // State presentation: loading, empty and error.
            TextBlock [ DockPanel.Dock = Top, Text = "Loading clients...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No clients yet. They appear once the clients ledger states them.",
                        Foreground = @Fg2, Visibility = $IsEmpty << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            // Populated: the clients table. The page scrolls header and rows
            // together, so both get the same width.
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
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                            ColumnDefinition [ Width = GridLength.Star ]
                        }
                        TextBlock [ Grid.Column = 0, Text = "Client", Style = @PortalTableLinkHeader ]
                        TextBlock [ Grid.Column = 1, Text = "Plan", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 2, Text = "State", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 3, Text = "Limits", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 4, Text = "Statement", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 5, Text = "Tenants", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 6, Text = "Hives", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 7, Text = "Connection", Style = @PortalTableHeader ]
                        TextBlock [ Grid.Column = 8, Text = "Client since", Style = @PortalTableHeader ]
                    }
                    ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows, ItemTemplate = @ClientRowTemplate ]
                }
            }
        }
    }

    // A clients-table row; the name opens the client's detail.
    DataTemplate x:key="ClientRowTemplate" [ DataType = ClientRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            Button [ Grid.Column = 0, Variant = Ghost, Command = $OpenCommand, HorizontalAlignment = Left ] {
                TextBlock [ Text = $DisplayName, Style = @UiLabel ]
            }
            TextBlock [ Grid.Column = 1, Text = $PlanLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 2, Text = $StateLabel, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 3, Text = $LimitsLabel, Foreground = @Fg1, TextWrapping = Wrap, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 4, Text = $VersionLabel, Foreground = @Fg2, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 5, Text = $TenantCountText, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 6, Text = $HiveCountText, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 7, Text = $ConnectionSummary, Foreground = @Fg1, VerticalAlignment = Center ]
            TextBlock [ Grid.Column = 8, Text = $ClientSinceLabel, Foreground = @Fg2, VerticalAlignment = Center ]
        }
    }

    DataTemplate [ DataType = ClientDetailPageViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            // Page header: back and the client.
            DockPanel [ DockPanel.Dock = Top, Margin = (0,0,0,16) ] {
                StackPanel [ Orientation = Vertical ] {
                    Button [ Variant = Ghost, Command = $BackCommand, HorizontalAlignment = Left, Margin = (0,0,0,8) ] {
                        TextBlock [ Text = "Back to clients" ]
                    }
                    TextBlock [ Text = $DisplayName, Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = $Id, Style = @Code, Foreground = @Fg2, Margin = (0,4,0,0) ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, Margin = (0,4,0,0),
                                Visibility = $DeniedReason << ToVisibility ]
                    TextBlock [ Text = $CommandErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,4,0,0),
                                Visibility = $CommandErrorText << ToVisibility ]
                }
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the client...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = $ErrorText, Foreground = @StateDangerInk,
                        TextWrapping = Wrap, Visibility = $IsError << ToVisibility ]

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    // Profile: what the clients ledger states (read-only).
                    Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                        StackPanel [ Orientation = Vertical ] {
                            Grid {
                                ColumnDefinitions {
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                    ColumnDefinition [ Width = GridLength.Star ]
                                }
                                StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                                    TextBlock [ Text = "Client id", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $Id, Style = @Code, Foreground = @Fg0 ]
                                }
                                StackPanel [ Grid.Column = 1, Orientation = Vertical ] {
                                    TextBlock [ Text = "Plan", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $PlanLabel, Foreground = @Fg0 ]
                                }
                                StackPanel [ Grid.Column = 2, Orientation = Vertical ] {
                                    TextBlock [ Text = "State", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $StateLabel, Foreground = @Fg0 ]
                                }
                                StackPanel [ Grid.Column = 3, Orientation = Vertical ] {
                                    TextBlock [ Text = "Statement", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $VersionLabel, Foreground = @Fg0 ]
                                }
                                StackPanel [ Grid.Column = 4, Orientation = Vertical ] {
                                    TextBlock [ Text = "Client since", Style = @UiCaption, Foreground = @Fg2 ]
                                    TextBlock [ Text = $ClientSinceLabel, Foreground = @Fg0 ]
                                }
                            }
                            TextBlock [ Text = "Limits", Style = @UiCaption, Foreground = @Fg2, Margin = (0,10,0,0) ]
                            TextBlock [ Text = $LimitsLabel, Foreground = @Fg0, TextWrapping = Wrap ]
                            TextBlock [ Text = "Customer admins", Style = @UiCaption, Foreground = @Fg2, Margin = (0,10,0,0) ]
                            TextBlock [ Text = $AdminsLabel, Foreground = @Fg0, TextWrapping = Wrap ]
                        }
                    }

                    // Tenants and their hives.
                    TextBlock [ Text = "Tenants and hives", Style = @UiLabel, Foreground = @Fg1, Margin = (0,0,0,6) ]
                    TextBlock [ Text = "No tenants yet. Create one in Tenants.", Foreground = @Fg2,
                                Visibility = $HasNoTenants << ToVisibility ]
                    StackPanel [ Orientation = Vertical, Visibility = $HasTenants << ToVisibility ] {
                        Grid [ Style = @PortalTableColumns ] {
                            ColumnDefinitions {
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                                ColumnDefinition [ Width = GridLength.Star ]
                            }
                            TextBlock [ Grid.Column = 0, Text = "Tenant", Style = @PortalTableHeader ]
                            TextBlock [ Grid.Column = 1, Text = "Hive", Style = @PortalTableHeader ]
                            TextBlock [ Grid.Column = 2, Text = "Connection", Style = @PortalTableHeader ]
                            TextBlock [ Grid.Column = 3, Text = "Last check-in", Style = @PortalTableHeader ]
                            TextBlock [ Grid.Column = 4, Text = "Environments (observed)", Style = @PortalTableHeader ]
                        }
                        ListBox [ Style = @PortalTableList, HorizontalAlignment = Stretch, ItemsSource = $Tenants, ItemTemplate = @ClientTenantRowTemplate ]
                    }
                }
            }
        }
    }

    DataTemplate x:key="ClientTenantRowTemplate" [ DataType = ClientTenantRowViewModel ] {
        Grid [ Style = @PortalTableColumns ] {
            ColumnDefinitions {
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
                ColumnDefinition [ Width = GridLength.Star ]
            }
            StackPanel [ Grid.Column = 0, Orientation = Vertical ] {
                TextBlock [ Text = $TenantName, Style = @UiLabel, Foreground = @Fg0 ]
                TextBlock [ Text = $TenantId, Style = @UiCaption, Foreground = @Fg2 ]
            }
            TextBlock [ Grid.Column = 1, Text = $HiveName, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 2, Text = $ConnectionLabel, Foreground = @Fg1 ]
            TextBlock [ Grid.Column = 3, Text = $LastSeenLabel, Foreground = @Fg2 ]
            TextBlock [ Grid.Column = 4, Text = $EnvCountText, Foreground = @Fg2 ]
        }
    }
}
