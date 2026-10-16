// Registers the real provider adapters with the W1 registry. Imported for its side effect by
// server.ts, so every adapter exists (but stays disabled) at startup. The built-in test stub
// registers itself from registry.ts when PROVIDERS_STUB is set, so that path keeps working.
//
// Registration metadata lives here (not on the adapter): `keyed` (Metron needs a bearer token),
// `minIntervalMs` (Metron's 20/min -> a conservative 3 s spacing) and `probe` (the admin test route).
import { METRON_MIN_INTERVAL_MS, createMetronProvider, metronProbe } from "./metron.js";
import { register } from "./registry.js";

register({
  provider: createMetronProvider(),
  keyed: true,
  minIntervalMs: METRON_MIN_INTERVAL_MS,
  probe: metronProbe,
});
