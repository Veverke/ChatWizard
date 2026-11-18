# Semantic search: the AI model cannot be downloaded

Semantic search ("Find Sessions by Topic") needs a ~23 MB local embedding model
(`Xenova/all-MiniLM-L6-v2`). It runs **entirely offline** once the files are on
disk — the only network access is the one-time download.

On locked-down (corporate) networks that download can fail.

## Symptoms

- A notification stays on **"Chat Wizard: Downloading AI model…"**, typically
  frozen on something like `Loaded tokenizer.json`.
- The output channel shows:

  ```
  [Semantic > EmbeddingEngine > EmbeddingWorker] Worker error: TypeError: fetch failed
  ```

  (twice, once per inference worker).
- Keyword search, the session tree, analytics and the MCP tools keep working.

`fetch failed` from Node means the connection never produced a usable response:
TLS interception by a security appliance or corporate proxy, an egress allow-list
without the model host, DNS filtering, or a proxy the extension host is not using.

### A second, distinct symptom: metadata works, the weights are blocked

Filters often allow small text files and block the payload. That looks like the
first files verifying and then the largest one failing:

```
  ✓ config.json — 0.0 MB, verified
  ✓ tokenizer.json — 0.7 MB, verified
  ✗ https://huggingface.co/… failed: Download failed with HTTP 403 for
    https://<storage-host>/… (redirected from https://huggingface.co/…)
```

The model host redirects `resolve/…` to a storage/CDN host, and that host is what
gets blocked. **The error names the final hop on purpose** — read it to see which
host actually answered. Such a response usually carries an HTML body and/or a
`Server` header naming the appliance, with `403`/`451`; no certificate fix helps,
because the file is filtered by policy.

Chat Wizard keeps the files that already verified, moves to the next source
(mirror, then the GitHub release asset), and fetches only what is still missing.
That is exactly why the release asset set exists.

## What Chat Wizard does now

1. Model files are fetched by Chat Wizard itself (not by the model runtime), from
   the first source that answers:

   | # | Source | Configured by |
   |---|--------|---------------|
   | 1 | A local folder — no network at all | `chatwizard.semanticModelPath` |
   | 2 | A previously downloaded folder | automatic |
   | 3 | A mirror host | `chatwizard.semanticModelMirror` or `HF_ENDPOINT` |
   | 4 | Official Hugging Face Hub | `https://huggingface.co` |
   | 5 | Chat Wizard GitHub release asset | built in |

2. Every download is verified (size, SHA-256 from `manifest.json`, JSON parse,
   ONNX sanity check) and written atomically — a proxy's HTML block page can no
   longer poison the cache.
3. A source only has to serve what is still missing. Files that verified are kept
   when a later source is tried, so a partially serving source (filters commonly
   allow the small metadata but block the weights, and mirrors can be incomplete)
   still moves the download forward instead of restarting it.
