# Published OpenAPI Artifacts (PREWAVE-BE-009)

`docs/openapi/manifest.json` is the pinned, content-addressed index of the
reviewed OpenAPI documents and frontend fixtures this API publishes. It exists
so a frontend can pin **one immutable artifact version** instead of drifting
against hand-maintained DTO copies.

## Published sets

| Schema version | OpenAPI document | Fixtures |
| --- | --- | --- |
| `public-status.v1` | `docs/public-status/openapi.json` | `docs/public-status/fixtures.json` |
| `public-incidents.v1` | `docs/public-incidents/openapi.json` | `docs/public-incidents/fixtures.json` |

Each set is generated from the reviewed code by its artifact spec, and the
generation is deterministic: the specs render fixed scenario clocks, so two
clean generations produce byte-identical files.

## Commands

```bash
npm run openapi:publish      # rewrite the manifest from the current files
npm run openapi:regenerate   # run the generator specs, then rewrite the manifest
npm run openapi:check        # fail if a file no longer matches its checksum
```

`npm run openapi:publish` never runs the generators, so it is safe on a machine
without the test toolchain. `npm run openapi:regenerate` is the only mode that
runs them.

## Manifest format

```json
{
  "schemaVersion": "openapi-artifacts.v1",
  "artifacts": [
    {
      "path": "docs/public-status/openapi.json",
      "schemaVersion": "public-status.v1",
      "sizeBytes": 28692,
      "sha256": "<sha256 of the exact file bytes>"
    }
  ]
}
```

The manifest is content-derived only — it carries no commit id and no
timestamp — so regeneration on an unchanged tree is byte-identical and the CI
generated-artifact drift check stays stable.

## Fail-closed rules

- An artifact that is missing, not valid JSON, or not listed in the manifest
  fails publication and verification.
- An artifact containing `localhost`, `127.0.0.1` or `0.0.0.0` fails
  publication: generated artifacts must never embed an environment endpoint.
- A checksum mismatch fails `npm run openapi:check`; CI runs this after the
  existing generated-artifact drift check, so a schema change without a
  regenerated manifest cannot merge.
- Breaking changes to a published set require bumping its `schemaVersion`
  (for example `public-status.v2`) and its fixtures in the same change.

## Consumer pinning

Pin the artifact set by `schemaVersion` plus the manifest `sha256` values. If a
downloaded file's checksum does not match the pinned manifest, the consumer must
treat the response as unavailable rather than using stale or ambiguous data.
