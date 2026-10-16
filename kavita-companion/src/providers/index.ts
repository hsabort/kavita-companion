// Register the real provider adapters with the W1 registry. Imported for its side effect by
// server.ts, so every adapter exists (but stays disabled) at startup. The built-in test stub
// registers itself from registry.ts when PROVIDERS_STUB is set, so that path keeps working.
//
// Registration metadata lives here (not on the adapter): `keyed` (Metron needs a bearer token; GCD is
// keyless but accepts an optional `user:pass` account key; MangaDex and AniList are keyless),
// `minIntervalMs` (the token bucket; the adapters narrow the configurable ones), `priority` (the
// fallback order within a media class — comics are Metron then GCD, manga is MangaDex then AniList) and
// `probe` (the admin test route).
import { ANILIST_MIN_INTERVAL_MS, createAnilistProvider, anilistProbe } from "./anilist.js";
import { GCD_MIN_INTERVAL_MS, createGcdProvider, gcdProbe } from "./gcd.js";
import { HARDCOVER_MIN_INTERVAL_MS, createHardcoverProvider, hardcoverProbe } from "./hardcover.js";
import { MANGADEX_MIN_INTERVAL_MS, createMangadexProvider, mangadexProbe } from "./mangadex.js";
import { METRON_MIN_INTERVAL_MS, createMetronProvider, metronProbe } from "./metron.js";
import { OPENLIBRARY_MIN_INTERVAL_MS, createOpenLibraryProvider, openlibraryProbe } from "./openlibrary.js";
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

register({
  provider: createMangadexProvider(),
  keyed: false,
  minIntervalMs: MANGADEX_MIN_INTERVAL_MS,
  priority: 10,
  probe: mangadexProbe,
});

register({
  provider: createAnilistProvider(),
  keyed: false,
  minIntervalMs: ANILIST_MIN_INTERVAL_MS,
  priority: 20,
  probe: anilistProbe,
});

register({
  provider: createHardcoverProvider(),
  keyed: true,
  minIntervalMs: HARDCOVER_MIN_INTERVAL_MS,
  priority: 10,
  probe: hardcoverProbe,
});

register({
  provider: createOpenLibraryProvider(),
  keyed: false,
  minIntervalMs: OPENLIBRARY_MIN_INTERVAL_MS,
  priority: 20,
  probe: openlibraryProbe,
});
