# Shared report limits must validate their acknowledgement

The REST Redis adapter accepted malformed successful responses through `payload.result || undefined`. Missing, null, zero, or false results therefore let a report reach image upload and GitHub issue creation without an acknowledged counter result.

The atomic Lua script returns exactly an empty string for allowance or one of the scopes submitted with that invocation. Validate that contract explicitly. Transport errors, non-JSON responses, explicit errors, malformed objects, and unknown scopes all return a typed 503 before any publication.

Behavioral regression tests exercise the real adapter through `processReport` and assert that neither image hosting nor issue creation occurs on invalid acknowledgements. The tests failed before the correction.

Vercel discovers files under `api/` as function entrypoints. Keep imported helpers prefixed with an underscore so deployment cannot expose them as additional endpoints.
