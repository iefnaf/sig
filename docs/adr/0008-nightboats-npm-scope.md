# Nightboat npm scope

Status: superseded by [ADR-0012](0012-alexlikevibe-npm-scope.md) after the `nightboats` npm account lost publishing rights; the scope is now `@alexlikevibe`.

Before the connector's first npm release, the npm account and organization were created under the `nightboats` identity rather than reusing the GitHub source-host namespace `iefnaf`. The public package is therefore `@nightboats/sig`, while GitHub repository URLs and deployment identities remain unchanged. Choosing the npm-owned scope avoids implying that `iefnaf` owns the npm organization and keeps package publishing independent of where the source happens to be hosted.
