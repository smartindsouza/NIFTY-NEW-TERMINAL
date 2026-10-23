/**
 * <bias-panel> — "Check bias" button + note card for the NIFTY terminal.
 *
 * Usage (any page / any framework, including React):
 *   <script src="/bias-panel.js" defer></script>
 *   <bias-panel api-key="..."></bias-panel>        (api-key optional if your API is open or cookie-authed)
 *
 * Attributes:
 *   api-key   sent as X-API-Key
 *   base      API origin if the frontend is served elsewhere (default: same origin)
 *   compact   start collapsed to just the headline row
 */
(() => {
  if (customElements.get("bias-panel")) return;

  const css = `
  :host{--bg:#16181d;--card:#1c1f26;--line:#2a2e37;--text:#e7e9ee;--muted:#8b909c;
        --green:#3ddc84;--red:#ef5350;--amber:#f5b942;--purple:#8b5cf6;
        display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text)}
  *{box-sizing:border-box}
  :host{display:block}
  .wrap{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
  /* One row, always: More, Check bias and Hide sit together at the right. The
     title gives way first (ellipsis) on a narrow phone. */
  .top{display:flex;align-items:center;gap:10px;flex-wrap:nowrap}
  .title{font-weight:700;letter-spacing:.06em;font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .chip,button{flex-shrink:0}
  .chip{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid currentColor;text-transform:uppercase;letter-spacing:.05em}
  .bullish{color:var(--green)} .bearish{color:var(--red)} .neutral{color:var(--amber)}
  .conf{font-size:12px;color:var(--muted)}
  .spacer{flex:1}
  button{font:inherit;font-size:13px;font-weight:700;cursor:pointer;border-radius:10px;padding:8px 14px;
         background:var(--purple);color:#fff;border:0;display:inline-flex;align-items:center;gap:8px;min-height:36px}
  button:disabled{opacity:.6;cursor:default}
  button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);padding:6px 10px;min-height:32px}
  button.x{background:transparent;color:var(--muted);border:0;padding:4px 6px;min-height:32px;font-size:18px;line-height:1}
  .spin{width:14px;height:14px;border:2px solid #fff6;border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  .headline{margin:10px 0 0;font-size:15px;line-height:1.4;font-weight:700}
  .summary{margin:8px 0 0;font-size:13px;line-height:1.55;white-space:pre-wrap;color:#cfd3db}
  .levels{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px;margin-top:10px}
  .lv{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px}
  .lv b{display:block;font-size:14px}
  .lv span{font-size:11px;color:var(--muted)}
  .ext{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:10px;font-size:12px;color:var(--muted)}
  .ext i{font-style:normal;font-weight:700} .ext .up{color:var(--green)} .ext .dn{color:var(--red)}
  .meta{margin-top:8px;font-size:11px;color:var(--muted)}
  .err{margin-top:8px;font-size:12px;color:var(--red)}
  .collapsed .summary,.collapsed .levels{display:none}
  /* Collapsed is a two-row strip under the chart: top row + a 2-line headline. */
  .collapsed .ext,.collapsed .meta{display:none}
  .collapsed .headline{margin-top:6px;font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  /* Phone: compact sizes. 520, not 420: a Pro Max iPhone is 430 wide, which
     missed the old breakpoint and pushed "Check bias" onto its own line. */
  @media (max-width:520px){
    .wrap{padding:9px 10px;border-radius:12px}
    .top{gap:6px;flex-wrap:nowrap}
    .title{font-size:11px;white-space:nowrap}
    .chip{font-size:10px;padding:2px 7px}
    .conf{display:none} /* the headline already says e.g. "Bearish (moderate)" */
    button{font-size:12px;padding:6px 10px;min-height:32px;white-space:nowrap}
    button.x{padding:4px 4px;font-size:16px}
    button.ghost{padding:5px 8px;min-height:30px}
    .headline{font-size:14px}
    .levels{grid-template-columns:repeat(3,1fr)}
  }
  `;

  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 }));
  const time = (iso) => (iso ? String(iso).slice(11, 16) : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  class BiasPanel extends HTMLElement {
    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
      this.note = null;
      this.busy = false;
      this.err = "";
      this.collapsed = null;
    }
    connectedCallback() {
      // Read here, not in the constructor: React (and other frameworks) create the
      // element first and set its attributes afterwards, so `compact` was ignored.
      if (this.collapsed === null) this.collapsed = this.hasAttribute("compact");
      this.render(); this.load();
    }

    headers() {
      const h = { "Content-Type": "application/json" };
      const k = this.getAttribute("api-key");
      if (k) h["X-API-Key"] = k;
      return h;
    }
    url(p) { return (this.getAttribute("base") || "") + p; }

    async load() {
      try {
        const res = await fetch(this.url("/api/bias"), { headers: this.headers() });
        if (res.ok) { const j = await res.json(); this.note = j.latest; this.render(); }
      } catch (_) { /* stay quiet on first load */ }
    }

    async run(force) {
      if (this.busy) return;
      this.busy = true; this.err = ""; this.render();
      try {
        const res = await fetch(this.url("/api/bias/run" + (force ? "?force=1" : "")), { method: "POST", headers: this.headers(), body: "{}" });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (j.status === "error") { this.err = j.error || "Bias check failed"; if (j.previous) this.note = j.previous; }
        else this.note = j;
      } catch (e) { this.err = e.message; }
      this.busy = false; this.render();
    }

    render() {
      const n = this.note;
      const L = n?.levels || {};
      const lv = (label, v) => `<div class="lv"><span>${label}</span><b>${typeof v === "string" ? v : fmt(v)}</b></div>`;
      const cachedNote = n?.cached ? ` · unchanged (${n.cache_reason === "cooldown" ? "checked under a minute ago" : "no new candle"}) — <a href="#" data-force style="color:inherit">force</a>` : "";
      const src = n?.source === "scheduled" ? "09:35 auto" : n?.source === "on_demand" ? "on demand" : n?.source || "";
      const opening = !n?.phase || n.phase === "opening";
      const phaseLabel = { opening: "Opening read", morning: "Morning structure", midday: "Midday structure", afternoon: "Afternoon structure", post_close: "After close" }[n?.phase] || "";
      const sgn = (x) => (x == null ? "" : `${x > 0 ? "+" : ""}${x}%`);
      const cls = (x) => (x == null ? "" : x > 0 ? "up" : x < 0 ? "dn" : "");
      const pill = (label, x) => (x == null ? "" : `<span>${label} <i class="${cls(x)}">${sgn(x)}</i></span>`);
      const uf = n?.us_futures || {};
      const ext = n ? [
        n.gift?.change_pct != null ? pill(`GIFT ${fmt(n.gift.ltp)}`, n.gift.change_pct) : "",
        pill("Dow fut", uf.dow_fut?.change_pct), pill("S&P fut", uf.sp_fut?.change_pct), pill("Nasdaq fut", uf.nasdaq_fut?.change_pct),
        pill("Dow close", n.us30?.change_pct),
      ].filter(Boolean).join("") : "";

      this.root.innerHTML = `<style>${css}</style>
      <div class="wrap ${this.collapsed ? "collapsed" : ""}">
        <div class="top">
          <span class="title">NIFTY BIAS</span>
          ${n?.bias ? `<span class="chip ${n.bias}">${esc(n.bias)}</span><span class="conf">${esc(n.confidence || "")}</span>` : ""}
          <span class="spacer"></span>
          ${n ? `<button class="ghost" data-toggle>${this.collapsed ? "More" : "Less"}</button>` : ""}
          <button data-run ${this.busy ? "disabled" : ""}>${this.busy ? '<span class="spin"></span>Reading…' : "Check bias"}</button>
          <button class="x" data-hide title="Hide this card (bring it back from Indicators → NIFTY Bias card)" aria-label="Hide the bias card">×</button>
        </div>
        ${n ? `
          <p class="headline">${esc(n.headline)}</p>
          ${n.summary ? `<p class="summary">${esc(n.summary)}</p>` : ""}
          ${n.status === "ok" ? `<div class="levels">
            ${lv("Trigger", L.trigger)}${lv("Invalidation", L.invalidation)}${lv("Next ref", L.next_reference)}
            ${opening
              ? lv("15m high", L.or_high) + lv("15m low", L.or_low)
              : lv("Day high", L.day_high) + lv("Day low", L.day_low)}
            ${lv("CPR", L.cpr_bc != null ? `${fmt(Math.min(L.cpr_tc, L.cpr_bc))}–${fmt(Math.max(L.cpr_tc, L.cpr_bc))}` : null)}
          </div>` : ""}
          ${ext ? `<div class="ext">${ext}</div>` : ""}
          <div class="meta">${time(n.generated_at)} IST · ${esc(phaseLabel)}${src ? ` · ${esc(src)}` : ""}${n.ltp ? ` · NIFTY ${fmt(n.ltp)}` : ""}${cachedNote}</div>
        ` : `<p class="summary">No note yet today. Tap “Check bias” for a fresh read (takes ~10–20 s).</p>`}
        ${this.err ? `<div class="err">${esc(this.err)}</div>` : ""}
      </div>`;

      this.root.querySelector("[data-run]").onclick = () => this.run(false);
      const t = this.root.querySelector("[data-toggle]");
      if (t) t.onclick = () => { this.collapsed = !this.collapsed; this.render(); };
      // Hide: the page owns whether the card is shown (it is also switched back on
      // from the Indicators menu), so the card only announces the request.
      const h = this.root.querySelector("[data-hide]");
      if (h) h.onclick = () => window.dispatchEvent(new CustomEvent("terminal:bias-card", { detail: { hidden: true, from: "card" } }));
      const f = this.root.querySelector("[data-force]");
      if (f) f.onclick = (e) => { e.preventDefault(); this.run(true); };
    }
  }
  customElements.define("bias-panel", BiasPanel);
})();
