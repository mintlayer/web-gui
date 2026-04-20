/**
 * mlusdt-price — example Mintlayer Web GUI plugin
 *
 * Fetches the ML/USDT spot price from the Bitget public API and displays
 * it in a dashboard card. The page auto-refreshes every 30 seconds by
 * calling the /api/price sub-route defined below.
 */

const BITGET_URL =
  'https://api.bitget.com/api/v2/spot/market/tickers?symbol=MLUSDT';

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchTicker() {
  const res = await fetch(BITGET_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`Bitget API returned HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body.code !== '00000') {
    throw new Error(`Bitget error ${body.code}: ${body.msg}`);
  }

  const ticker = body.data?.[0];
  if (!ticker) throw new Error('No ticker data in response');

  return {
    symbol:      ticker.symbol,
    price:       ticker.lastPr,
    open:        ticker.open,
    high24h:     ticker.high24h,
    low24h:      ticker.low24h,
    change24h:   ticker.change24h,   // decimal fraction, e.g. 0.06287 = +6.29%
    baseVolume:  ticker.baseVolume,  // volume in ML
    quoteVolume: ticker.quoteVolume, // volume in USDT
    bid:         ticker.bidPr,
    ask:         ticker.askPr,
    ts:          ticker.ts,
  };
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function fmtPrice(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toFixed(6);
}

function fmtVolume(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toFixed(2);
}

function fmtChange(v) {
  const n = parseFloat(v) * 100; // fraction → percent
  if (isNaN(n)) return { text: '—', positive: true };
  return {
    text:     (n >= 0 ? '+' : '') + n.toFixed(2) + '%',
    positive: n >= 0,
  };
}

function statCard(label, value, cls = '') {
  return `
    <div class="rounded-xl border border-gray-800 bg-gray-900/40 px-5 py-4">
      <p class="text-xs text-gray-500 mb-1">${label}</p>
      <p class="text-lg font-semibold ${cls || 'text-gray-100'}">${value}</p>
    </div>`;
}

function renderPage(ticker) {
  const change = fmtChange(ticker.change24h);

  return `
    <div class="space-y-6" id="ml-root">

      <!-- Header -->
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold text-gray-100">
            ML<span class="text-gray-500">/USDT</span>
          </h1>
          <p class="text-xs text-gray-500 mt-0.5">Bitget spot · auto-refreshes every 30s</p>
        </div>
        <span id="ml-updated" class="text-xs text-gray-500">Updated just now</span>
      </div>

      <!-- Price hero -->
      <div class="rounded-xl border border-gray-800 bg-gray-900/40 p-6 flex items-end gap-4 flex-wrap">
        <div>
          <p class="text-xs text-gray-400 mb-1">Last price</p>
          <p id="ml-price" class="text-4xl font-bold text-gray-100">
            $<span>${fmtPrice(ticker.price)}</span>
          </p>
        </div>
        <p id="ml-change"
           class="text-xl font-semibold mb-0.5 ${change.positive ? 'text-green-400' : 'text-red-400'}">
          ${change.text}
        </p>
        <p class="text-xs text-gray-500 mb-1 ml-auto">
          Open: $${fmtPrice(ticker.open)}
        </p>
      </div>

      <!-- Stats grid -->
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3" id="ml-stats">
        ${statCard('24h High',      '$' + fmtPrice(ticker.high24h))}
        ${statCard('24h Low',       '$' + fmtPrice(ticker.low24h))}
        ${statCard('Bid / Ask',
          '$' + fmtPrice(ticker.bid) + ' / $' + fmtPrice(ticker.ask))}
        ${statCard('Volume (ML)',  fmtVolume(ticker.baseVolume))}
        ${statCard('Volume (USDT)', '$' + fmtVolume(ticker.quoteVolume))}
        ${statCard('Pair', ticker.symbol, 'text-mint-400')}
      </div>

    </div>

    <script>
      (function () {
        async function refresh() {
          try {
            const res  = await fetch('/plugins/mlusdt-price/api/price');
            const data = await res.json();
            if (!data.ok) return;

            document.getElementById('ml-price').innerHTML =
              '$<span>' + data.price + '</span>';

            const pct      = (parseFloat(data.change24h) * 100).toFixed(2);
            const positive = pct >= 0;
            const el       = document.getElementById('ml-change');
            el.textContent = (positive ? '+' : '') + pct + '%';
            el.className   = 'text-xl font-semibold mb-0.5 ' +
                             (positive ? 'text-green-400' : 'text-red-400');

            document.getElementById('ml-updated').textContent =
              'Updated ' + new Date().toLocaleTimeString();
          } catch {
            // silently ignore network errors
          }
        }

        setInterval(refresh, 30_000);
      })();
    </script>`;
}

function renderError(message) {
  return `
    <div class="space-y-4">
      <h1 class="text-2xl font-bold text-gray-100">ML<span class="text-gray-500">/USDT</span></h1>
      <div class="rounded-xl border border-red-900 bg-red-900/20 px-5 py-4 text-red-400 text-sm">
        Failed to fetch price: ${message}
      </div>
      <p class="text-xs text-gray-500">
        Retrying automatically. Check that the server has outbound internet access.
      </p>
    </div>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handler(request, context) {
  const url = new URL(request.url);

  // JSON sub-route used by the auto-refresh script
  if (url.pathname === '/plugins/mlusdt-price/api/price') {
    try {
      const ticker = await fetchTicker();
      return Response.json({ ok: true, ...ticker });
    } catch (err) {
      return Response.json({ ok: false, error: err.message }, { status: 502 });
    }
  }

  // Main page — returns { title, html } for Layout embedding
  try {
    const ticker = await fetchTicker();
    return { title: 'ML/USDT Price', html: renderPage(ticker) };
  } catch (err) {
    return { title: 'ML/USDT Price', html: renderError(err.message) };
  }
}
