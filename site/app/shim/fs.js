// Browser stand-in: there is no sage-config.json here, so the engine uses its built-in DEFAULT_POLICY.
export function readFileSync() { throw new Error('no filesystem in the browser'); }