4. The operating system's certificate store is trusted in addition to Node's
   bundled roots (following VS Code's `http.systemCertificates`, default `true`),
   so a TLS-inspecting proxy works without `NODE_EXTRA_CA_CERTS`. Certificate
   **verification stays enabled** — roots are only added, never bypassed.
5. `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are honoured (and VS Code's
   `http.proxy` setting).
6. If every source fails, semantic search is switched off **for this session**
   with one actionable notification — no endless retry, no stuck popup:

   > Chat Wizard: semantic search is unavailable — the AI model could not be
   > downloaded (the network appears to block or intercept the download).
   > Keyword search still works. **[Fix Model Source…] [Retry] [Disable]**


## What success looks like

Open **View → Output → Chat Wizard** and filter for `[Semantic`. A healthy start
logs, in order:

```
[Semantic > SemanticIndexer] Model state: available on disk, consent: already given
[Semantic > SemanticIndexer] Acquiring the AI model silently (cached model or a retry — no notification).
[Semantic > ModelInstaller] Model source options — local folder: (not set) | mirror: (not set) | fallback: https://github.com/…
[Semantic > ModelInstaller] Model already on disk — reusing <globalStorage>\models\downloaded\Xenova\all-MiniLM-L6-v2
[Semantic > SemanticIndexer] Model provisioned from cache (<globalStorage>\models\downloaded\Xenova\all-MiniLM-L6-v2)
[Semantic > EmbeddingEngine > EmbeddingWorker] Loading the semantic model — local folder <…> (cache dir: <…>)
[Semantic > EmbeddingEngine > EmbeddingWorker] Loading model from disk — folder=<…> modelId=Xenova/all-MiniLM-L6-v2 onnx=onnx/model_quantized.onnx quantized=true allowRemoteModels=false
[Semantic > EmbeddingEngine > EmbeddingWorker] feature-extraction pipeline ready (local files only — no network access)
[Semantic > EmbeddingEngine > EmbeddingWorker] All 2 workers ready in 812ms
[Semantic > SemanticIndexer] AI model loaded successfully.
[Semantic > SemanticIndexer] Semantic search is ACTIVE — 4213 vector(s) indexed, 187 session fingerprint(s).
```

A first download adds the source chain and verification lines:

```
[Semantic > SemanticIndexer] User accepted the AI model download.
[Semantic > SemanticIndexer] Acquiring the AI model (download progress is shown to the user).
[Semantic > ModelInstaller] Model not on disk — downloading 4 file(s) into <…> (3 source(s) queued)
[Semantic > ModelInstaller] Source 1/3: https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/
[Semantic > ModelInstaller] No manifest.json at this source — verifying file structure only
[Semantic > ModelInstaller]   ✓ onnx/model_quantized.onnx — 22.7 MB, verified
[Semantic > ModelInstaller] Model download complete from huggingface.co — 23.6 MB in 9.4s
```

A blocked network ends with one `[ERROR]` line plus the guidance block, and the
feature is skipped — no repeated retries:

```
[Semantic > ModelInstaller]   ✗ https://huggingface.co/… failed: fetch failed
[Semantic > SemanticIndexer] Semantic search unavailable (blocked): fetch failed
[Semantic > SemanticIndexer] Semantic search needs no network access once the model is on disk. Options: …
```

## Fix 1 — use a mirror host (fastest)

Run **`Chat Wizard: Configure AI Model Source…`** → **Mirror host…** and enter a
host that mirrors the Hugging Face layout, for example:

```
https://hf-mirror.com
```

Any internal Artifactory/Nexus/nginx that proxies
`https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/<file>` works too.
The equivalent setting is:

```json
"chatwizard.semanticModelMirror": "https://hf-mirror.com"
```

The `HF_ENDPOINT` environment variable is also honoured when the setting is empty.


## Fix 2 — point at a local model folder (works fully offline)

1. On a machine that can reach the internet, download these four files:

   ```
   https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json
   https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json
   https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer_config.json
   https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx
   ```

2. Keep the `onnx/` sub-folder, i.e. the folder looks like `Xenova/all-MiniLM-L6-v2`:

   ```
   all-MiniLM-L6-v2/
   ├── config.json
   ├── tokenizer.json
   ├── tokenizer_config.json
   └── onnx/
       └── model_quantized.onnx
   ```

3. Copy that folder to the target machine and run
   **`Chat Wizard: Configure AI Model Source…`** → **Local model folder…**, or set:

   ```json
   "chatwizard.semanticModelPath": "C:\\\\models\\\\all-MiniLM-L6-v2"
   ```

Either the model folder itself, its `Xenova` parent, or a models root containing
`Xenova/all-MiniLM-L6-v2` is accepted.

> `onnx/model.onnx` (≈90 MB) also works if that is all you have; the quantized
> file is preferred because it is 4× smaller with negligible quality loss.


## Fix 3 — trust the corporate root CA (TLS interception)

If the output channel reports

```
[Semantic > SemanticIndexer] Semantic search unavailable (tls): unable to get local issuer certificate
```

the connection is being **re-signed by a TLS-inspecting proxy or security
appliance** (common examples: Zscaler, Netskope, Blue Coat — the mechanism is the
same for all of them). The certificate is issued by your organisation, and
Node uses its **own** CA bundle — unlike the browser and `git`, which read the
Windows/macOS store. Every `https://` source therefore fails, including the
GitHub release asset, until Node trusts that root.

Point Node at the corporate root CA (`.pem`/`.crt`, DER must be converted first):

```powershell
setx NODE_EXTRA_CA_CERTS "C:\certs\corp-root-ca.pem"
```

Then **restart VS Code** (the variable is read at process start). Confirm with:

```powershell
node -e "require('https').get('https://huggingface.co', r => console.log(r.statusCode))"
```
```text
node:internal/modules/cjs/loader ... unable to get local issuer certificate   <-- still broken
200                                                                           <-- fixed
```

If you cannot obtain the `.pem`, use **Fix 1** (mirror on a trusted host) or
**Fix 2** (local folder) instead — both avoid the untrusted endpoint entirely.

> A corporate proxy can also return a *valid-looking* block page (HTTP 403 with
> an HTML body). That is caught as `blocked` or `corrupt` rather than `tls`, and
> is never written into the model folder.


## Fix 4 — let the proxy be used

The VS Code extension host is a Node.js process; it does **not** pick up the
proxy from `http.proxy` automatically. Chat Wizard reads VS Code's `http.proxy`
setting, and falls back to the standard environment variables, which is what a
VS Code launched outside a shell needs:

```powershell
setx HTTPS_PROXY  http://proxy.corp.example:8080
setx NO_PROXY     localhost,127.0.0.1,.corp.example
```

(Also set `HTTP_PROXY` for http-only escape hatches.) The downloader uses
`CONNECT` tunnelling with `Proxy-Authorization` support for
`http://user:pass@proxy:port`.


## Fix 5 — reset a poisoned cache

If an earlier attempt hit a proxy that returned an HTML page, the partial files
can linger. Run **`Chat Wizard: Reset AI Model Cache`**, then **`Chat Wizard:
Retry Loading the AI Model`**.


## Enterprise / air-gapped deployments

**Ship the model inside the extension folder.** Drop the same four files into
`<extension folder>/resources/models/Xenova/all-MiniLM-L6-v2/` when building the
VSIX (`resources/**` is packaged). Chat Wizard picks it up automatically — no
setting and no network access required.

**Or deploy the setting through policy** (settings sync / MDM):

```json
{
  "chatwizard.enableSemanticSearch": true,
  "chatwizard.semanticModelPath": "C:\\\\ProgramData\\\\ChatWizard\\\\all-MiniLM-L6-v2"
}
```

**Hosting your own copy.** The *Semantic model assets* GitHub action
(`.github/workflows/model-assets.yml`) downloads the model, verifies it and
publishes the 4 files plus `manifest.json` as release assets on a tag of your
choice (default `semantic-model-v1`). The extension uses that release as its last
download source, which is what makes the feature work where `huggingface.co` is
blocked. Re-run the action only when you intentionally change the model.

If you already have the files (or cannot use GitHub), produce the same verified
asset set locally and host it on any HTTPS server:

```bash
# download + verify + write manifest.json (what CI does)
npx tsx scripts/prepare-model-assets.ts --out .model-assets --tag semantic-model-v1

# or: files already on disk -> just write manifest.json (no network at all)
node scripts/hash-model-assets.mjs C:\path\to\all-MiniLM-L6-v2
```

Publish the files flat (the manifest records the flat names, e.g.
`model_quantized.onnx`) next to `manifest.json`, then set
`chatwizard.semanticModelMirror` to that host. A **local** folder needs no
manifest — the extension validates the layout directly.

Everything is stored under the extension's global storage:

```
<globalStorage>/models/downloaded/Xenova/all-MiniLM-L6-v2/   downloaded model
<globalStorage>/models/.chatwizard-model-failed             last failure record
<globalStorage>/models/.chatwizard-ready                    model is available
```
