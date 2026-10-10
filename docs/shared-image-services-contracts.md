# Shared image service v1 — Stage D/E/F conventions

Tracking issue: https://github.com/xnmp/tauri-explorer/issues/1047.

Pure validation/state transitions live in domain modules. Native IO is bounded and owned; database/lifecycle/startup locks end before byte copies, provider IO or reverse callbacks. Svelte components render services/state. Use bun. No paid requests, publication or user-app installation. Agents edit only their assigned worktree using relative paths and verify merge-base against the actual target. The coordinator owns manifest/SDK shapes, broker routing/startup/timeouts/lifecycle, shared identities, job contracts and this protocol. Store/provider implementers must not invent variants.

## Versions and routing

SDK 3 adds service exports/dependencies; SDK 1/2 remain accepted. Capabilities: pluginServices, serviceArtifacts; initialization serviceService:{version:1}, artifactService:{version:1}, credentialService:{version:1}, jobService:{version:1}. Native-owned provider dispatch: services.image-generation.v1.METHOD. Service methods: describe, prepare, start, status, cancel, acknowledge.

Reverse host.services.describe takes {packageId,serviceId,major}; result {version:1,available,reason?:safeError,target:{packageId,serviceId,major},providerDigest?:string}.
Reverse host.services.invoke takes {packageId,serviceId,major,method,params}. Host verifies the consumer's manifest dependency and provider export, then supplies {caller:{packageId,packageDigest,incarnation},request:params} to the provider. No caller fields supplied by consumers are trusted. Describe/version selection and read-only status cannot dispatch generation. Frontend service facade routes through consumer backend; never raw native arbitrary provider RPC.

## Durable host store

Private host service-state directory, metadata SQLite journal and sealed bytes share ownership coordination. Tables retain admissions/tombstones, artifact reservations/grants, handoff dispositions and native job bindings; corruption/newer schema fail closed. Reconstruct claims before upgrade recovery/pending installs. Initial bounds: 2GiB artifact reservation+sealed bytes, 64 unresolved execution/transfer operations globally, 16 per consumer, 8 captures/op, 20MiB/input, 64MiB inputs/op, 50MiB output. Tests inject smaller quotas. Reservation precedes IO; no age eviction of admitted/unacknowledged bytes.

Admission key (consumerPackageId,operationId) survives broker restart. Generations have packageId,digest,incarnation. Phases reserved→forwarding→accepted→terminal→released; persisted forwarding before start. Same ID/fingerprint returns original record, conflict fails. Anything forwarding-or-later recovers with status and is never forwarded start again automatically. Both consumer/provider package digests stay pinned through nonterminal or succeeded-unacknowledged transfer. Unknown can release execution after durable needs-attention + no live owned worker; evidence references remain. Tombstones alone never busy. Discard/import are explicit durable dispositions.

## Artifact methods

host.artifacts.capture {operationId,inputs:[{path,expectedDigest?:string}]} → {inputs:[{sourcePath,artifact:Descriptor,width,height}]}.
Descriptor {handle,sha256,byteLength,mediaType}; handles opaque crypto IDs, no filesystem paths. Capture opens regular input safely, reads once under limits, detects format/dimensions, hashes/stores that same sealed snapshot. Returned sourcePath canonical via dunce.
host.artifacts.stage {consumerPackageId,operationId} → {handle,path}; only the pinned provider can obtain its host-generated output stage path after forwarding intent.
host.artifacts.seal {consumerPackageId,operationId,handle,mediaType} → Descriptor; safely copy immutable validated bytes, commit metadata before return; no arbitrary returned provider path accepted.
host.artifacts.read {consumerPackageId?:string,operationId,artifact:Descriptor} → {path,artifact:Descriptor}; owner/grant/descriptor verified against metadata and bytes. Consumer can read captured inputs or granted result; provider can read inputs named in its pinned admission and its outputs. Returned private path has operation lifetime; native plugins share user OS privileges.
host.artifacts.acquired {operationId,artifact:Descriptor,evidencePath:string} → {transferReceipt:string}; verify consumer-owned recoverable local copy matches descriptor, retain durable evidence/disposition; no provider-byte release yet.
host.artifacts.release {operationId} only frees provably never-forwarded captures/preparations; cannot discard an admitted result or erase tombstone.
Host verifies transferReceipt/output identity when forwarding acknowledge. After authoritative provider acquired/discarded status, durable host released/disposition commit precedes freeing redundant bytes. Discard is per-operation explicit; closing renderer never discard.

## Image provider

