/**
 * tools - Mintlayer Web GUI plugin
 *
 * Five tools in one:
 *  1. Sign & Verify   - sign/verify plain-text messages via the wallet RPC
 *  2. Decode Tx       - inspect a hex-encoded transaction
 *  3. Get Transaction - look up a transaction by ID and view its decoded form
 *  4. Multisend       - compose → sign → broadcast a tx with multiple Transfer outputs
 *  5. Locked Multisend- same but with LockThenTransfer (timelocked) outputs
 */

// ── ML amount helpers ─────────────────────────────────────────────────────────

const ATOMS_PER_ML = BigInt('100000000000'); // 10^11

function decimalToAtoms(decimal) {
  const s = String(decimal).trim();
  const [whole, frac = ''] = s.split('.');
  const fracPadded = frac.padEnd(11, '0').slice(0, 11);
  return String(BigInt(whole || '0') * ATOMS_PER_ML + BigInt(fracPadded || '0'));
}

function atomsToDecimal(atoms) {
  const str = String(atoms).padStart(12, '0');
  const whole = str.slice(0, -11) || '0';
  const frac  = str.slice(-11).replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function fmtFee(fees) {
  if (!fees) return 'unknown';
  const coins = fees.coins?.decimal ?? atomsToDecimal(fees.coins?.atoms ?? '0');
  return `${coins} ML`;
}

// ── Coin selection ────────────────────────────────────────────────────────────

function selectUtxos(utxos, targetAtoms) {
  const coinUtxos = utxos
    .filter(u => u.output.type === 'Transfer' && u.output.content.value.type === 'Coin')
    .sort((a, b) => {
      const diff = BigInt(b.output.content.value.content.amount.atoms)
                 - BigInt(a.output.content.value.content.amount.atoms);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });

  const selected = [];
  let accumulated = 0n;
  const needed = BigInt(targetAtoms) + 1_000_000_000_000n; // +1 ML fee buffer

  for (const u of coinUtxos) {
    selected.push(u);
    accumulated += BigInt(u.output.content.value.content.amount.atoms);
    if (accumulated >= needed) break;
  }

  if (accumulated < BigInt(targetAtoms)) {
    throw new Error(
      `Insufficient funds: have ${atomsToDecimal(String(accumulated))} ML, need ${atomsToDecimal(String(targetAtoms))} ML`,
    );
  }
  return selected;
}

// ── Timelock JSON builder ─────────────────────────────────────────────────────

function buildTimelock(type, value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) throw new Error(`Invalid lock value: ${value}`);
  switch (type) {
    case 'ForBlockCount': return { type: 'ForBlockCount', content: n };
    case 'ForSeconds':    return { type: 'ForSeconds',    content: n };
    case 'UntilHeight':   return { type: 'UntilHeight',   content: n };
    case 'UntilTime':     return { type: 'UntilTime',     content: { timestamp: n } };
    default: throw new Error(`Unknown lock type: ${type}`);
  }
}

// ── API handler ───────────────────────────────────────────────────────────────

