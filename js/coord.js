// Área da coordenação: login, painel, encontros (com QR ao vivo), pessoas e ajustes.
// Todo acesso a dados passa pelas regras do banco: só quem está na tabela coordinators lê/escreve.
import { sb } from "./config.js?v=20261023d";
import {
  esc, fmtDate, fmtShort, fmtPhone, maskPhone, onlyDigits, isValidPhone, waLink, firstName,
  todayISO, randomCode, getPosition, computeStats, firstTimeChecker, toCSV, download,
  MEETING_TYPES, HOW_FOUND, GROUP_TYPE,
} from "./lib.js?v=20261023d";

const $root = document.getElementById("root");
const S = {
  session: null, me: null, settings: null,
  meetings: [], people: [], attendances: [], coordinators: [],
  tab: tabFromHash(), filter: "Todos", search: "", sheet: null, qr: null,
  authMode: "login", authMsg: "", authErr: "",
};
let derived = null;

function tabFromHash() {
  const t = location.hash.replace("#", "");
  return ["painel", "encontros", "pessoas", "ajustes"].includes(t) ? t : "painel";
}

// ---------------------------------------------------------------- dados
async function fetchAll(table, cols = "*", order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    if (order) q = q.order(order);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function loadAll() {
  const [meetings, people, attendances, settings, coordinators] = await Promise.all([
    fetchAll("meetings", "*", "date"),
    fetchAll("people", "*", "full_name"),
    fetchAll("attendances", "id,meeting_id,person_id,source,verified,distance_m,created_at", "created_at"),
    sb.from("app_settings").select("*").eq("id", 1).single().then((r) => r.data),
    fetchAll("coordinators", "*", "created_at"),
  ]);
  Object.assign(S, { meetings, people, attendances, settings, coordinators });
  derive();
}

function derive() {
  const { stats, latest } = computeStats(S.people, S.meetings, S.attendances);
  const isFirst = firstTimeChecker(S.meetings, S.attendances);
  const byMeeting = new Map(S.meetings.map((m) => [m.id, []]));
  for (const a of S.attendances) byMeeting.get(a.meeting_id)?.push(a);
  const personById = new Map(S.people.map((p) => [p.id, p]));
  derived = { stats, latest, isFirst, byMeeting, personById };
}

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try { await loadAll(); render(); } catch (e) { console.error(e); }
  }, 400);
}

function subscribeRealtime() {
  sb.channel("coord-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "attendances" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "meetings" }, scheduleReload)
    .subscribe();
}

// ---------------------------------------------------------------- utilidades de UI
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg, role: "status" });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
const fail = (e) => { console.error(e); toast(`Não deu certo: ${e?.message || e}`); };
const statusPill = (s) => `<span class="pill ${s.toLowerCase()}">${s}</span>`;
const pillsFor = (p) => {
  const st = derived.stats.get(p.id);
  return `${st ? statusPill(st.status) : ""}${p.needs_review ? `<span class="pill rev">a confirmar</span>` : ""}`;
};
const meetingTitle = (m) => `${m.type}${m.theme ? ` · ${m.theme}` : ""}`;
const checkinUrl = (m) => new URL(`index.html?e=${encodeURIComponent(m.code)}`, location.href).href;
const isAdmin = () => S.me?.role === "admin";
const ICON = {
  painel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  encontros: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  pessoas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.4 3.5 5.2"/></svg>',
  ajustes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
};

// ---------------------------------------------------------------- telas de acesso
// Modos: login · signup · forgot (pedir link por e-mail) · recovery (veio do link, define senha nova)
const authShell = (title, body) => `
    <header class="hero"><p class="eyebrow">EJC Jardim Camburi</p><h1>Área da coordenação</h1>
      <p class="sub">Chamada, encontros e acompanhamento dos jovens</p></header>
    <main class="wrap"><div class="card">
      <form id="auth" class="stack" novalidate>
        <h2>${title}</h2>
        ${body}
        ${S.authErr ? `<p class="err">${esc(S.authErr)}</p>` : ""}
        ${S.authMsg ? `<p class="consent" style="display:block">${esc(S.authMsg)}</p>` : ""}
      </form>
    </div></main>`;

function setMode(mode) { S.authMode = mode; S.authErr = S.authMsg = ""; renderAuth(); }

function renderAuth() {
  if (S.authMode === "recovery") return renderRecovery();
  const signup = S.authMode === "signup", forgot = S.authMode === "forgot";
  const emailField = `<label class="field"><span>E-mail</span><input id="email" class="input" type="email" autocomplete="email" required value="${esc(S.authEmail || "")}"></label>`;
  const passField = `<label class="field"><span>Senha</span><input id="pass" class="input" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="6" required></label>`;
  const body = forgot
    ? `<p class="small muted">Digite o e-mail da sua conta. Vamos mandar um link para você criar uma senha nova.</p>
       ${emailField}
       <button class="btn primary xl" type="submit">Enviar link para o e-mail</button>
       <button class="linkbtn" type="button" data-mode="login">← Voltar para Entrar</button>`
    : `${signup ? `<p class="small muted">Use o e-mail que a coordenação cadastrou para você. Outros e-mails criam a conta, mas não têm acesso.</p>` : ""}
       ${emailField}${passField}
       ${signup ? "" : `<button class="linkbtn" type="button" data-mode="forgot" style="justify-self:end;padding:0 4px">Esqueci minha senha</button>`}
       <button class="btn primary xl" type="submit">${signup ? "Criar conta" : "Entrar"}</button>
       <button class="linkbtn" type="button" data-mode="${signup ? "login" : "signup"}">${signup ? "Já tenho conta → Entrar" : "Primeiro acesso? Criar conta"}</button>
       <a class="linkbtn center" href="index.html">← Voltar ao início</a>`;
  $root.innerHTML = authShell(signup ? "Criar conta" : forgot ? "Esqueci minha senha" : "Entrar", body);
  $root.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => {
    S.authEmail = $root.querySelector("#email")?.value.trim().toLowerCase() || S.authEmail;
    setMode(b.dataset.mode);
  }));
  $root.querySelector("#auth").onsubmit = async (e) => {
    e.preventDefault();
    const email = $root.querySelector("#email").value.trim().toLowerCase();
    S.authEmail = email;
    S.authErr = S.authMsg = "";
    const btn = $root.querySelector("[type=submit]");
    btn.disabled = true;
    if (forgot) {
      if (!/^\S+@\S+\.\S+$/.test(email)) { S.authErr = "Digite o e-mail da sua conta."; return renderAuth(); }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) S.authErr = traduz(error.message);
      else S.authMsg = `Pronto! Se ${email} tiver conta, chega em instantes um e-mail com o link para criar uma senha nova. Veja também o spam. O link vale por 1 hora.`;
      return renderAuth();
    }
    const password = $root.querySelector("#pass").value;
    if (!email || password.length < 6) { S.authErr = "Preencha o e-mail e uma senha com pelo menos 6 caracteres."; return renderAuth(); }
    if (signup) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) S.authErr = traduz(error.message);
      else if (!data.session) { S.authMode = "login"; S.authMsg = "Conta criada! Abra o e-mail de confirmação que chegou na sua caixa (veja o spam) e depois entre aqui."; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) S.authErr = traduz(error.message);
    }
    renderAuth();
  };
}

