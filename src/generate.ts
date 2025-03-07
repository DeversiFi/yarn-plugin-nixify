import { Filename, npath, PortablePath, ppath, xfs } from "@yarnpkg/fslib";
import { parseSyml } from "@yarnpkg/parsers";
import { patchUtils } from "@yarnpkg/plugin-patch";
import {
  computeFixedOutputStorePath,
  sanitizeDerivationName,
} from "./nixUtils";
import { json, indent, renderTmpl, upperCamelize } from "./textUtils";

import {
  Cache,
  execUtils,
  hashUtils,
  LocatorHash,
  Package,
  Project,
  Report,
  structUtils,
} from "@yarnpkg/core";

import defaultExprTmpl from "./tmpl/default.nix.in";
import projectExprTmpl from "./tmpl/yarn-project.nix.in";
import { tmpdir } from "os";

// Generator function that runs after `yarn install`.
export default async (project: Project, cache: Cache, report: Report) => {
  const { configuration, cwd } = project;

  // This case happens with `yarn dlx`, for example, and may cause errors if
  // special settings don't apply to those installations. (Like a `nixExprPath`
  // with a subdir that doesn't exist in the temporary project.)
  //
  // On macOS at least, we also need to get the real path of the OS temp dir,
  // because it goes through a symlink.
  const tempDir = await xfs.realpathPromise(npath.toPortablePath(tmpdir()));
  if (project.cwd.startsWith(tempDir)) {
    report.reportInfo(
      0,
      `Skipping Nixify, because ${project.cwd} appears to be a temporary directory`
    );
    return;
  }

  // Sanity checks.
  const yarnPathAbs = configuration.get(`yarnPath`);
  let yarnPath = ppath.relative(cwd, yarnPathAbs);
  if (yarnPath.startsWith(`../`)) {
    yarnPath = yarnPathAbs;
    report.reportWarning(
      0,
      `The Yarn path ${yarnPathAbs} is outside the project - it may not be reachable by the Nix build`
    );
  }

  const cacheFolderAbs = configuration.get(`cacheFolder`);
  let cacheFolder = ppath.relative(cwd, cacheFolderAbs);
  if (cacheFolder.startsWith(`../`)) {
    cacheFolder = cacheFolderAbs;
    report.reportWarning(
      0,
      `The cache folder ${cacheFolderAbs} is outside the project - it may not be reachable by the Nix build`
    );
  }

  for (const source of configuration.sources.values()) {
    if (!source.startsWith(`<`)) {
      const relativeSource = ppath.relative(cwd, source as PortablePath);
      if (relativeSource.startsWith(`../`)) {
        report.reportWarning(
          0,
          `The config file ${source} is outside the project - it may not be reachable by the Nix build`
        );
      }
    }
  }

  // Determine relative paths for Nix path literals.
  const nixExprPath = configuration.get(`nixExprPath`);
  const lockfileFilename = configuration.get(`lockfileFilename`);
  const lockfileRel = ppath.relative(
    ppath.dirname(nixExprPath),
    lockfileFilename
  );
  const yarnPathRel = ppath.relative(ppath.dirname(nixExprPath), yarnPath);

  // Build a list of cache entries so Nix can fetch them.
  // TODO: See if we can use Nix fetchurl for npm: dependencies.
  interface CacheEntry {
    filename: Filename;
    sha512: string;
  }
  const cacheEntries: Map<string, CacheEntry> = new Map();

  const cacheFiles = new Set(await xfs.readdirPromise(cache.cwd));
  const cacheOptions = { unstablePackages: project.conditionalLocators };
  for (const pkg of project.storedPackages.values()) {
    const { locatorHash } = pkg;
    const checksum = project.storedChecksums.get(locatorHash);
    const cachePath = cache.getLocatorPath(pkg, checksum || null, cacheOptions);
    if (!cachePath) continue;

    const filename = ppath.basename(cachePath);
    if (!cacheFiles.has(filename)) continue;

    const locatorStr = structUtils.stringifyLocator(pkg);
    const sha512 = checksum
      ? checksum.split(`/`).pop()!
      : await hashUtils.checksumFile(cachePath);
    cacheEntries.set(locatorStr, { filename, sha512 });
  }

  let cacheEntriesCode = `cacheEntries = {\n`;
  for (const [locatorStr, entry] of cacheEntries) {
    cacheEntriesCode += `${json(locatorStr)} = { ${[
      `filename = ${json(entry.filename)};`,
      `sha512 = ${json(entry.sha512)};`,
    ].join(` `)} };\n`;
  }
  cacheEntriesCode += `};`;

  // Generate Nix code for isolated builds.
  const isolatedBuilds = configuration.get(`isolatedNixBuilds`);
  let isolatedPackages = new Set<Package>();
  let isolatedIntegration = [];
  let isolatedCode = [];

  const nodeLinker = configuration.get(`nodeLinker`);
  const pnpUnpluggedFolder = configuration.get(`pnpUnpluggedFolder`);

  const collectTree = (pkg: Package, out: Set<string> = new Set()) => {
    const locatorStr = structUtils.stringifyLocator(pkg);
    if (cacheEntries.has(locatorStr)) {
      out.add(locatorStr);
    }

    if (structUtils.isVirtualLocator(pkg)) {
      const devirtPkg = project.storedPackages.get(
        structUtils.devirtualizeLocator(pkg).locatorHash
      );
      if (!devirtPkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`
        );
      }

      collectTree(devirtPkg, out);
    }

    if (pkg.reference.startsWith("patch:")) {
      const depatchPkg = project.storedPackages.get(
        patchUtils.parseLocator(pkg).sourceLocator.locatorHash
      );
      if (!depatchPkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`
        );
      }

      collectTree(depatchPkg, out);
    }

    for (const dependency of pkg.dependencies.values()) {
      const resolution = project.storedResolutions.get(
        dependency.descriptorHash
      );
      if (!resolution) {
        throw Error(
          "Assertion failed: The descriptor should have been registered"
        );
      }

      const depPkg = project.storedPackages.get(resolution);
      if (!depPkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`
        );
      }

      collectTree(depPkg, out);
    }

    return out;
  };

  for (const locatorHash of project.storedBuildState.keys()) {
    const pkg = project.storedPackages.get(locatorHash as LocatorHash);
    if (!pkg) {
      throw Error(`Assertion failed: The locator should have been registered`);
    }

    // TODO: Better options for matching.
    if (!isolatedBuilds.includes(pkg.name)) {
      continue;
    }

    // TODO: We can't currently support the node-modules linker, because it
    // always clears build state.
    let installLocation: PortablePath;
    switch (nodeLinker) {
      case `pnp`:
        installLocation = ppath.relative(
          project.cwd,
          ppath.join(
            pnpUnpluggedFolder,
            structUtils.slugifyLocator(pkg),
            structUtils.getIdentVendorPath(pkg)
          )
        );
        break;
      default:
        throw Error(
          `The nodeLinker ${nodeLinker} is not supported for isolated Nix builds`
        );
    }

    // Virtualization typically happens when the package has peer dependencies,
    // and thus it depends on context how the package is built. But we
    // eliminate that context, so devirtualize.
    let devirtPkg = pkg;
    if (structUtils.isVirtualLocator(devirtPkg)) {
      const { locatorHash } = structUtils.devirtualizeLocator(devirtPkg);
      const pkg = project.storedPackages.get(locatorHash);
      if (!pkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`
        );
      }
      devirtPkg = pkg;
    }

    const buildLocatorStr = structUtils.stringifyLocator(devirtPkg);
    const injectLocatorStr = structUtils.stringifyLocator(pkg);
    const isolatedProp = `isolated.${json(buildLocatorStr)}`;

    if (!isolatedPackages.has(devirtPkg)) {
      isolatedPackages.add(devirtPkg);

      const locators = [...collectTree(pkg)]
        .sort()
        .map((v) => `${json(v)}\n`)
        .join(``);

      const overrideArg = `override${upperCamelize(pkg.name)}Attrs`;
      isolatedCode.push(
        `${isolatedProp} = optionalOverride (args.${overrideArg} or null) (mkIsolatedBuild { ${[
          `pname = ${json(pkg.name)};`,
          `version = ${json(pkg.version)};`,
          `locators = [\n${locators}];`,
        ].join(` `)} });`
      );
    }

    if (isolatedIntegration.length === 0) {
      isolatedIntegration.push("# Copy in isolated builds.");
    }
    isolatedIntegration.push(
      `echo 'injecting build for ${pkg.name}'`,
      `yarn nixify inject-build \\`,
      `  ${json(injectLocatorStr)} \\`,
      `  $\{${isolatedProp}} \\`,
      `  ${json(installLocation)}`
    );
  }
  if (isolatedIntegration.length > 0) {
    isolatedIntegration.push(`echo 'running yarn install'`);
  }

  // Render the Nix expression.
  const ident = project.topLevelWorkspace.manifest.name;
  const projectName = ident ? structUtils.stringifyIdent(ident) : `workspace`;
  const projectExpr = renderTmpl(projectExprTmpl, {
    PROJECT_NAME: json(projectName),
    YARN_PATH: yarnPathRel,
    LOCKFILE: lockfileRel,
    CACHE_FOLDER: json(cacheFolder),
    CACHE_ENTRIES: cacheEntriesCode,
    ISOLATED: isolatedCode.join("\n"),
    ISOLATED_INTEGRATION: indent("      ", isolatedIntegration.join("\n")),
    NEED_ISOLATED_BUILD_SUPPRORT: isolatedIntegration.length > 0,
  });
  await xfs.writeFilePromise(configuration.get(`nixExprPath`), projectExpr);

  // Create a wrapper if it does not exist yet.
  if (configuration.get(`generateDefaultNix`)) {
    const defaultExprPath = ppath.join(cwd, `default.nix` as Filename);
    const flakeExprPath = ppath.join(cwd, `flake.nix` as Filename);
    if (!xfs.existsSync(defaultExprPath) && !xfs.existsSync(flakeExprPath)) {
      await xfs.writeFilePromise(defaultExprPath, defaultExprTmpl);
      report.reportInfo(
        0,
        `A minimal default.nix was created. You may want to customize it.`
      );
    }
  }

  // Preload the cache entries into the Nix store.
  if (
    configuration.get(`enableNixPreload`) &&
    xfs.existsSync(npath.toPortablePath(`/nix/store`))
  ) {
    await xfs.mktempPromise(async (tempDir) => {
      const toPreload: PortablePath[] = [];
      for (const [locator, { filename, sha512 }] of cacheEntries.entries()) {
        const name = sanitizeDerivationName(locator);
        // Check to see if the Nix store entry already exists.
        const hash = Buffer.from(sha512, "hex");
        const storePath = computeFixedOutputStorePath(name, `sha512`, hash);
        if (!xfs.existsSync(storePath)) {
          // The nix-store command requires a correct filename on disk, so we
          // prepare a temporary directory containing all the files to preload.
          //
          // Because some names may conflict (e.g. 'typescript-npm-xyz' and
          // 'typescript-patch-xyz' both have the same derivation name), we
          // create subdirectories based on hash.
          const subdir = ppath.join(tempDir, sha512.slice(0, 7) as Filename);
          await xfs.mkdirPromise(subdir);

          const src = ppath.join(cache.cwd, filename);
          const dst = ppath.join(subdir, name as Filename);
          await xfs.copyFilePromise(src, dst);

          toPreload.push(dst);
        }
      }

      try {
        // Preload in batches, to keep the exec arguments reasonable.
        const numToPreload = toPreload.length;
        while (toPreload.length !== 0) {
          const batch = toPreload.splice(0, 100);
          await execUtils.execvp(
            "nix-store",
            ["--add-fixed", "sha512", ...batch],
            {
              cwd: project.cwd,
              strict: true,
            }
          );
        }
        if (numToPreload !== 0) {
          report.reportInfo(
            0,
            `Preloaded ${numToPreload} packages into the Nix store`
          );
        }
      } catch (err: any) {
        // Don't break if there appears to be no Nix installation after all.
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    });
  }
};
