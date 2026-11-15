import type { RuntimeContext, RouteCollabExports, RouteOpsExports } from "../types/runtime-context.ts";
import { registerRoutesPartA } from "./routes/core.ts";
import { registerRoutesPartB } from "./routes/collab.ts";
import { registerRoutesPartC } from "./routes/ops.ts";
import { ROUTE_RUNTIME_HELPER_KEYS } from "./runtime-helper-keys.ts";
import { createPiiGuardMiddleware } from "../custom/pii-guard.ts";
import { registerCustomRoutes } from "../custom/routes.ts";

export function registerApiRoutes(ctx: RuntimeContext): RouteCollabExports & RouteOpsExports {
  const runtime: RuntimeContext = ctx;

  // [solo-company] block personal identifiers before they reach AI employees
  runtime.app.use(createPiiGuardMiddleware());

  Object.assign(runtime, registerRoutesPartB(runtime));
  Object.assign(runtime, registerRoutesPartA(runtime));
  Object.assign(runtime, registerRoutesPartC(runtime));

  // [solo-company] cost ledger / CEO approval endpoints
  registerCustomRoutes({ app: runtime.app, db: runtime.db, broadcast: runtime.broadcast });

  const routeHelpers = Object.fromEntries(ROUTE_RUNTIME_HELPER_KEYS.map((key) => [key, runtime[key]])) as Omit<
    RouteCollabExports,
    "DEPT_KEYWORDS"
  > &
    RouteOpsExports;

  return {
    DEPT_KEYWORDS: runtime.DEPT_KEYWORDS,
    ...routeHelpers,
  };
}