function renderRecovery() {
  if (!S.session) {
    S.authMode = "forgot";
    S.authErr = "Esse link expirou ou já foi usado. Peça um novo abaixo.";
    return renderAuth();
  }
  $root.innerHTML = authShell("Criar senha nova", `
    <p class="small muted">Conta: <b>${esc(S.session.user.email)}</b></p>
    <label class="field"><span>Nova senha</span><input id="pass" class="input" type="password" autocomplete="new-password" minlength="6" required></label>
    <label class="field"><span>Repita a nova senha</span><input id="pass2" class="input" type="password" autocomplete="new-password" minlength="6" required></label>
    <p class="tiny muted">Dica: 3 ou 4 palavras soltas com um número. Senhas muito comuns são recusadas.</p>
    <button class="btn primary xl" type="submit">Salvar senha nova</button>`);
  $root.querySelector("#auth").onsubmit = async (e) => {
    e.preventDefault();
    const p1 = $root.querySelector("#pass").value, p2 = $root.querySelector("#pass2").value;
    S.authErr = S.authMsg = "";
    if (p1.length < 6) { S.authErr = "A senha precisa ter pelo menos 6 caracteres."; return renderRecovery(); }
    if (p1 !== p2) { S.authErr = "As duas senhas não estão iguais."; return renderRecovery(); }
    $root.querySelector("[type=submit]").disabled = true;
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { S.authErr = traduz(error.message); return renderRecovery(); }
    S.authMode = "login";
    history.replaceState(null, "", location.pathname);
    toast("Senha nova salva");
    onSession(S.session);
  };
}

function traduz(m = "") {
  if (/Invalid login/i.test(m)) return "E-mail ou senha incorretos.";
  if (/not confirmed/i.test(m)) return "Falta confirmar o e-mail. Procure a mensagem de confirmação na sua caixa de entrada ou no spam.";
  if (/already registered/i.test(m)) return "Esse e-mail já tem conta. Use Entrar.";
  if (/weak|easy to guess|pwned|leaked/i.test(m)) return "Essa senha é fraca ou já apareceu em vazamentos de dados. Escolha outra mais forte, por exemplo 3 ou 4 palavras soltas com um número.";
  if (/at least|should be|characters/i.test(m)) return "A senha precisa ter pelo menos 6 caracteres.";
  if (/invalid.*email|email.*invalid/i.test(m)) return "Confira o e-mail digitado.";
  if (/same.*password|different from the old/i.test(m)) return "A senha nova precisa ser diferente da antiga.";
  if (/rate limit|security purposes|seconds/i.test(m)) return "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
  if (/rate limit/i.test(m)) return "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
  return m;
}

function renderNoAccess() {
  $root.innerHTML = `
    <header class="hero"><p class="eyebrow">EJC Jardim Camburi</p><h1>Sem acesso</h1></header>
    <main class="wrap"><div class="card stack center">
      <p>Você entrou como <b>${esc(S.session.user.email)}</b>, mas esse e-mail ainda não faz parte da coordenação.</p>
      <p class="muted">Peça para a coordenação cadastrar seu e-mail em Ajustes → Equipe e depois entre de novo.</p>
      <button class="btn primary block" data-act="logout">Sair</button>
    </div></main>`;
}

