// operator-sign-in.resources.mu - the operator sign-in page's view.
//
// Staff sign-in (the Pragmatic staff realm) is the primary action when the console offers it; the break-glass
// password form is the shared shell's sign-in page (AppShellResources renders SignInPageViewModel, password only)
// shown behind its disclosure. Without staff sign-in the password form shows directly. The notice line says why the
// last staff sign-in came back (no operator role, or it did not complete) or why the console cannot be reached.

import OperatorSignInViewModel from "./operator-sign-in-view-model.js"

resources OperatorSignInResources {
    DataTemplate [ DataType = OperatorSignInViewModel ] {
        Border [ Fill = @Bg1 ] {
            StackPanel [ Orientation = Vertical, HorizontalAlignment = Center, VerticalAlignment = Center ] {
                Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (24,24,24,24),
                         Visibility = $StaffSignInOffered << ToVisibility ] {
                    StackPanel [ Orientation = Vertical ] {
                        TextBlock [ Text = $ProductName, Style = @H3, Foreground = @Fg0 ]
                        TextBlock [ Text = "Operators sign in with their Pragmatic staff account.", Style = @Body, Foreground = @Fg2,
                                    Margin = (0,4,0,16) ]
                        TextBlock [ Text = $NoticeText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                    Margin = (0,0,0,16), Visibility = $NoticeText << ToVisibility ]
                        Button [ Variant = Filled, Command = $StaffSignInCommand, HorizontalAlignment = Left ] {
                            TextBlock [ Text = "Sign in with Pragmatic staff" ]
                        }
                        Button [ Variant = Text, Command = $ToggleBreakGlassCommand, HorizontalAlignment = Left, Margin = (0,16,0,0),
                                 Visibility = $ShowsBreakGlassToggle << ToVisibility ] {
                            TextBlock [ Text = $BreakGlassToggleText ]
                        }
                    }
                }
                TextBlock [ Text = $NoticeText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,16),
                            Visibility = $ShowsNoticeAbovePassword << ToVisibility ]
                ContentControl [ Content = $BreakGlass, Margin = (0,16,0,0), Visibility = $ShowsPasswordForm << ToVisibility ]
            }
        }
    }
}
