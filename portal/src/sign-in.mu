// sign-in.mu - the operator sign-in, a small application of its own.
//
// AppShellBoot imports this only when there is no session (or when the session probe fails, with the reason on the
// page); the shell (app.mu) is imported only when there is one. OperatorSignInHost owns the operator sign-in page view
// model (OperatorSignInResources renders it): staff sign-in through the Pragmatic staff realm first when the console
// offers it, the break-glass password form (the shared shell's page, rendered by AppShellResources: email and password
// as real browser inputs, Enter submits) behind its disclosure. A successful password sign-in reloads the page, which
// then boots the shell; staff sign-in leaves for the realm and comes back signed in.
//
// The page's ContentControl sits inside a Border root: a ContentControl as the application's root rendered nothing in
// the browser, so the root is plain chrome and the ContentControl its child.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import AppShellResources from "@pragmatic-tech-ai/pragmatic-app-shell"
import OperatorSignInResources from "./sign-in/operator-sign-in.resources.mu.js"
import OperatorSignInHost from "./sign-in/operator-sign-in-host.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        OperatorSignInHost
    }

    resources: {
        merge AppShellResources
        merge OperatorSignInResources

        Border x:root [ Fill = @Bg1 ] {
            ContentControl [ Content = $service(OperatorSignInHost).Page ]
        }
    }
}
