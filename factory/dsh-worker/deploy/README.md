# Wednesday DSH deploy root

This build-time manifest supplies the workspace packages needed by Wednesday's DSH host and ACP worker, including their required peers. It is not a second application or an end-user installation command.

## Source and workspace copy

`package.json` in this directory is the source of truth. DSH is an ignored local checkout; its workspace member at `dsh/apps/wednesday-runtime/package.json` is a build input, not the authoritative copy.

From the Wednesday repository root, prepare the workspace member (PowerShell):

```powershell
New-Item -ItemType Directory -Force dsh/apps/wednesday-runtime
Copy-Item factory/dsh-worker/deploy/package.json dsh/apps/wednesday-runtime/package.json
```

Run `pnpm install` from `dsh/` after preparing or updating that member. This requires the DSH source/build environment; end users must not need to operate that workspace. The worker's built `lib/bin.js` and dependency build outputs are prerequisites for deployment.

## Check the manifest

From the Wednesday repository root:

```text
npx tsx factory/dsh-worker/deploy-test.ts
```

The check verifies workspace-copy dependency equality, all named plugins in `host.cordis.yml` and `cordis.yml`, host imports, the ACP worker entry package, and required workspace peers using DSH's `verifyRuntimeClosure`. A negative control removes Cordis and requires rejection. DSH's unrelated CLI-preset requirements are excluded; this is not a pass of the full upstream gate.

## Deployment status

The manifest has 63 direct dependencies; the upstream traversal inspects 64 workspace packages including transitive dependencies. Dependency-list validation and workspace installation have passed. A staged, relocated boot and clean-machine installation have NOT passed.

The next implementation should reuse `dsh/scripts/build-exe-for-python-sdk.ts`'s `deployStaging`, `restoreLegacyHoists`, and `materializeStagedLinks` pattern with this workspace member and its own `node_modules` as the restoration source. The deploy flags are:

```text
pnpm --filter wednesday-runtime-pkg deploy --legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true <staging-directory>
```

A deploy exit code alone is insufficient: restore omitted direct dependencies, materialize package links without copying package-local `node_modules`, reject remaining links, relocate the result, and prove host/ACP startup from an unrelated working directory. Keep native runtime assets and sandbox enforcement intact. Runtime execution paths remain unchanged until that proof exists.
