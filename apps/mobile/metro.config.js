// Expo + pnpm monorepo Metro config. There was no metro.config.js at all
// before.
//
// First attempt here added `disableHierarchicalLookup` + a custom
// `nodeModulesPaths` — that's the right recipe for a HOISTED monorepo
// (Yarn/npm workspaces, or pnpm with node-linker=hoisted), where every
// package's dependencies get flattened into one or two real node_modules
// folders. This workspace uses pnpm's DEFAULT isolated/symlinked layout
// instead: each package's own dependencies live nested inside that
// package's own folder under node_modules/.pnpm, reachable only by walking
// up the directory tree from wherever that package sits — which is exactly
// what `disableHierarchicalLookup` turns off. That's why
// `@expo/metro-runtime` (a nested dependency of expo-router, not hoisted
// anywhere) stopped resolving. Fixed by dropping that override and just
// telling Metro to follow pnpm's symlinks and watch the whole workspace.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole workspace (packages/shared, etc.), not just apps/mobile.
config.watchFolders = [workspaceRoot];

// pnpm's default layout is symlink-based — Metro needs this to actually
// follow them instead of treating symlinked packages as external/opaque.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