Package xnmp.image-generation, settings contribution image-generation, independent Rust backend operations.sqlite and versioned profiles, never Trace imports/data.
Image configuration {schemaVersion:1,documentRevision,defaultConnectionId:null|string,profiles:[]}. CLI profile {id,name,recipeRevision,transport:codex-cli,executablePath,modelSelection:false,credential:{kind:cli_saved_login}}. HTTP profile {id,name,recipeRevision,transport:openai-images,baseUrl,defaultModel,allowInsecureHttp,credential:none|environment{name}|secret{id}}. Profile recipeRevision changes for execution/credential changes, not rename or unrelated edits. Empty is unconfigured.
HTTP base root includes images resource (e.g. https://api.openai.com/v1/images); append generations/edits. No userinfo/query/fragment/redirects/retries. Free model strings. Initial outputs single base64 PNG, no arbitrary remote image URLs. Keep existing byte/pixel limits and ordered equal-input framing.
describe returns {version:1,configurationRevision,defaultConnectionId,profiles:[sanitized profiles with capabilities]}. Capabilities fixed initial adapter policy: generation/edit,8input max bytes; input formats PNG/JPEG/WebP, output PNG; allowed sizes/quality/background explicit. Codex image model null/adapter-managed; don't equate orchestration model with tool model.
prepare request {operationId,connectionId,expectedConnectionRevision,model:null|string,prompt,inputs:Descriptor[],options:{size,resolution?,aspectRatio?,quality,background}}. Return {preparationToken,effectiveRecipe,effectiveRecipeDigest}. Recipe {schemaVersion:1,formatterVersion:1,connectionId,connectionRevision,adapter,endpointIdentity,model,options,inputDigests:[...],inputRoles:[...],submittedPrompt,agentTask?:string}. Canonical digest is SHA256 UTF8 serialized fixed-field struct, documented fixture; exclude handles/paths/token/secrets/incarnation. Prepare never generation; bounded tokens expire after5min if never accepted.
start includes prepared request + preparationToken,effectiveRecipeDigest. Existing receipt lookup precedes current profile/credential/token checks. Receipt key trusted caller package + operationId. Persist accepted + exact recipe/pins then single conditional running/dispatch-intent claim before HTTP/CLI. Restart accepted→cancelled; running→unknown; neither redispatch. Credentials snapshot in memory only. Persist sealed output + terminal metadata before success.
status/cancel {operationId}; acknowledge {operationId,outputSha256,disposition:acquired|discarded,transferReceipt?:string}. Responses {version:1,operationId,requestFingerprint,provider:{packageId,serviceId,major},revision,execution:{state:accepted|running|succeeded|failed|cancelled|unknown,metadata?:ImageMetadata,error?:SafeError},delivery:{state:none|available|acquired|discarded|unavailable,output?:Descriptor,transferReceipt?:string,reason?:missing|corrupt|storage_unavailable}}. Success never becomes failure merely because bytes disappear; acquired receipt remains after redundant bytes removed.

## Provider credentials/settings

Reverse host.credentials.put {profileId,key} → {id}; host.credentials.get {profileId,id} → {key}; host.credentials.remove {profileId,id} → {removed}. Host scopes to calling package + profile, rejects preflight and unowned IDs. Public image service methods never expose keys. Environment/none resolve natively. Private provider settings commands read/save(expectedRevision),credential.set/clear(expectedRevision),check/test/cancelTest; private migration import/status host-only native route, no arbitrary consumers.

## Ownership

- Coordinator: these contracts/types, host manifest/broker/lifecycle/recovery/SDK/job integration, Trace image consumer and UI integration.
- Store agent: private service_state store + artifacts + pure transition validation against coordinator types, storage/quota/failure tests. No broker/manifest/SDK edits.
- Provider agent: independent image package native backend/adapters/journal/settings against these exact envelopes; no host/Trace/shared contracts edits. Ask coordinator before changing contract.
- UI agent (later): image settings dialog and optional settings action/modal presentation after coordinator API freeze.

Current text-stage commits: host4964caba, Trace2de3f61. Current CLI text adapters intentionally unavailable; candidate image CLI extraction must preserve existing image evidence boundaries without falsely claiming text isolation.

## Legacy rollback import epochs

Private host import source IDs accept the original `trace-openai-image-v1` plus `trace-openai-image-v1.<32 lowercase hex native nonce>`. Each has its own atomic immutable provider import receipt. Host journals contain sourceId, source/retired-field digests and credential references, never plaintext. Profile IDs derive from sourceId + source digest, so a later intentional legacy rollback/cutover cannot overwrite an earlier profile or collide when the legacy values are unchanged. Existing destination defaults always win; import preserved legacy transports as additional non-default profiles when configured.

A committed enabled legacy Trace SDK1/2 may write its legacy settings during intentional rollback; the native lifecycle read gate pins that determination through the source write. The coordinator marks that epoch LegacyResumed and re-plans a new import only after split Trace SDK3 activation commits. Otherwise the retired source fence remains enforced. A newly retired source cannot restore keys during the DestinationCommitted crash window. Pending migration retains plaintext and never fences an unchanged legacy package during host-only upgrades. Provider imports still require the exact private host token and cannot be invoked by another consumer/frontend.