// ---------------------------------------------------------------- shell
function render() {
  if (!S.session) return renderAuth();
  if (!S.me) return renderNoAccess();
  const tabs = [["painel", "Painel"], ["encontros", "Encontros"], ["pessoas", "Pessoas"], ["ajustes", "Ajustes"]];
  const scrollY = window.scrollY;
  $root.innerHTML = `
    <div class="app">
      <header class="topbar"><div class="inner">
        <div><p class="eyebrow">${esc(S.settings?.group_name || "EJC Jardim Camburi")}</p><h1>${tabs.find((t) => t[0] === S.tab)[1]}</h1></div>
        ${openMeeting() ? `<button class="btn gold sm" data-act="qr" data-id="${openMeeting().id}">Mostrar QR</button>` : ""}
      </div></header>
      <main class="page" id="page">${({ painel: viewPainel, encontros: viewEncontros, pessoas: viewPessoas, ajustes: viewAjustes })[S.tab]()}</main>
      <nav class="tabbar" aria-label="Seções">${tabs.map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ""}>${ICON[k]}${l}</button>`).join("")}</nav>
    </div>
    ${S.sheet ? renderSheet() : ""}
    ${S.qr ? renderQR() : ""}`;
  window.scrollTo(0, scrollY);
  document.body.style.overflow = S.qr || S.sheet ? "hidden" : "";
  afterRender();
}

function afterRender() {
  const search = $root.querySelector("#search");
  if (search) search.oninput = (e) => { S.search = e.target.value; $root.querySelector("#people-list").innerHTML = peopleList(); };
  const add = $root.querySelector("#add-search");
  if (add) add.oninput = (e) => { S.sheet.q = e.target.value; $root.querySelector("#add-results").innerHTML = addResults(); };
  const merge = $root.querySelector("#merge-search");
  if (merge) merge.oninput = (e) => { S.sheet.mq = e.target.value; $root.querySelector("#merge-results").innerHTML = mergeResults(); };
  $root.querySelectorAll("[data-mask=phone]").forEach((i) => (i.oninput = () => (i.value = maskPhone(i.value))));
  if (S.qr) drawQR();
}

const openMeeting = () => [...S.meetings].reverse().find((m) => m.is_open);

// ---------------------------------------------------------------- Painel
function viewPainel() {
  const { latest, stats, byMeeting, isFirst, personById } = derived;
  const all = [...stats.values()];
  const count = (s) => all.filter((x) => x.status === s).length;
  const latestAtt = latest ? byMeeting.get(latest.id) : [];
  const latestNew = latestAtt.filter((a) => isFirst(latest.id, a.person_id));
  const om = openMeeting();

  if (!S.meetings.length) return `<section class="panel empty"><p>Nenhum encontro ainda.</p><button class="btn primary" data-act="new-meeting">Criar encontro de hoje</button></section>`;

  const toCall = [
    ...latestNew.map((a) => ({ p: personById.get(a.person_id), why: "Novo", msg: (n) => `Oi, ${n}! Que alegria ter você no grupo de jovens. Esperamos você no próximo encontro! 💙` })),
    ...S.people.filter((p) => stats.get(p.id)?.status === "Sumido").map((p) => ({ p, why: "Sumido", msg: (n) => `Oi, ${n}! Sentimos sua falta no grupo de jovens. Tá tudo bem? Vai ser muito bom te ver no próximo encontro 💙` })),
  ].filter((x) => x.p);

  return `
    ${om ? `<section class="panel" style="border-color:var(--ok)">
      <div class="panel-head"><div><span class="pill open">Chamada aberta</span><h2 style="margin-top:6px">${esc(meetingTitle(om))}</h2>
      <p class="small muted">${fmtDate(om.date, true)} · ${byMeeting.get(om.id).length} presentes até agora</p></div>
      <div class="row"><button class="btn gold" data-act="qr" data-id="${om.id}">Mostrar QR</button><button class="btn" data-act="toggle" data-id="${om.id}">Fechar chamada</button></div></div>
    </section>` : ""}

    <section class="stats">
      <div class="stat hl"><b>${latestAtt.length}</b><span>presentes no último encontro${latest ? ` (${fmtShort(latest.date)})` : ""}</span></div>
      <div class="stat"><b>${latestNew.length}</b><span>vieram pela 1ª vez</span></div>
      <div class="stat"><b>${count("Frequente")}</b><span>frequentes</span></div>
      <div class="stat"><b>${count("Sumido")}</b><span>sumidos</span></div>
      <div class="stat"><b>${S.people.length}</b><span>pessoas cadastradas</span></div>
      <div class="stat"><b>${S.people.filter((p) => p.needs_review).length}</b><span>com dados a confirmar</span></div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Presença por encontro</h2>
        <div class="legend"><span><i style="background:var(--gold)"></i>1ª vez</span><span><i style="background:var(--navy)"></i>já vinham</span></div></div>
      ${chart()}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Para a acolhida chamar essa semana</h2><span class="small muted">${toCall.length} pessoa${toCall.length === 1 ? "" : "s"}</span></div>
      ${toCall.length ? `<div class="list">${toCall.map(({ p, why, msg }) => {
        const link = waLink(p.phone, msg(firstName(p.full_name)));
        return `<div class="item"><div class="main"><div class="name">${esc(p.full_name)}</div>
          <div class="meta">${statusPill(why)}<span>${why === "Novo" ? "dar boas-vindas" : "sentimos sua falta"}</span><span>${esc(fmtPhone(p.phone))}</span></div></div>
          ${link ? `<a class="btn wa sm" href="${link}" target="_blank" rel="noopener">WhatsApp</a>` : `<span class="tiny muted">sem telefone</span>`}</div>`;
      }).join("")}</div>` : `<p class="muted small">Ninguém novo nem sumido por enquanto. Os nomes aparecem aqui depois de cada encontro.</p>`}
    </section>

    <section class="panel">
      <h2>Exportar planilhas</h2>
      <p class="small muted">Abre no Excel ou no Google Planilhas.</p>
      <div class="row"><button class="btn" data-act="csv-people">Pessoas (.csv)</button><button class="btn" data-act="csv-att">Presenças (.csv)</button></div>
    </section>`;
}

function chart() {
  const { byMeeting, isFirst } = derived;
  const ms = S.meetings.filter((m) => m.date <= todayISO() || byMeeting.get(m.id).length).slice(-10);
  if (!ms.length) return `<p class="muted small">O gráfico aparece depois do primeiro encontro.</p>`;
  const data = ms.map((m) => {
    const att = byMeeting.get(m.id);
    const n = att.filter((a) => isFirst(m.id, a.person_id)).length;
    return { m, n, r: att.length - n, t: att.length };
  });
  const max = Math.max(5, ...data.map((d) => d.t));
  const step = max <= 10 ? 2 : max <= 30 ? 5 : 10;
  const top = Math.ceil(max / step) * step;
  const W = Math.round(Math.min(900, Math.max(300, (document.documentElement.clientWidth || 640) - 70))), H = 230, L = 30, B = 40, T = 18, R = 8;
  const bw = Math.min(56, (W - L - R) / data.length * 0.6);
  const x = (i) => L + (W - L - R) / data.length * (i + 0.5);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const grid = [];
  for (let v = 0; v <= top; v += step) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  const bars = data.map((d, i) => {
    const cx = x(i), xl = cx - bw / 2;
    return `<g><title>${fmtDate(d.m.date)} · ${d.t} presentes (${d.n} pela 1ª vez)</title>
      <rect x="${xl}" y="${y(d.r)}" width="${bw}" height="${y(0) - y(d.r)}" fill="var(--navy)" rx="3"/>
      <rect x="${xl}" y="${y(d.t)}" width="${bw}" height="${y(d.r) - y(d.t)}" fill="var(--gold)" rx="3"/>
      <text x="${cx}" y="${y(d.t) - 5}" text-anchor="middle" style="font-weight:700;fill:var(--ink)">${d.t}</text>
      <text x="${cx}" y="${H - B + 16}" text-anchor="middle">${fmtShort(d.m.date)}</text>
      <text x="${cx}" y="${H - B + 30}" text-anchor="middle">${esc(d.m.type === GROUP_TYPE ? "grupo" : d.m.type.toLowerCase())}</text></g>`;
  }).join("");
  return `<div style="overflow-x:auto"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Presentes por encontro">${grid.join("")}${bars}</svg></div>`;
}

// ---------------------------------------------------------------- Encontros
function viewEncontros() {
  const { byMeeting, isFirst } = derived;
  const list = [...S.meetings].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.created_at.localeCompare(a.created_at)));
  return `
    <section class="panel">
      <div class="panel-head"><div><h2>Encontros</h2><p class="small muted">Abra a chamada no dia e mostre o QR na entrada.</p></div>
      <button class="btn primary" data-act="new-meeting">+ Criar encontro</button></div>
      ${list.length ? list.map((m) => {
        const att = byMeeting.get(m.id);
        const news = att.filter((a) => isFirst(m.id, a.person_id)).length;
        return `<article class="meeting ${m.is_open ? "is-open" : ""}">
          <div class="panel-head"><div><p class="small muted">${fmtDate(m.date, true)} · código <b class="num">${esc(m.code)}</b></p>
            <h3>${esc(meetingTitle(m))}</h3></div>
            <span class="pill ${m.is_open ? "open" : "closed"}">${m.is_open ? "chamada aberta" : "chamada fechada"}</span></div>
          <p class="small"><b class="num">${att.length}</b> presentes${news ? ` · <b class="num">${news}</b> pela 1ª vez` : ""}</p>
          <div class="row">
            <button class="btn sm ${m.is_open ? "" : "primary"}" data-act="toggle" data-id="${m.id}">${m.is_open ? "Fechar chamada" : "Abrir chamada"}</button>
            <button class="btn sm gold" data-act="qr" data-id="${m.id}">Mostrar QR</button>
            <button class="btn sm" data-act="meeting" data-id="${m.id}">Ver presentes</button>
            <button class="btn sm ghost" data-act="edit-meeting" data-id="${m.id}">Editar</button>
          </div></article>`;
      }).join("") : `<div class="empty"><p>Nenhum encontro ainda.</p><button class="btn primary" data-act="new-meeting">Criar encontro de hoje</button></div>`}
    </section>`;
}