async function handleApi(path, request, context) {
  let body = {};
  try { body = await request.json(); } catch { /* no body */ }

  try {
    // ── Sign message ──────────────────────────────────────────────────────────
    if (path.endsWith('/sign')) {
      const sig = await context.walletRpc('challenge_sign_plain', {
        account:   body.account ?? 0,
        challenge: body.message,
        address:   body.address,
      });
      return Response.json({ ok: true, signature: sig });
    }

    // ── Verify signature ──────────────────────────────────────────────────────
    if (path.endsWith('/verify')) {
      await context.walletRpc('challenge_verify_plain', {
        message:          body.message,
        signed_challenge: body.signature,
        address:          body.address,
      });
      return Response.json({ ok: true });
    }

    // ── Decode transaction ────────────────────────────────────────────────────
    if (path.endsWith('/decode')) {
      const result = await context.walletRpc('transaction_inspect', {
        transaction: body.hex,
      });
      return Response.json({ ok: true, ...result });
    }

    // ── Get transaction by ID ─────────────────────────────────────────────────
    if (path.endsWith('/tx-get')) {
      const result = await context.walletRpc('transaction_get', {
        account:        body.account ?? 0,
        transaction_id: body.transaction_id,
      });
      return Response.json({ ok: true, transaction: result });
    }

    // ── Get spendable UTXOs ───────────────────────────────────────────────────
    if (path.endsWith('/utxos')) {
      const utxos = await context.walletRpc('account_utxos', { account: body.account ?? 0 });
      const coin = utxos
        .filter(u => u.output.type === 'Transfer' && u.output.content.value.type === 'Coin')
        .map(u => ({
          outpoint: u.outpoint,
          atoms:    u.output.content.value.content.amount.atoms,
          decimal:  u.output.content.value.content.amount.decimal,
        }));
      return Response.json({ ok: true, utxos: coin });
    }

    // ── Shared: select UTXOs, estimate fee, compose with change ──────────────
    // fee = FEE_RATE / 1024 * (inputNum * 156 + outputNum * 29)
    // FEE_RATE = 100_000_000_000 atoms per KB, where 1 KB = 1000 bytes
    const FEE_RATE = 100_000_000_000n;

    // bytes per output type (empirically derived from mempool fee errors)
    const BYTES_TRANSFER           = 29n;
    const BYTES_LOCK_THEN_TRANSFER = 62n;

    async function composeWithChange(account, recipientOutputs, totalAtoms, recipientOutputBytes = BYTES_TRANSFER) {
      const [allUtxos, changeAddrData] = await Promise.all([
        context.walletRpc('account_utxos', { account }),
        context.walletRpc('address_new', { account }),
      ]);
      const selected = selectUtxos(allUtxos, String(totalAtoms));
      const changeAddr = changeAddrData.address;

      const inputs = selected.map(u => ({
        source_id: u.outpoint.source_id,
        index:     u.outpoint.index,
      }));

      const inputsTotal = selected.reduce(
        (s, u) => s + BigInt(u.output.content.value.content.amount.atoms), 0n,
      );

      // change output is always Transfer; recipient outputs may differ
      const txSize = BigInt(inputs.length) * 156n
                   + BigInt(recipientOutputs.length) * recipientOutputBytes
                   + BYTES_TRANSFER; // change
      const feeAtoms = FEE_RATE * txSize / 1024n;

      const changeAtoms = inputsTotal - totalAtoms - feeAtoms;
      if (changeAtoms < 0n) throw new Error('Insufficient funds to cover transaction fee');

      const outputs = [
        ...recipientOutputs,
        { Transfer: [{ Coin: { atoms: String(changeAtoms) } }, changeAddr] },
      ];

      return context.walletRpc('transaction_compose', {
        inputs, outputs, htlc_secrets: null, only_transaction: false,
      });
    }

    // ── Compose multisend (Transfer outputs) ──────────────────────────────────
    if (path.endsWith('/compose')) {
      const { account = 0, recipients } = body;
      const totalAtoms = recipients.reduce((s, r) => s + BigInt(r.atoms), 0n);
      const recipientOutputs = recipients.map(r => ({
        Transfer: [{ Coin: { atoms: r.atoms } }, r.address],
      }));
      const result = await composeWithChange(account, recipientOutputs, totalAtoms, BYTES_TRANSFER);
      return Response.json({ ok: true, ...result });
    }

    // ── Compose locked multisend (LockThenTransfer outputs) ───────────────────
    if (path.endsWith('/compose-locked')) {
      const { account = 0, recipients, lock_type, lock_value } = body;
      const timelock = buildTimelock(lock_type, lock_value);
      const totalAtoms = recipients.reduce((s, r) => s + BigInt(r.atoms), 0n);
      const recipientOutputs = recipients.map(r => ({
        LockThenTransfer: [{ Coin: { atoms: r.atoms } }, r.address, timelock],
      }));
      const result = await composeWithChange(account, recipientOutputs, totalAtoms, BYTES_LOCK_THEN_TRANSFER);
      return Response.json({ ok: true, ...result });
    }

    // ── Sign composed transaction ─────────────────────────────────────────────
    if (path.endsWith('/sign-tx')) {
      const result = await context.walletRpc('account_sign_raw_transaction', {
        account: body.account ?? 0,
        raw_tx:  body.hex,
        options: { in_top_x_mb: null },
      });
      return Response.json({ ok: true, ...result });
    }

    // ── Broadcast signed transaction ──────────────────────────────────────────
    if (path.endsWith('/broadcast')) {
      const result = await context.walletRpc('node_submit_transaction', {
        tx:           body.hex,
        do_not_store: false,
        options:      { trust_policy: 'Trusted' },
      });
      return Response.json({ ok: true, ...result });
    }

    return Response.json({ ok: false, error: 'Unknown route' }, { status: 404 });

  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// ── Page HTML ─────────────────────────────────────────────────────────────────

function renderPage() {
  return `
<div class="space-y-6">

  <div>
    <h1 class="text-2xl font-bold text-gray-100">Wallet Tools</h1>
    <p class="text-sm text-gray-400 mt-1">Sign &amp; verify · Decode transactions · Get transaction · Multisend · Locked multisend</p>
  </div>

  <!-- Tab bar -->
  <nav class="flex gap-0 border-b border-gray-800">
    ${['sign-verify:Sign / Verify', 'decode:Decode Tx', 'tx-get:Get Transaction', 'multisend:Multisend', 'locked:Locked Multisend']
      .map((s, i) => {
        const [id, label] = s.split(':');
        const cls = i === 0
          ? 'tab-btn px-4 py-2 text-sm font-medium rounded-t transition-colors -mb-px border-b-2 border-mint-500 text-mint-400 bg-gray-900/40'
          : 'tab-btn px-4 py-2 text-sm font-medium rounded-t transition-colors -mb-px border-b-2 border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600';
        return `<button data-tab="${id}" onclick="switchTab('${id}')" class="${cls}">${label}</button>`;
      }).join('')}
  </nav>

  <!-- ── Tab: Sign / Verify ───────────────────────────────────────────────── -->
  <div id="tab-sign-verify" class="space-y-6">

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

      <!-- Sign -->
      <div class="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-4">
        <h2 class="text-sm font-semibold text-gray-200">Sign message</h2>
        <div class="space-y-3">
          ${field('sign-address', 'Address (signer)', 'text', '', 'tmt1…')}
          ${textarea('sign-message', 'Message', 'Plain-text message to sign')}
        </div>
        <button onclick="doSign()" class="${btnPrimary}">Sign</button>
        <div id="sign-result" class="hidden"></div>
      </div>

      <!-- Verify -->
      <div class="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-4">
        <h2 class="text-sm font-semibold text-gray-200">Verify signature</h2>
        <div class="space-y-3">
          ${field('verify-address', 'Address', 'text', '', 'tmt1…')}
          ${textarea('verify-message', 'Message', 'Original plain-text message')}
          ${textarea('verify-sig', 'Signature (hex)', 'Hex-encoded signature')}
        </div>
        <button onclick="doVerify()" class="${btnPrimary}">Verify</button>
        <div id="verify-result" class="hidden"></div>
      </div>

    </div>
  </div>

  <!-- ── Tab: Decode Tx ───────────────────────────────────────────────────── -->
  <div id="tab-decode" class="hidden space-y-4">
    <div class="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-4">
      <h2 class="text-sm font-semibold text-gray-200">Decode transaction</h2>
      <p class="text-xs text-gray-500">Paste the hex output of <code class="text-gray-400">transaction-compose</code> or <code class="text-gray-400">account-sign-raw-transaction</code>. Only works for unspent transactions.</p>
      ${textarea('decode-hex', 'Transaction hex', '')}
      <button onclick="doDecode()" class="${btnPrimary}">Decode</button>
    </div>
    <div id="decode-result" class="hidden"></div>
  </div>

  <!-- ── Tab: Get Transaction ────────────────────────────────────────────── -->
  <div id="tab-tx-get" class="hidden space-y-4">
    <div class="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-4">
      <h2 class="text-sm font-semibold text-gray-200">Get transaction by ID</h2>
      <p class="text-xs text-gray-500">Look up a transaction from the wallet by its transaction ID. Only transactions known to this wallet are returned.</p>
      ${field('txget-id', 'Transaction ID (hex)', 'text', '', 'abc123…')}
      <button onclick="doGetTx()" class="${btnPrimary}">Fetch</button>
    </div>
    <div id="txget-result" class="hidden"></div>
  </div>

  <!-- ── Tab: Multisend ───────────────────────────────────────────────────── -->
  <div id="tab-multisend" class="hidden space-y-4">
    <div class="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-4">
      <h2 class="text-sm font-semibold text-gray-200">Multisend - Transfer outputs</h2>
      <div id="ms-recipients" class="space-y-2"></div>
      <button onclick="addRecipient('ms-recipients','ms-')" class="${btnSecondary}">+ Add recipient</button>
      <div class="flex gap-2 pt-2">
        <button onclick="doCompose('ms')" class="${btnPrimary}">Compose</button>
      </div>
    </div>
    <div id="ms-result" class="hidden"></div>
  </div>

  <!-- ── Tab: Locked Multisend ─────────────────────────────────────────────── -->
  <div id="tab-locked" class="hidden space-y-4">
    <div class="rounded-xl border border-gray-800 bg-gray-900/40 p-5 space-y-4">
      <h2 class="text-sm font-semibold text-gray-200">Locked Multisend - LockThenTransfer outputs</h2>
      <p class="text-xs text-gray-500">All outputs share the same timelock. Coins are spendable only after the lock condition expires.</p>

      <!-- Lock type + value -->
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Lock type</label>
          <select id="lms-lock-type" class="${selectCls}">
            <option value="ForBlockCount">For block count</option>
            <option value="ForSeconds">For seconds</option>
            <option value="UntilHeight">Until block height</option>
            <option value="UntilTime">Until unix timestamp</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Lock value</label>
          <input id="lms-lock-value" type="number" min="0" placeholder="e.g. 1000"
                 class="${inputCls}" />
        </div>
      </div>

      <div id="lms-recipients" class="space-y-2"></div>
      <button onclick="addRecipient('lms-recipients','lms-')" class="${btnSecondary}">+ Add recipient</button>
      <div class="flex gap-2 pt-2">
        <button onclick="doComposeLocked()" class="${btnPrimary}">Compose</button>
      </div>
    </div>
    <div id="lms-result" class="hidden"></div>
  </div>

</div>

<!-- ── Sign & Broadcast confirmation modal ──────────────────────────────── -->
<div id="tx-confirm-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center">
  <div class="absolute inset-0 bg-black/60" onclick="closeTxModal()"></div>
  <div class="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
    <h3 class="text-base font-semibold text-gray-100">Confirm Transaction</h3>
    <div id="tx-confirm-body" class="space-y-3 text-sm text-gray-300"></div>
    <div id="tx-confirm-actions" class="flex justify-end gap-3 pt-1">
      <button type="button" onclick="closeTxModal()"
              class="${btnSecondary}">Cancel</button>
      <button id="tx-confirm-btn" type="button"
              class="px-4 py-2 rounded bg-mint-600 hover:bg-mint-500 text-white text-sm font-medium transition-colors">
        Sign &amp; Broadcast
      </button>
    </div>
    <div id="tx-confirm-result" class="hidden"></div>
  </div>
</div>

<script>
(function () {
  // ── Tab switching ─────────────────────────────────────────────────────────
  window.switchTab = function(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('border-mint-500', 'text-mint-400', 'bg-gray-900/40');
      b.classList.add('border-transparent', 'text-gray-500');
    });
    const activeBtn = document.querySelector('[data-tab="' + tab + '"]');
    if (activeBtn) {
      activeBtn.classList.remove('border-transparent', 'text-gray-500');
      activeBtn.classList.add('border-mint-500', 'text-mint-400', 'bg-gray-900/40');
    }
    document.querySelectorAll('[id^="tab-"]').forEach(p => p.classList.add('hidden'));
    const panel = document.getElementById('tab-' + tab);
    if (panel) panel.classList.remove('hidden');
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const ATOMS_PER_ML = 100_000_000_000n;

  function decimalToAtoms(d) {
    const [w, f = ''] = String(d).trim().split('.');
    const fp = f.padEnd(11, '0').slice(0, 11);
    return String(BigInt(w || '0') * ATOMS_PER_ML + BigInt(fp || '0'));
  }

  function atomsToDecimal(atoms) {
    const str = String(atoms).padStart(12, '0');
    const whole = str.slice(0, -11) || '0';
    const frac  = str.slice(-11).replace(/0+$/, '') || '0';
    return whole + '.' + frac;
  }

  function showResult(id, html) {
    const el = document.getElementById(id);
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  function card(content) {
    return '<div class="rounded-xl border border-gray-800 bg-gray-900/40 p-5">' + content + '</div>';
  }

  function errorBox(msg) {
    return '<div class="rounded-lg border border-red-900 bg-red-900/20 px-4 py-3 text-sm text-red-400">' + escHtml(msg) + '</div>';
  }

  function successBox(msg) {
    return '<div class="rounded-lg border border-green-900 bg-green-900/20 px-4 py-3 text-sm text-green-400">' + msg + '</div>';
  }

  function codeBlock(text) {
    return '<pre class="bg-gray-950 rounded-lg p-4 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">' + escHtml(text) + '</pre>';
  }

  function copyBtn(text, label) {
    const id = 'cb-' + Math.random().toString(36).slice(2);
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => {
        navigator.clipboard.writeText(text);
        el.textContent = 'Copied!';
        setTimeout(() => { el.textContent = label; }, 1500);
      });
    }, 0);
    return '<button id="' + id + '" class="mt-2 px-3 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors">' + label + '</button>';
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function api(route, body) {
    const res = await fetch('/plugins/tools/api/' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  function val(id) { return document.getElementById(id)?.value?.trim() ?? ''; }

  // ── Add recipient row ─────────────────────────────────────────────────────
  window.addRecipient = function(containerId, prefix) {
    const container = document.getElementById(containerId);
    const idx = container.children.length;
    const row = document.createElement('div');
    row.className = 'flex gap-2 items-end';
    row.innerHTML =
      '<div class="flex-1">' +
        '<label class="block text-xs text-gray-400 mb-1">Address #' + (idx+1) + '</label>' +
        '<input type="text" id="' + prefix + 'addr-' + idx + '" placeholder="tmt1…" class="${inputCls}" />' +
      '</div>' +
      '<div class="w-36">' +
        '<label class="block text-xs text-gray-400 mb-1">Amount (ML)</label>' +
        '<input type="text" id="' + prefix + 'amt-' + idx + '" placeholder="1.5" class="${inputCls}" />' +
      '</div>' +
      '<button onclick="this.parentElement.remove()" class="mb-0 px-2 py-2 rounded text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors text-lg leading-none">×</button>';
    container.appendChild(row);
  };

  function collectRecipients(prefix) {
    const results = [];
    let idx = 0;
    while (true) {
      const addr = document.getElementById(prefix + 'addr-' + idx);
      const amt  = document.getElementById(prefix + 'amt-'  + idx);
      if (!addr) break;
      if (!addr.value.trim() || !amt.value.trim()) { idx++; continue; }
      results.push({ address: addr.value.trim(), atoms: decimalToAtoms(amt.value.trim()) });
      idx++;
    }
    return results;
  }

  // ── Sign ──────────────────────────────────────────────────────────────────
  window.doSign = async function() {
    const data = await api('sign', {
      account: 0,
      message: val('sign-message'),
      address: val('sign-address'),
    });
    if (!data.ok) { showResult('sign-result', errorBox(data.error)); return; }
    showResult('sign-result',
      successBox('Signed successfully') +
      '<p class="text-xs text-gray-400 mt-3 mb-1">Signature (hex)</p>' +
      codeBlock(data.signature) +
      copyBtn(data.signature, 'Copy signature'),
    );
  };

  // ── Verify ────────────────────────────────────────────────────────────────
  window.doVerify = async function() {
    const data = await api('verify', {
      message:   val('verify-message'),
      signature: val('verify-sig'),
      address:   val('verify-address'),
    });
    if (!data.ok) { showResult('verify-result', errorBox('Invalid signature: ' + data.error)); return; }
    showResult('verify-result', successBox('✓ Signature is valid'));
  };

  // ── Decode ────────────────────────────────────────────────────────────────
  window.doDecode = async function() {
    const data = await api('decode', { hex: val('decode-hex') });
    if (!data.ok) { showResult('decode-result', errorBox(data.error)); return; }

    const fee   = data.fees ? (data.fees.coins?.decimal ?? '?') + ' ML' : 'N/A';
    const stats = data.stats ?? {};
    showResult('decode-result',
      card(
        '<div class="grid grid-cols-3 gap-4 mb-4">' +
          stat('Inputs',      stats.num_inputs ?? '?') +
          stat('Signatures',  stats.total_signatures ?? '?') +
          stat('Fee',         fee) +
        '</div>' +
        '<p class="text-xs text-gray-400 mb-2">Raw transaction</p>' +
        codeBlock(data.tx) +
        copyBtn(data.tx, 'Copy hex'),
      ),
    );
  };

  // ── Get transaction ───────────────────────────────────────────────────────
  window.doGetTx = async function() {
    const txId = val('txget-id');
    if (!txId) { showResult('txget-result', errorBox('Enter a transaction ID.')); return; }
    const data = await api('tx-get', { account: 0, transaction_id: txId });
    if (!data.ok) { showResult('txget-result', errorBox(data.error)); return; }
    const json = JSON.stringify(data.transaction, null, 2);
    showResult('txget-result',
      card(
        '<p class="text-xs text-gray-400 mb-2">Transaction (decoded JSON)</p>' +
        codeBlock(json) +
        copyBtn(json, 'Copy JSON'),
      ),
    );
  };

  function stat(label, value) {
    return '<div class="rounded-lg border border-gray-800 bg-gray-950 px-4 py-3">' +
           '<p class="text-xs text-gray-500 mb-0.5">' + label + '</p>' +
           '<p class="text-lg font-semibold text-gray-100">' + escHtml(String(value)) + '</p>' +
           '</div>';
  }

  // ── Compose → confirm modal ───────────────────────────────────────────────
  let _pendingHex = null;

  window.closeTxModal = function() {
    document.getElementById('tx-confirm-modal').classList.add('hidden');
    _pendingHex = null;
  };

  function openTxModal(composedData, recipients, lockLabel) {
    _pendingHex = composedData.hex;
    const fee = composedData.fees?.coins?.decimal ?? '?';

    let body = '<div class="rounded-lg border border-gray-800 bg-gray-950 px-4 py-3 text-sm">' +
      '<span class="text-gray-500">Estimated fee: </span>' +
      '<span class="text-gray-100 font-medium">' + escHtml(fee) + ' ML</span>' +
    '</div>';

    if (lockLabel) {
      body += '<div class="rounded-lg border border-gray-800 bg-gray-950 px-4 py-3 text-sm">' +
        '<span class="text-gray-500">Timelock: </span>' +
        '<span class="text-gray-100">' + escHtml(lockLabel) + '</span>' +
      '</div>';
    }

    body += '<p class="text-xs text-gray-500 uppercase tracking-wider pt-1">Recipients</p>' +
      '<div class="space-y-1">' +
      recipients.map(function(r) {
        const ml = atomsToDecimal(r.atoms);
        return '<div class="flex justify-between gap-4 rounded border border-gray-800 bg-gray-950 px-3 py-2 text-xs">' +
          '<span class="text-gray-400 truncate font-mono">' + escHtml(r.address) + '</span>' +
          '<span class="text-gray-100 font-medium shrink-0">' + escHtml(ml) + ' ML</span>' +
        '</div>';
      }).join('') +
    '</div>';

    document.getElementById('tx-confirm-body').innerHTML = body;
    document.getElementById('tx-confirm-result').classList.add('hidden');
    document.getElementById('tx-confirm-result').innerHTML = '';
    document.getElementById('tx-confirm-actions').classList.remove('hidden');
    document.getElementById('tx-confirm-modal').classList.remove('hidden');

    const btn = document.getElementById('tx-confirm-btn');
    btn.onclick = async function() {
      btn.disabled = true;
      btn.textContent = 'Signing…';
      const signData = await api('sign-tx', { account: 0, hex: _pendingHex });
      if (!signData.ok) {
        showModalResult(errorBox(signData.error));
        btn.disabled = false; btn.textContent = 'Sign & Broadcast';
        return;
      }
      if (!signData.is_complete) {
        showModalResult('<div class="rounded-lg border border-yellow-900 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-400">Partially signed — additional signatures required.</div>');
        btn.disabled = false; btn.textContent = 'Sign & Broadcast';
        return;
      }
      btn.textContent = 'Broadcasting…';
      const bcData = await api('broadcast', { hex: signData.hex });
      if (!bcData.ok) {
        showModalResult(errorBox(bcData.error));
        btn.disabled = false; btn.textContent = 'Sign & Broadcast';
        return;
      }
      document.getElementById('tx-confirm-actions').classList.add('hidden');
      showModalResult(
        successBox('✓ Transaction broadcast') +
        '<p class="text-xs text-gray-400 mt-3 mb-1">Transaction ID</p>' +
        codeBlock(bcData.tx_id) +
        copyBtn(bcData.tx_id, 'Copy tx ID'),
      );
    };
  }

  function showModalResult(html) {
    const el = document.getElementById('tx-confirm-result');
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  window.doCompose = async function(prefix) {
    const recipients = collectRecipients(prefix + '-');
    if (!recipients.length) { showResult(prefix + '-result', errorBox('Add at least one recipient.')); return; }

    const data = await api('compose', { account: 0, recipients });
    if (!data.ok) { showResult(prefix + '-result', errorBox(data.error)); return; }
    document.getElementById(prefix + '-result').classList.add('hidden');
    openTxModal(data, recipients, null);
  };

  window.doComposeLocked = async function() {
    const recipients = collectRecipients('lms-');
    const lock_type  = val('lms-lock-type');
    const lock_value = val('lms-lock-value');
    if (!recipients.length) { showResult('lms-result', errorBox('Add at least one recipient.')); return; }
    if (!lock_value) { showResult('lms-result', errorBox('Enter a lock value.')); return; }

    const data = await api('compose-locked', { account: 0, recipients, lock_type, lock_value });
    if (!data.ok) { showResult('lms-result', errorBox(data.error)); return; }
    document.getElementById('lms-result').classList.add('hidden');
    const lockLabel = lock_type.replace(/([A-Z])/g, ' $1').trim() + ': ' + lock_value;
    openTxModal(data, recipients, lockLabel);
  };

  // ── Close modal on Esc ───────────────────────────────────────────────────
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') window.closeTxModal();
  });

  // ── Init: add one recipient row to each multisend tab ────────────────────
  window.addRecipient('ms-recipients',  'ms-');
  window.addRecipient('lms-recipients', 'lms-');

})();
</script>`;
}

// ── CSS snippets shared between template strings ──────────────────────────────

const inputCls   = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-mint-600';
const selectCls  = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-mint-600';
const btnPrimary = 'px-4 py-2 rounded bg-mint-600 hover:bg-mint-500 text-white text-sm font-medium transition-colors';
const btnSecondary = 'px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium transition-colors';

function field(id, label, type, defaultVal, placeholder) {
  return `<div>
    <label class="block text-xs text-gray-400 mb-1" for="${id}">${label}</label>
    <input id="${id}" type="${type}" value="${defaultVal}" placeholder="${placeholder}"
           class="${inputCls}" />
  </div>`;
}

function textarea(id, label, placeholder) {
  return `<div>
    <label class="block text-xs text-gray-400 mb-1" for="${id}">${label}</label>
    <textarea id="${id}" rows="3" placeholder="${placeholder}"
              class="${inputCls} resize-y font-mono text-xs"></textarea>
  </div>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handler(request, context) {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/plugins/tools/api/')) {
    return handleApi(url.pathname, request, context);
  }

  return { title: 'Wallet Tools', html: renderPage() };
}
