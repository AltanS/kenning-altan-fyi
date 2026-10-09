import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // The whole route manifest ships as one hashed file in `assets/`, instead of
  // being discovered route by route through `/__manifest?paths=`. The service
  // worker precaches that file (scripts/build-precache.ts), so a client
  // navigation to a screen the reader never opened still works offline.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
