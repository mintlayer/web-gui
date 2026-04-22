# Mintlayer Web GUI — Plugin System

Plugins extend the wallet UI without being part of the main distribution. Each plugin is a Node.js ESM module uploaded as a `.tgz` archive. Plugins run server-side, in the same process as the app, with the same trust level as the app itself — **only install plugins you wrote or fully trust**.

---

## Quick start

```bash
# 1. Build the example plugin
cd examples/mlusdt-price
bash pack.sh          # creates examples/mlusdt-price.tgz

# 2. Open the GUI → Management → Plugins → Install
# 3. Upload mlusdt-price.tgz
# 4. Click Enable → "ML Price" appears in the nav
```

---

## Archive structure

A plugin archive must contain these files at the root (or inside one top-level directory, npm-pack style):

```
plugin.json        ← required: manifest
index.mjs          ← required: handler (or whatever "entry" names)
public/            ← optional: static assets
  style.css
  logo.svg
```

Both flat and nested archives work:

```
# flat (preferred)
tar -czf myplugin.tgz plugin.json index.mjs

# nested (npm pack output)
tar -czf myplugin.tgz myplugin/plugin.json myplugin/index.mjs
```

---

## plugin.json — manifest

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Unique identifier. **Lowercase letters, digits, and hyphens only** — used as a URL path segment and directory name. |
| `name` | string | ✓ | Human-readable name shown in the Plugins management page. |
| `navLabel` | string | ✓ | Short label shown in the sidebar when the plugin is enabled. |
| `version` | string | ✓ | Semver-style version string, shown in the Plugins list. |
| `entry` | string | ✓ | Filename of the ESM handler module, relative to the archive root. |
| `navSection` | string | — | Sidebar section to place the plugin in. One of `"wallet"`, `"assets"`, `"trade"`, `"apps"`. Defaults to `"apps"`. |
| `navIcon` | string | — | SVG `d` attribute of a single Heroicons-outline-style path (`viewBox="0 0 24 24"`, `strokeWidth="1.5"`). Defaults to a wrench icon. |

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "navLabel": "My Plugin",
  "version": "1.0.0",
  "entry": "index.mjs",
  "navSection": "apps",
  "navIcon": "M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"
}
```

**ID rules:** must match `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`. No uppercase, no leading/trailing dash, minimum 2 characters. The ID becomes the URL path (`/plugins/{id}/`) and the directory name on disk.

### Choosing a `navIcon`

The icon is the `d` attribute value of a single SVG path. Use any [Heroicons outline icon](https://heroicons.com/) (24px, strokeWidth 1.5). Copy the `d` value from the SVG source:

```json
"navIcon": "M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18.75-9v9m0 0h-.375a.75.75 0 01-.75-.75V18M18.75 15h.375A.75.75 0 0120.25 15v3.75m-18 0H3.75m0 0a.75.75 0 00-.75.75V20.25m.75-.75H12"
```

The wrench icon is used when `navIcon` is omitted.

---

## index.mjs — handler module

The entry file must export an async `handler` function:

```javascript
export async function handler(request, context) {
  // …
}
```

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `request` | `Request` | The incoming HTTP request (standard Web API `Request`). Includes method, URL, headers, and body. |
| `context` | `PluginContext` | Shared app context (see below). |

### Return values

The handler can return one of two things:

#### 1. A page — `{ title, html }`

Return a plain object with `title` (string) and `html` (HTML string). The app wraps it in the shared Layout, giving it the standard nav, header, and footer automatically.

```javascript
export async function handler(request, context) {
  return {
    title: 'My Plugin',
    html:  '<h1 class="text-2xl font-bold text-gray-100">Hello</h1>',
  };
}
```

The `html` string is injected as `innerHTML` inside the main content area, so standard Tailwind CSS classes work out of the box.

#### 2. A raw `Response`

Return a Web API `Response` for anything that isn't an HTML page: JSON APIs, redirects, SSE streams, binary downloads.

```javascript
export async function handler(request, context) {
  return Response.json({ ok: true, value: 42 });
}
```

### Routing sub-paths

All requests to `/plugins/{id}/**` reach the same handler. Use the URL to route internally:

```javascript
export async function handler(request, context) {
  const url = new URL(request.url);
  const path = url.pathname; // e.g. "/plugins/my-plugin/api/data"

  if (path === `/plugins/my-plugin/api/data`) {
    const balance = await context.walletRpc('account_balance', {
      account: 0,
      utxo_states: ['Confirmed'],
      with_locked: 'Any',
    });
    return Response.json({ ok: true, balance });
  }

  // Default: render the page
  return { title: 'My Plugin', html: '<p>Hello</p>' };
}
```

---

## PluginContext

```typescript
interface PluginContext {
  // Call any wallet-rpc-daemon method server-side (no allowlist restriction)
  walletRpc(method: string, params?: Record<string, unknown>): Promise<unknown>;

  // Per-plugin key/value storage (backed by the shared SQLite prefs DB)
  // Keys are namespaced automatically — no risk of collision with other plugins.
  getPref(key: string): unknown;
  setPref(key: string, value: unknown): void;

  // Base URL of the Mintlayer indexer REST API, or null if not running.
  indexerBaseUrl: string | null;

  // The original incoming Request object (same as the handler's first argument).
  request: Request;
}
```

### `context.walletRpc(method, params)`

Calls the wallet-rpc-daemon directly. See `~/projects/mintlayer/mintlayer-core/wallet/wallet-rpc-daemon/docs/RPC.md` for the full method list.

```javascript
// Check balance
const balance = await context.walletRpc('account_balance', {
  account: 0,
  utxo_states: ['Confirmed'],
  with_locked: 'Any',
});

// Send coins
await context.walletRpc('address_send', {
  account: 0,
  address: 'tmt1...',
  amount: { decimal: '1.5' },
  selected_utxos: [],
  options: {},
});
```

### `context.getPref / setPref`

Simple key/value store scoped to the plugin. Values are JSON-serialised.

```javascript
context.setPref('last_run', Date.now());
const lastRun = context.getPref('last_run'); // number | null
```

### `context.indexerBaseUrl`

`null` when the indexer profile is not running. If set, it's the internal base URL of the Mintlayer REST API (e.g. `http://api-web-server:3000`).

```javascript
if (context.indexerBaseUrl) {
  const res = await fetch(`${context.indexerBaseUrl}/api/v2/token/${tokenId}`);
  const info = await res.json();
}
```

---

## Static assets

Files placed in the `public/` directory of your archive are served at `/plugins/{id}/public/{filename}`.

```html
<!-- In your HTML — reference images, CSS, JS from public/ -->
<link rel="stylesheet" href="/plugins/my-plugin/public/style.css">
<img src="/plugins/my-plugin/public/logo.svg" alt="logo">
<script src="/plugins/my-plugin/public/app.js"></script>
```

---

## Auto-refresh pattern

A plugin page can call its own JSON sub-route to update data without a full page reload:

```javascript
// In the HTML returned by the handler:
`<div id="price">$1.23</div>
<script>
  setInterval(async () => {
    const res  = await fetch('/plugins/my-plugin/api/price');
    const data = await res.json();
    if (data.ok) document.getElementById('price').textContent = '$' + data.price;
  }, 30_000);
</script>`
```

The JSON route in the handler:

```javascript
if (url.pathname === '/plugins/my-plugin/api/price') {
  const price = await fetchCurrentPrice();
  return Response.json({ ok: true, price });
}
```

---

## Authentication

All plugin routes (`/plugins/**`) go through the standard session middleware. Users must be logged in — plugins do not need to implement authentication themselves.

---

## Styling guide

The host app uses **Tailwind CSS** with a dark theme. These classes are reliably available in plugin HTML:

| Purpose | Classes |
|---|---|
| Background | `bg-gray-950`, `bg-gray-900`, `bg-gray-800` |
| Text | `text-gray-100`, `text-gray-400`, `text-gray-500` |
| Accent (mint) | `text-mint-400`, `bg-mint-600`, `border-mint-800` |
| Success | `text-green-400`, `bg-green-900/30` |
| Error | `text-red-400`, `bg-red-900/30` |
| Cards | `rounded-xl border border-gray-800 bg-gray-900/40 p-5` |
| Buttons | `px-4 py-2 rounded bg-mint-600 hover:bg-mint-500 text-white text-sm font-medium` |

---

## Lifecycle

| Event | Behaviour |
|---|---|
| Install | Archive is extracted to `/app/plugins/{id}/`. Plugin starts **disabled**. |
| Enable | Plugin nav item appears immediately (on next page load). Handler is imported. |
| Disable | Nav item disappears. Requests to `/plugins/{id}/**` return 404. |
| Uninstall | Plugin directory deleted, removed from registry. |
| Reinstall | Uninstall first, then install the new archive. The module cache is invalidated automatically. |

---

## Example plugins

| Directory | Description |
|---|---|
| [`examples/mlusdt-price/`](examples/mlusdt-price/) | Displays the current ML/USDT spot price from Bitget with auto-refresh. |

---

## Security notes

- Plugins execute with full Node.js access (filesystem, network, child processes).
- Plugin code can call any wallet RPC method, not just the browser-safe allowlist.
- There is no sandboxing — treat a plugin the same as any server-side dependency.
- The plugin `id` is validated against a strict regex and used as a directory name; path traversal is not possible.