// ---------------------------------------------------------------- Pessoas
const FILTERS = ["Todos", "Novo", "Frequente", "Ocasional", "Sumido", "A confirmar"];
function filteredPeople() {
  const q = S.search.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const qd = onlyDigits(S.search);
  return S.people.filter((p) => {
    const st = derived.stats.get(p.id);
    if (S.filter === "A confirmar" && !p.needs_review) return false;
    if (!["Todos", "A confirmar"].includes(S.filter) && st?.status !== S.filter) return false;
    if (!q) return true;
    const name = p.full_name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    return name.includes(q) || (qd.length >= 3 && (p.phone || "").includes(qd));
  });
}
function peopleList() {
  const list = filteredPeople();
  if (!list.length) return `<div class="empty"><p>Ninguém encontrado${S.search ? ` para “${esc(S.search)}”` : ""}.</p></div>`;
  return `<p class="small muted">${list.length} pessoa${list.length === 1 ? "" : "s"}</p>` + list.map((p) => {
    const st = derived.stats.get(p.id);
    return `<div class="item click" data-act="person" data-id="${p.id}" role="button" tabindex="0">
      <div class="main"><div class="name">${esc(p.full_name)}</div>
      <div class="meta">${pillsFor(p)}<span class="num">${esc(fmtPhone(p.phone))}</span></div></div>
      <div class="center" style="min-width:64px"><b class="num" style="font-size:1.2rem">${st?.total ?? 0}</b><div class="tiny muted">presença${st?.total === 1 ? "" : "s"}</div></div></div>`;
  }).join("");
}
function viewPessoas() {
  return `
    <section class="panel">
      <div class="panel-head"><h2>Pessoas</h2><button class="btn primary sm" data-act="new-person">+ Adicionar pessoa</button></div>
      <input id="search" class="input" type="search" placeholder="Buscar por nome ou telefone" value="${esc(S.search)}" autocomplete="off">
      <div class="chips">${FILTERS.map((f) => `<button class="chip" data-filter="${f}" aria-pressed="${S.filter === f}">${f}</button>`).join("")}</div>
      <div class="list" id="people-list">${peopleList()}</div>
      <p class="tiny muted">Novo: veio só uma vez, no último encontro · Frequente: 3 ou mais dos últimos 4 grupos · Sumido: já veio 2+ vezes e faltou aos 2 últimos grupos.</p>
    </section>`;
}

// ---------------------------------------------------------------- Ajustes
function viewAjustes() {
  const s = S.settings || {};
  return `
    <section class="panel">
      <h2>Grupo e local</h2>
      <form id="settings" class="stack" novalidate>
        <label class="field"><span>Nome do grupo</span><input id="s-name" class="input" value="${esc(s.group_name)}"></label>
        <label class="field"><span>Link do grupo do WhatsApp</span>
          <input id="s-wa" class="input" type="url" placeholder="https://chat.whatsapp.com/..." value="${esc(s.whatsapp_group_url || "")}">
          <small class="muted">Aparece como botão “Entrar no grupo do WhatsApp” depois que o jovem confirma a presença. Deixe vazio para esconder.</small></label>
        <label class="field"><span>Nome do local</span><input id="s-loc" class="input" value="${esc(s.location_name)}"></label>
        <div class="grid2">
          <label class="field"><span>Latitude</span><input id="s-lat" class="input num" inputmode="decimal" value="${esc(s.lat)}"></label>
          <label class="field"><span>Longitude</span><input id="s-lng" class="input num" inputmode="decimal" value="${esc(s.lng)}"></label>
        </div>
        <button type="button" class="btn" data-act="here">📍 Usar minha localização atual</button>
        <small class="muted">Faça isso estando dentro da matriz: é o ponto usado para marcar “verificado no local”.</small>
        <label class="field"><span>Raio de verificação (metros)</span><input id="s-radius" class="input num" type="number" min="30" max="2000" value="${esc(s.radius_m)}"></label>
        <button class="btn primary" type="submit">Salvar ajustes</button>
      </form>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Equipe</h2><span class="small muted">${S.coordinators.length} e-mail${S.coordinators.length === 1 ? "" : "s"}</span></div>
      <p class="small muted">Quem está aqui pode entrar na coordenação. A pessoa cria a conta com este mesmo e-mail.</p>
      <div class="list">${S.coordinators.map((c) => `
        <div class="item"><div class="main"><div class="name">${esc(c.email)}</div>
          <div class="meta"><span class="pill ${c.role === "admin" ? "novo" : "ocasional"}">${c.role === "admin" ? "admin" : c.role}</span>
          <span>${c.user_id ? "conta criada" : "aguardando criar a conta"}</span></div></div>
          ${isAdmin() && c.user_id !== S.session.user.id ? (S.confirmCoord === c.id
            ? `<span class="confirm-inline">Remover? <button class="btn sm danger" data-act="del-coord" data-id="${c.id}">Sim</button><button class="btn sm" data-act="cancel-coord">Não</button></span>`
            : `<button class="btn sm ghost" data-act="ask-del-coord" data-id="${c.id}">Remover</button>`) : ""}
        </div>`).join("")}</div>
      ${isAdmin() ? `<form id="coord-add" class="row" novalidate>
        <input id="c-email" class="input" style="flex:2 1 220px" type="email" placeholder="email@exemplo.com">
        <select id="c-role" class="input" style="flex:1 1 130px"><option value="acolhida">acolhida</option><option value="coordenacao">coordenação</option><option value="admin">admin</option></select>
        <button class="btn primary" type="submit">Adicionar</button></form>` : `<p class="tiny muted">Só administradores adicionam pessoas na equipe.</p>`}
    </section>

    <section class="panel">
      <h2>Sua conta</h2>
      <p class="small">${esc(S.session.user.email)} · ${esc(S.me.role)}</p>
      <details id="pass-box"><summary class="small" style="cursor:pointer;font-weight:700">Trocar minha senha</summary>
        <form id="pass-change" class="stack" style="margin-top:12px" novalidate>
          <label class="field"><span>Senha atual</span><input id="pc-old" class="input" type="password" autocomplete="current-password"></label>
          <label class="field"><span>Nova senha</span><input id="pc-new" class="input" type="password" autocomplete="new-password" minlength="6"></label>
          <label class="field"><span>Repita a nova senha</span><input id="pc-new2" class="input" type="password" autocomplete="new-password" minlength="6"></label>
          <p class="tiny muted">Dica: 3 ou 4 palavras soltas com um número. Senhas muito comuns são recusadas.</p>
          <button class="btn primary" type="submit">Salvar senha nova</button>
        </form>
      </details>
      <div class="row"><button class="btn" data-act="logout">Sair</button><a class="btn ghost" href="index.html">Ver página pública</a></div>
    </section>`;
}

