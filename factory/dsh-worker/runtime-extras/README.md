# Runtime seam extras

Vendored DeepSeek Harness seam packages that the CURRENT worker configuration
(`cordis.yml`) names and an OLDER published runtime closure does not contain.

## Why this directory exists

The worker configuration ships in this repository; the DSH runtime closure
ships separately, as the per-platform optional package
`@lab1207/wednesday-runtime-<platform>`. The two are versioned independently,
so a public install can end up with a configuration that names a plugin the
installed closure does not have. The worker then fails to load its plugin tree
(`plugin tree failed to load: failed to apply loader entry include
(cordis:include): loader entries failed to apply`) and NO task can run — the
install looks healthy and every run dies at the worker stage.

The only runtime closure on npm is
`@lab1207/wednesday-runtime-win32-x64@0.1.0-dev.0` (2026-09-20). It predates
the PowerShell seam: this repository's `cordis.yml` names
`@deepseek-ai/dsh-pwsh-local` and `@deepseek-ai/dsh-tool-pwsh` (the Windows
shell — `bash` on Windows is the WSL stub and cannot run under the sandbox), so
the published closure cannot load the configuration as written.

## What is here

Byte-exact copies (package.json, `lib/`, README) of two MIT packages, taken
from the closure this repository provisions
(`factory/dsh-worker/deploy/runtime`, DeepSeek Harness commit `aea6b3a100`):

- `@deepseek-ai/dsh-pwsh-local@0.1.1-rc.2`
- `@deepseek-ai/dsh-tool-pwsh@0.1.1-rc.2`

Every peer dependency of both packages is already present in the published
closure, so adding these two is enough for the worker plugin tree to load.

## How they are used

`factory/dsh-worker/runtime-extras.ts` copies any vendored package that is
MISSING from the installed runtime closure into that closure, before the worker
starts (`factory/dsh-worker/host.ts`). A package the closure already has is
never overwritten, and the copy is idempotent.

Copyright (c) 2026 DeepSeek. MIT. See `THIRD_PARTY_LICENSES.md` at the
repository root.
