// Single source of truth for the connector version: the hello frame (protocol §6.1), the
// versioned asset filenames (install.ts), and `shepherd --version` all read this. It comes
// from package.json so a release cannot ship mismatched versions.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
