// Registers the real provider adapters with the W1 registry. Imported for its side effect by
// server.ts, so every adapter exists (but stays disabled) at startup. The built-in test stub
// registers itself from registry.ts when PROVIDERS_STUB is set, so that path keeps working.
//
// Registration metadata lives here (not on the adapter): `keyed` (Metron needs a bearer token; GCD is
// keyless but accepts an optional `user:pass` account key), `minIntervalMs` (the token bucket; the
// adapter narrows GCD's spacing when a key is present), `priority` (the fallback order within a media
// class — comics are Metron then GCD) and `probe` (the admin test route).
import { GCD_MIN_INTERVAL_MS, createGcdProvider, gcdProbe } from "./gcd.js";
import { METRON_MIN_INTERVAL_MS, createMetronProvider, metronProbe } from "./metron.js";
import { register } from "./registry.js";

register({
  provider: createMetronProvider(),
  keyed: true,
  minIntervalMs: METRON_MIN_INTERVAL_MS,
  priority: 10,
  probe: metronProbe,
});

register({
  provider: createGcdProvider(),
  keyed: false,
  minIntervalMs: GCD_MIN_INTERVAL_MS,
  priority: 20,
  probe: gcdProbe,
});
