// Usage summary for Optiq, sent to Telegram (or printed when TELEGRAM_* is not set).
// Sources: npm download counts, GitHub repo stats, traffic + referrers (needs a token with push access to the repo),
// code search for other projects mentioning the packages, the status of catalogue submissions, and listings.
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GH_TOKEN (GITHUB_TOKEN is enough except for traffic), GH_TRAFFIC_TOKEN (optional).
const REPO = "Baukaalm/optiq";
const PACKAGES = ["optiq-image", "optiq-mcp"];
const SUBMISSIONS = [
  { label: "awesome-mcp-servers PR", api: "repos/punkpeye/awesome-mcp-servers/pulls/17911" },
  { label: "mcp.so issue", api: "repos/chatmcp/mcpso/issues/6322" },
];

const get = async (url, headers = {}) => {
  try {
    const r = await fetch(url, { headers: { "user-agent": "optiq-usage-report", ...headers } });
    return r.ok ? { ok: true, status: r.status, json: r.headers.get("content-type")?.includes("json") ? await r.json() : undefined } : { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, status: String(e) };
  }
};
const gh = (path, token = process.env.GH_TOKEN) =>
  get(`https://api.github.com/${path}`, { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

const lines = [`<b>Optiq usage</b> · ${new Date().toISOString().slice(0, 10)}`, ""];

lines.push("<b>npm downloads</b> (day / week / month)");
for (const p of PACKAGES) {
  const n = await Promise.all(["last-day", "last-week", "last-month"].map((r) => get(`https://api.npmjs.org/downloads/point/${r}/${p}`)));
  lines.push(`• ${p}: ${n.map((x) => (x.ok ? x.json.downloads : "–")).join(" / ")}`);
}

const repo = await gh(`repos/${REPO}`);
lines.push("", "<b>GitHub</b>");
if (repo.ok) lines.push(`• ⭐ ${repo.json.stargazers_count} · forks ${repo.json.forks_count} · open issues ${repo.json.open_issues_count}`);
const trafficToken = process.env.GH_TRAFFIC_TOKEN;
if (trafficToken) {
  const [views, clones, refs] = await Promise.all(["traffic/views", "traffic/clones", "traffic/popular/referrers"].map((p) => gh(`repos/${REPO}/${p}`, trafficToken)));
  if (views.ok) lines.push(`• views 14d: ${views.json.count} (${views.json.uniques} unique)`);
  if (clones.ok) lines.push(`• clones 14d: ${clones.json.count} (${clones.json.uniques} unique, includes CI)`);
  if (refs.ok && refs.json.length) lines.push(`• referrers: ${refs.json.map((r) => `${r.referrer} ${r.uniques}`).join(", ")}`);
  if (!views.ok) lines.push(`• traffic: HTTP ${views.status}`);
} else lines.push("• traffic: no GH_TRAFFIC_TOKEN");

// Other repositories mentioning the packages. Code search matches tokens loosely, so known false positives are skipped:
// NIQ's unrelated "niq-optiq" server, and AnatolyChesnokov/optiq ("optiq-images" zip name, predates the package).
const UNRELATED = new Set(["AnatolyChesnokov/optiq"]);
const mentions = new Set();
for (const q of ['"optiq-mcp"', '"optiq-image"']) {
  const r = await gh(`search/code?q=${encodeURIComponent(q)}&per_page=50`);
  if (r.ok) for (const i of r.json.items) if (!i.repository.full_name.startsWith("Baukaalm/") && !i.path.includes("niq-optiq") && !UNRELATED.has(i.repository.full_name)) mentions.add(i.repository.full_name);
}
lines.push(`• repos mentioning optiq-mcp / optiq-image: ${mentions.size ? [...mentions].join(", ") : "none"}`);

lines.push("", "<b>Catalogues</b>");
for (const s of SUBMISSIONS) {
  const r = await gh(s.api);
  if (!r.ok) {
    lines.push(`• ${s.label}: HTTP ${r.status}`);
    continue;
  }
  const state = r.json.merged_at ? "merged ✅" : r.json.state;
  lines.push(`• <a href="${r.json.html_url}">${s.label}</a>: ${state}, ${r.json.comments} comments, updated ${r.json.updated_at.slice(0, 10)}`);
}
const glama = await get(`https://glama.ai/mcp/servers/${REPO}`, { "user-agent": "Mozilla/5.0" });
lines.push(`• Glama: ${glama.ok ? "listed ✅" : `not listed (HTTP ${glama.status})`}`);
const registry = await get("https://registry.modelcontextprotocol.io/v0/servers?search=optiq-mcp");
const entry = registry.ok && registry.json.servers?.find((s) => (s.server ?? s).name === "io.github.Baukaalm/optiq-mcp");
lines.push(`• MCP Registry: ${entry ? `listed, ${(entry.server ?? entry).version}` : "not found"}`);
const ghRegistry = await get("https://api.mcp.github.com/v0/servers?search=optiq-mcp");
const inGh = ghRegistry.ok && JSON.stringify(ghRegistry.json).includes("optiq-mcp");
lines.push(`• GitHub MCP registry: ${inGh ? "listed ✅" : "not listed"}`);

const text = lines.join("\n");
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
if (!token || !chat) {
  console.log(text.replace(/<[^>]+>/g, ""));
} else {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram: HTTP ${r.status} ${await r.text()}`);
  console.log("sent");
}
