/**
 * Hono context augmentation.
 *
 * We deliberately avoid `new Hono<AppEnv>()` on the shared app instance: the
 * custom env generic propagates into every helper typed as plain `Hono`
 * (e.g. `registerDashboardRoutes`) and produces a cascade of type errors.
 *
 * Declaring the variable here instead lets `c.set('apiKeyId', ...)` type-check
 * while the app stays a plain `Hono`.
 */
declare module 'hono' {
  interface ContextVariableMap {
    /** Managed API key id, set when a request authenticates with a managed key. */
    apiKeyId: string;
  }
}

export {};