// ---------------------------------------------------------------- folhas (sheets)
function renderSheet() {
  const k = S.sheet.kind;
  const body = { meetingForm: sheetMeetingForm, meeting: sheetMeeting, person: sheetPerson, personForm: sheetPersonForm }[k]();
  return `<div class="sheet-bg" data-act="close-sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
}
const sheetHead = (title, sub = "") => `<div class="sheet-head"><div>${sub ? `<p class="small muted">${sub}</p>` : ""}<h2>${title}</h2></div><button class="btn sm" data-act="close-sheet" aria-label="Fechar">✕</button></div>`;

function sheetMeetingForm() {
  const m = S.sheet.id ? S.meetings.find((x) => x.id === S.sheet.id) : null;
  const att = m ? derived.byMeeting.get(m.id).length : 0;
  return `${sheetHead(m ? "Editar encontro" : "Criar encontro")}
    <form id="meeting-form" class="stack" novalidate>
      <label class="field"><span>Data</span><input id="m-date" class="input" type="date" value="${esc(m?.date || todayISO())}"></label>
      <div class="field"><span>Tipo</span><div class="chips">${MEETING_TYPES.map((t) => `<button type="button" class="chip" data-mtype="${t}" aria-pressed="${(m?.type || GROUP_TYPE) === t}">${t}</button>`).join("")}</div></div>
      <label class="field"><span>Tema ou pregador (opcional)</span><input id="m-theme" class="input" value="${esc(m?.theme || "")}" placeholder="Ex.: Maria · tia Cacá"></label>
      ${m ? "" : `<label class="consent"><input type="checkbox" id="m-open" checked><span>Já abrir a chamada</span></label>`}
      <button class="btn primary xl" type="submit">${m ? "Salvar" : "Criar encontro"}</button>
      ${m && att === 0 ? (S.sheet.confirmDel
        ? `<div class="confirm-inline">Apagar este encontro? <button type="button" class="btn sm danger" data-act="del-meeting" data-id="${m.id}">Apagar</button><button type="button" class="btn sm" data-act="cancel-del">Cancelar</button></div>`
        : `<button type="button" class="btn danger" data-act="ask-del-meeting">Apagar encontro</button>`) : ""}
    </form>`;
}

function sheetMeeting() {
  const m = S.meetings.find((x) => x.id === S.sheet.id);
  if (!m) return sheetHead("Encontro não encontrado");
  const att = [...derived.byMeeting.get(m.id)].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const badge = (a) => [
    derived.isFirst(m.id, a.person_id) ? `<span class="pill novo">1ª vez</span>` : "",
    a.source === "qr" ? (a.verified ? `<span class="pill frequente">verificado no local</span>` : `<span class="pill rev">sem verificação${a.distance_m != null ? ` · ${a.distance_m >= 1000 ? (a.distance_m / 1000).toFixed(1) + " km" : a.distance_m + " m"}` : ""}</span>`) : "",
    a.source === "manual" ? `<span class="pill ocasional">manual</span>` : "",
    a.source === "papel" ? `<span class="pill ocasional">lista de papel</span>` : "",
  ].join("");
  return `${sheetHead(esc(meetingTitle(m)), `${fmtDate(m.date, true)} · código ${esc(m.code)}`)}
    <div class="row"><span class="pill ${m.is_open ? "open" : "closed"}">${m.is_open ? "chamada aberta" : "chamada fechada"}</span><b class="num">${att.length} presentes</b></div>
    <section class="panel">
      <h3>Adicionar presença manual</h3>
      <p class="small muted">Para quem está sem celular ou sem internet.</p>
      <input id="add-search" class="input" type="search" placeholder="Buscar por nome ou telefone" value="${esc(S.sheet.q || "")}" autocomplete="off">
      <div class="list" id="add-results">${addResults()}</div>
      <details><summary class="small" style="cursor:pointer;font-weight:700">Pessoa nova (ainda não cadastrada)</summary>
        <form id="quick-add" class="stack" style="margin-top:10px" novalidate>
          <input id="qa-name" class="input" placeholder="Nome completo">
          <input id="qa-phone" class="input" data-mask="phone" inputmode="tel" placeholder="WhatsApp (opcional)">
          <button class="btn primary" type="submit">Cadastrar e marcar presença</button>
        </form></details>
    </section>
    <section class="panel"><h3>Presentes</h3>
      ${att.length ? `<div class="list">${att.map((a) => {
        const p = derived.personById.get(a.person_id);
        return `<div class="item"><div class="main"><div class="name">${esc(p?.full_name || "—")}</div><div class="meta">${badge(a)}</div></div>
          ${S.sheet.confirmAtt === a.id
            ? `<span class="confirm-inline">Remover? <button class="btn sm danger" data-act="del-att" data-id="${a.id}">Sim</button><button class="btn sm" data-act="cancel-att">Não</button></span>`
            : `<button class="btn sm ghost" data-act="ask-del-att" data-id="${a.id}" aria-label="Remover presença">Remover</button>`}</div>`;
      }).join("")}</div>` : `<p class="muted small">Ninguém ainda. ${m.is_open ? "Mostre o QR na entrada." : "Abra a chamada para receber presenças pelo QR."}</p>`}
    </section>`;
}

function addResults() {
  const m = S.sheet.id;
  const q = (S.sheet.q || "").trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (q.length < 2) return `<p class="tiny muted">Digite pelo menos 2 letras.</p>`;
  const present = new Set(derived.byMeeting.get(m).map((a) => a.person_id));
  const qd = onlyDigits(q);
  const res = S.people.filter((p) => {
    const n = p.full_name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    return n.includes(q) || (qd.length >= 3 && (p.phone || "").includes(qd));
  }).slice(0, 8);
  if (!res.length) return `<p class="tiny muted">Ninguém com esse nome. Use “Pessoa nova” abaixo.</p>`;
  return res.map((p) => `<div class="item"><div class="main"><div class="name">${esc(p.full_name)}</div><div class="meta">${esc(fmtPhone(p.phone))}</div></div>
    ${present.has(p.id) ? `<span class="pill frequente">presente</span>` : `<button class="btn sm primary" data-act="add-att" data-id="${p.id}">Marcar presença</button>`}</div>`).join("");
}

function sheetPerson() {
  const p = derived.personById.get(S.sheet.id);
  if (!p) return sheetHead("Pessoa não encontrada");
  const st = derived.stats.get(p.id);
  const hist = S.attendances.filter((a) => a.person_id === p.id)
    .map((a) => ({ a, m: S.meetings.find((m) => m.id === a.meeting_id) })).filter((x) => x.m)
    .sort((x, y) => (x.m.date < y.m.date ? 1 : -1));
  const link = waLink(p.phone);
  return `${sheetHead(esc(p.full_name), pillsFor(p))}
    <div class="row">
      ${link ? `<a class="btn wa" href="${link}" target="_blank" rel="noopener">Chamar no WhatsApp</a>` : ""}
      <button class="btn" data-act="edit-person" data-id="${p.id}">Editar dados</button>
    </div>
    <section class="stats">
      <div class="stat"><b>${st.total}</b><span>presenças</span></div>
      <div class="stat"><b>${st.group4 ? `${st.freq4}/${st.group4}` : "—"}</b><span>nos últimos grupos</span></div>
      <div class="stat"><b style="font-size:1.2rem">${fmtDate(st.first)}</b><span>1ª presença</span></div>
    </section>
    <section class="panel">
      <div class="list">
        <div class="item"><div class="main"><div class="meta">WhatsApp</div><div class="name num">${esc(fmtPhone(p.phone))}</div></div></div>
        ${p.birth_date ? `<div class="item"><div class="main"><div class="meta">Nascimento</div><div class="name">${fmtDate(p.birth_date)}</div></div></div>` : ""}
        ${p.how_found ? `<div class="item"><div class="main"><div class="meta">Como conheceu</div><div class="name">${esc(p.how_found)}${p.invited_by ? ` · convidado(a) por ${esc(p.invited_by)}` : ""}</div></div></div>` : ""}
        <div class="item"><div class="main"><div class="meta">Avisos pelo WhatsApp</div><div class="name">${p.whatsapp_consent ? "autorizou" : "ainda não autorizou (autoriza no 1º check-in pelo QR)"}</div></div></div>
        ${p.notes ? `<div class="item"><div class="main"><div class="meta">Observações</div><div class="name" style="font-weight:500;white-space:pre-wrap">${esc(p.notes)}</div></div></div>` : ""}
      </div>
    </section>
    <section class="panel"><h3>Histórico</h3>
      ${hist.length ? `<div class="list">${hist.map(({ a, m }) => `<div class="item"><div class="main"><div class="name">${fmtDate(m.date, true)}</div><div class="meta">${esc(meetingTitle(m))} · ${({ qr: "QR", manual: "manual", papel: "lista de papel" })[a.source]}</div></div></div>`).join("")}</div>` : `<p class="small muted">Nenhuma presença registrada.</p>`}
    </section>
    <section class="panel"><h3>Mesclar com outro cadastro</h3>
      <p class="small muted">Para quando a mesma pessoa foi cadastrada duas vezes (ex.: telefone errado na lista de papel). As presenças do outro cadastro passam para este, e o outro some.</p>
      <input id="merge-search" class="input" type="search" placeholder="Buscar o cadastro duplicado" value="${esc(S.sheet.mq || "")}" autocomplete="off">
      <div class="list" id="merge-results">${mergeResults()}</div>
    </section>`;
}

function mergeResults() {
  const q = (S.sheet.mq || "").trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (q.length < 2) return "";
  const res = S.people.filter((p) => p.id !== S.sheet.id && p.full_name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").includes(q)).slice(0, 6);
  if (!res.length) return `<p class="tiny muted">Nenhum cadastro com esse nome.</p>`;
  return res.map((p) => `<div class="item"><div class="main"><div class="name">${esc(p.full_name)}</div><div class="meta">${esc(fmtPhone(p.phone))} · ${derived.stats.get(p.id)?.total ?? 0} presenças</div></div>
    ${S.sheet.confirmMerge === p.id
      ? `<span class="confirm-inline">Juntar neste cadastro? <button class="btn sm danger" data-act="merge" data-id="${p.id}">Juntar</button><button class="btn sm" data-act="cancel-merge">Não</button></span>`
      : `<button class="btn sm" data-act="ask-merge" data-id="${p.id}">Mesclar</button>`}</div>`).join("");
}

function sheetPersonForm() {
  const p = S.sheet.id ? derived.personById.get(S.sheet.id) : {};
  return `${sheetHead(S.sheet.id ? "Editar dados" : "Adicionar pessoa")}
    <form id="person-form" class="stack" novalidate>
      <label class="field"><span>Nome completo</span><input id="p-name" class="input" value="${esc(p.full_name || "")}"></label>
      <label class="field"><span>WhatsApp</span><input id="p-phone" class="input num" data-mask="phone" inputmode="tel" value="${esc(p.phone ? maskPhone(p.phone) : "")}" placeholder="(27) 99999-9999"></label>
      <label class="field"><span>Data de nascimento</span><input id="p-birth" class="input" type="date" value="${esc(p.birth_date || "")}"></label>
      <label class="field"><span>Como conheceu o grupo</span><select id="p-how" class="input"><option value="">—</option>${HOW_FOUND.map((h) => `<option ${p.how_found === h ? "selected" : ""}>${h}</option>`).join("")}</select></label>
      <label class="field"><span>Quem convidou</span><input id="p-inv" class="input" value="${esc(p.invited_by || "")}"></label>
      <label class="field"><span>Observações</span><textarea id="p-notes" class="input">${esc(p.notes || "")}</textarea></label>
      <label class="consent"><input type="checkbox" id="p-review" ${p.needs_review ? "checked" : ""}><span>Dados a confirmar</span></label>
      <button class="btn primary xl" type="submit">Salvar</button>
    </form>`;
}

// ---------------------------------------------------------------- QR em tela cheia
let wakeLock = null;
function renderQR() {
  const m = S.meetings.find((x) => x.id === S.qr);
  if (!m) return "";
  const att = [...derived.byMeeting.get(m.id)].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const names = att.slice(0, 14).map((a) => firstName(derived.personById.get(a.person_id)?.full_name)).filter(Boolean);
  return `<div class="qr-screen" role="dialog" aria-modal="true" aria-label="QR da chamada">
    <div><p class="eyebrow">${esc(S.settings?.group_name || "EJC Jardim Camburi")}</p><h1 style="font-size:1.7rem;margin-top:4px">Chegou? Confirma aqui!</h1>
      <p class="sub">${fmtDate(m.date, true)} · ${esc(meetingTitle(m))}</p></div>
    ${m.is_open ? `<div class="qr-box"><canvas id="qr-canvas"></canvas></div>` : `<div class="card" style="color:var(--ink)"><p><b>A chamada está fechada.</b> Abra para o QR funcionar.</p><button class="btn primary block" style="margin-top:12px" data-act="toggle" data-id="${m.id}">Abrir chamada</button></div>`}
    <div><div class="qr-count">${att.length}</div><p class="sub">presentes</p></div>
    ${names.length ? `<div class="names">${names.map((n) => `<span>${esc(n)}</span>`).join("")}</div>` : ""}
    <div class="qr-actions">
      <button class="btn sm" data-act="copy-link" data-id="${m.id}">Copiar link</button>
      <button class="btn sm" data-act="png" data-id="${m.id}">Baixar imagem para imprimir</button>
      <button class="btn sm gold" data-act="close-qr">Fechar tela</button>
    </div></div>`;
}

function qrMatrix(text) {
  const qr = window.qrcode(0, "H");
  qr.addData(text);
  qr.make();
  return qr;
}
function drawQR() {
  const c = document.getElementById("qr-canvas");
  if (!c) return;
  const m = S.meetings.find((x) => x.id === S.qr);
  const qr = qrMatrix(checkinUrl(m));
  const n = qr.getModuleCount(), cell = 12, pad = 2;
  c.width = c.height = (n + pad * 2) * cell;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#14244d";
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + pad) * cell, (r + pad) * cell, cell, cell);
}
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

function posterPNG(m) {
  const W = 1240, H = 1754, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#f8f5ef"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#172350"; g.fillRect(0, 0, W, 330);
  g.textAlign = "center";
  g.fillStyle = "#e3b45c"; g.font = "700 38px Figtree, sans-serif";
  g.fillText((S.settings?.group_name || "EJC Jardim Camburi").toUpperCase(), W / 2, 100);
  g.fillStyle = "#fff"; g.font = "800 84px 'Bricolage Grotesque', sans-serif";
  g.fillText("Chegou? Confirma aqui!", W / 2, 210);
  g.fillStyle = "#d9deea"; g.font = "600 38px Figtree, sans-serif";
  g.fillText(`${fmtDate(m.date, true)} · ${meetingTitle(m)}`.slice(0, 60), W / 2, 285);
  const qr = qrMatrix(checkinUrl(m)), n = qr.getModuleCount(), size = 900, cell = Math.floor(size / n), qs = cell * n;
  const x0 = (W - qs) / 2, y0 = 430;
  g.fillStyle = "#fff"; g.strokeStyle = "#c9953c"; g.lineWidth = 6;
  g.beginPath(); g.roundRect(x0 - 40, y0 - 40, qs + 80, qs + 80, 40); g.fill(); g.stroke();
  g.fillStyle = "#14244d";
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect(x0 + k * cell, y0 + r * cell, cell, cell);
  g.fillStyle = "#1b2547"; g.font = "600 46px Figtree, sans-serif";
  ["1. Aponte a câmera do celular", "2. Digite seu WhatsApp", "3. Toque em Confirmar presença"].forEach((t, i) => g.fillText(t, W / 2, y0 + qs + 150 + i * 72));
  g.fillStyle = "#7a8399"; g.font = "500 28px Figtree, sans-serif";
  g.fillText(`código ${m.code}`, W / 2, H - 60);
  c.toBlob((b) => {
    const url = URL.createObjectURL(b);
    const a = Object.assign(document.createElement("a"), { href: url, download: `QR-chamada-${m.date}.png` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}

// ---------------------------------------------------------------- ações
async function act(name, id, el) {
  try {
    switch (name) {
      case "logout": await sb.auth.signOut(); break;
      case "new-meeting": S.sheet = { kind: "meetingForm" }; break;
      case "edit-meeting": S.sheet = { kind: "meetingForm", id }; break;
      case "ask-del-meeting": S.sheet.confirmDel = true; break;
      case "cancel-del": S.sheet.confirmDel = false; break;
      case "del-meeting": {
        const { error } = await sb.from("meetings").delete().eq("id", id);
        if (error) throw error;
        S.sheet = null; await loadAll(); toast("Encontro apagado"); break;
      }
      case "meeting": S.sheet = { kind: "meeting", id, q: "" }; break;
      case "person": S.sheet = { kind: "person", id, mq: "" }; break;
      case "new-person": S.sheet = { kind: "personForm" }; break;
      case "edit-person": S.sheet = { kind: "personForm", id, back: id }; break;
      case "close-sheet":
        S.sheet = S.sheet?.back ? { kind: "person", id: S.sheet.back, mq: "" } : null; break;
      case "toggle": {
        const m = S.meetings.find((x) => x.id === id);
        const { error } = await sb.from("meetings").update({ is_open: !m.is_open }).eq("id", id);
        if (error) throw error;
        m.is_open = !m.is_open; toast(m.is_open ? "Chamada aberta" : "Chamada fechada"); break;
      }
      case "qr": S.qr = id; S.sheet = null; keepAwake(true); break;
      case "close-qr": S.qr = null; keepAwake(false); break;
      case "copy-link": {
        const url = checkinUrl(S.meetings.find((x) => x.id === id));
        try { await navigator.clipboard.writeText(url); toast("Link copiado"); } catch { window.prompt?.("Copie o link:", url); }
        return;
      }
      case "png": posterPNG(S.meetings.find((x) => x.id === id)); return;
      case "add-att": {
        const { error } = await sb.from("attendances").insert({ meeting_id: S.sheet.id, person_id: id, source: "manual" });
        if (error) throw error;
        await loadAll(); toast("Presença marcada"); break;
      }
      case "ask-del-att": S.sheet.confirmAtt = id; break;
      case "cancel-att": S.sheet.confirmAtt = null; break;
      case "del-att": {
        const { error } = await sb.from("attendances").delete().eq("id", id);
        if (error) throw error;
        S.sheet.confirmAtt = null; await loadAll(); toast("Presença removida"); break;
      }
      case "ask-merge": S.sheet.confirmMerge = id; $root.querySelector("#merge-results").innerHTML = mergeResults(); return;
      case "cancel-merge": S.sheet.confirmMerge = null; $root.querySelector("#merge-results").innerHTML = mergeResults(); return;
      case "merge": {
        const { error } = await sb.rpc("merge_people", { _keep: S.sheet.id, _remove: id });
        if (error) throw error;
        S.sheet.confirmMerge = null; S.sheet.mq = ""; await loadAll(); toast("Cadastros mesclados"); break;
      }
      case "here": {
        el.textContent = "Pegando localização…";
        const pos = await getPosition(10000);
        if (!pos) { el.textContent = "📍 Usar minha localização atual"; return toast("Não consegui a localização. Permita o acesso no navegador."); }
        $root.querySelector("#s-lat").value = pos.latitude.toFixed(6);
        $root.querySelector("#s-lng").value = pos.longitude.toFixed(6);
        el.textContent = `📍 Localização capturada (precisão ~${Math.round(pos.accuracy)} m). Agora salve.`;
        return;
      }
      case "ask-del-coord": S.confirmCoord = id; break;
      case "cancel-coord": S.confirmCoord = null; break;
      case "del-coord": {
        const { error } = await sb.from("coordinators").delete().eq("id", id);
        if (error) throw error;
        S.confirmCoord = null; await loadAll(); toast("Removido da equipe"); break;
      }
      case "csv-people": {
        const rows = [["Nome", "WhatsApp", "Status", "Presenças", "1ª presença", "Última presença", "Como conheceu", "Quem convidou", "Nascimento", "Autorizou WhatsApp", "Dados a confirmar", "Observações"]];
        for (const p of S.people) {
          const st = derived.stats.get(p.id);
          rows.push([p.full_name, p.phone ? maskPhone(p.phone) : "", st.status, st.total, fmtDate(st.first), fmtDate(st.last), p.how_found, p.invited_by, p.birth_date ? fmtDate(p.birth_date) : "", p.whatsapp_consent ? "sim" : "não", p.needs_review ? "sim" : "", p.notes]);
        }
        download(`pessoas-${todayISO()}.csv`, toCSV(rows)); return;
      }
      case "csv-att": {
        const rows = [["Data", "Encontro", "Nome", "WhatsApp", "Origem", "Verificado no local", "1ª vez"]];
        for (const a of S.attendances) {
          const m = S.meetings.find((x) => x.id === a.meeting_id), p = derived.personById.get(a.person_id);
          rows.push([fmtDate(m?.date), m ? meetingTitle(m) : "", p?.full_name, p?.phone ? maskPhone(p.phone) : "", a.source, a.verified ? "sim" : "não", derived.isFirst(a.meeting_id, a.person_id) ? "sim" : ""]);
        }
        download(`presencas-${todayISO()}.csv`, toCSV(rows)); return;
      }
      default: return;
    }
  } catch (e) { fail(e); }
  render();
}

async function submit(form) {
  const v = (id) => $root.querySelector(id)?.value?.trim() ?? "";
  try {
    if (form.id === "meeting-form") {
      const date = v("#m-date");
      if (!date) return toast("Escolha a data.");
      const type = $root.querySelector("[data-mtype][aria-pressed=true]")?.dataset.mtype || GROUP_TYPE;
      const row = { date, type, theme: v("#m-theme") || null };
      if (S.sheet.id) {
        const { error } = await sb.from("meetings").update(row).eq("id", S.sheet.id);
        if (error) throw error;
        toast("Encontro salvo");
      } else {
        const is_open = $root.querySelector("#m-open")?.checked ?? false;
        const { error } = await sb.from("meetings").insert({ ...row, is_open, code: randomCode(), location_name: S.settings?.location_name });
        if (error) throw error;
        toast(is_open ? "Encontro criado com a chamada aberta" : "Encontro criado");
      }
      S.sheet = null; S.tab = "encontros"; location.hash = "encontros";
    }
    if (form.id === "person-form") {
      const name = v("#p-name"), phone = onlyDigits(v("#p-phone"));
      if (!name) return toast("Coloque o nome.");
      if (phone && !isValidPhone(phone)) return toast("Telefone precisa ter DDD + número.");
      const row = { full_name: name, phone: phone || null, birth_date: v("#p-birth") || null, how_found: v("#p-how") || null, invited_by: v("#p-inv") || null, notes: v("#p-notes") || null, needs_review: $root.querySelector("#p-review").checked };
      const q = S.sheet.id ? sb.from("people").update(row).eq("id", S.sheet.id).select().single() : sb.from("people").insert(row).select().single();
      const { data, error } = await q;
      if (error) throw (/duplicate|unique/i.test(error.message) ? new Error("já existe outra pessoa com esse telefone. Use Mesclar.") : error);
      S.sheet = { kind: "person", id: data.id, mq: "" };
      toast("Dados salvos");
    }
    if (form.id === "quick-add") {
      const name = v("#qa-name"), phone = onlyDigits(v("#qa-phone"));
      if (!name) return toast("Coloque o nome.");
      if (phone && !isValidPhone(phone)) return toast("Telefone precisa ter DDD + número.");
      const { data, error } = await sb.from("people").insert({ full_name: name, phone: phone || null }).select().single();
      if (error) throw (/duplicate|unique/i.test(error.message) ? new Error("esse telefone já está cadastrado. Busque pelo nome acima.") : error);
      const r = await sb.from("attendances").insert({ meeting_id: S.sheet.id, person_id: data.id, source: "manual" });
      if (r.error) throw r.error;
      toast("Cadastrado e presente");
    }
    if (form.id === "settings") {
      const wa = v("#s-wa");
      if (wa && !/^https:\/\//.test(wa)) return toast("O link do grupo precisa começar com https://");
      const lat = Number(v("#s-lat").replace(",", ".")), lng = Number(v("#s-lng").replace(",", ".")), radius = Number(v("#s-radius"));
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return toast("Latitude/longitude inválidas.");
      const row = { group_name: v("#s-name") || "EJC Jardim Camburi", whatsapp_group_url: wa || null, location_name: v("#s-loc"), lat, lng, radius_m: Math.round(radius) || 200, updated_at: new Date().toISOString() };
      const { error } = await sb.from("app_settings").update(row).eq("id", 1);
      if (error) throw error;
      toast("Ajustes salvos");
    }
    if (form.id === "pass-change") {
      const old = $root.querySelector("#pc-old").value, p1 = $root.querySelector("#pc-new").value, p2 = $root.querySelector("#pc-new2").value;
      if (!old) return toast("Digite a senha atual.");
      if (p1.length < 6) return toast("A nova senha precisa ter pelo menos 6 caracteres.");
      if (p1 !== p2) return toast("As duas senhas novas não estão iguais.");
      const check = await sb.auth.signInWithPassword({ email: S.session.user.email, password: old });
      if (check.error) return toast("A senha atual está errada.");
      const { error } = await sb.auth.updateUser({ password: p1 });
      if (error) return toast(traduz(error.message));
      form.reset();
      $root.querySelector("#pass-box")?.removeAttribute("open");
      return toast("Senha trocada");
    }
    if (form.id === "coord-add") {
      const email = v("#c-email").toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return toast("E-mail inválido.");
      const { error } = await sb.from("coordinators").insert({ email, role: $root.querySelector("#c-role").value });
      if (error) throw (/duplicate|unique/i.test(error.message) ? new Error("esse e-mail já está na equipe.") : error);
      toast("Adicionado à equipe");
    }
    await loadAll();
    render();
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- eventos globais
document.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; location.hash = S.tab; S.sheet = null; window.scrollTo(0, 0); return render(); }
  const f = e.target.closest("[data-filter]");
  if (f) { S.filter = f.dataset.filter; return render(); }
  const mt = e.target.closest("[data-mtype]");
  if (mt) { $root.querySelectorAll("[data-mtype]").forEach((b) => b.setAttribute("aria-pressed", String(b === mt))); return; }
  const a = e.target.closest("[data-act]");
  if (!a) return;
  if (a.dataset.act === "close-sheet-bg") { if (e.target === a) act("close-sheet"); return; }
  act(a.dataset.act, a.dataset.id, a);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (S.qr) act("close-qr"); else if (S.sheet) act("close-sheet"); }
  if (e.key === "Enter" && e.target.matches?.('[role="button"][data-act]')) e.target.click();
});
document.addEventListener("submit", (e) => { e.preventDefault(); submit(e.target); });
window.addEventListener("hashchange", () => { const t = tabFromHash(); if (t !== S.tab) { S.tab = t; render(); } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.qr) { wakeLock = null; keepAwake(true); } });

// ---------------------------------------------------------------- início
async function onSession(session) {
  S.session = session;
  S.me = null;
  if (!session) return render();
  const { data } = await sb.from("coordinators").select("*").eq("user_id", session.user.id).maybeSingle();
  S.me = data;
  if (!S.me) return render();
  try { await loadAll(); } catch (e) { fail(e); }
  render();
  subscribeRealtime();
}

// Link de "esqueci a senha": o hash da URL chega com type=recovery (ou com erro, se expirou).
const urlHash = window.__authHash || "";
let recoveryLink = /type=recovery/.test(urlHash);
if (/error_code=|error=/.test(urlHash) && !recoveryLink) {
  S.authMode = "forgot";
  S.authErr = "Esse link expirou ou já foi usado. Peça um novo abaixo.";
  history.replaceState(null, "", location.pathname);
}

let lastUid;
sb.auth.onAuthStateChange((ev, session) => {
  if (ev === "PASSWORD_RECOVERY" || (recoveryLink && session)) {
    recoveryLink = false;
    S.session = session; lastUid = session?.user?.id ?? null;
    S.authMode = "recovery";
    return setTimeout(renderRecovery, 0);
  }
  if (S.authMode === "recovery") { S.session = session; if (!session) setTimeout(renderRecovery, 0); return; }
  const uid = session?.user?.id ?? null;
  if (uid === lastUid) { S.session = session; return; }
  lastUid = uid;
  setTimeout(() => onSession(session), 0);
});
