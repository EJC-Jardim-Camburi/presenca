// Página pública: o jovem lê o QR (index.html?e=CODIGO), digita o WhatsApp e confirma.
// Só conversa com o banco por 3 funções públicas (public_meeting, public_lookup, public_checkin),
// que nunca devolvem mais que o primeiro nome.
import { sb } from "./config.js";
import { esc, maskPhone, isValidPhone, onlyDigits, fmtDate, HOW_FOUND, getPosition } from "./lib.js";

const PHONE_KEY = "gjsf_phone";
const code = new URLSearchParams(location.search).get("e")?.trim() || "";
const $card = document.getElementById("card");
let meeting = null;
let phone = "";
let form = { name: "", birth: "", how: "", invited: "", consent: false };

const store = {
  get() { try { return localStorage.getItem(PHONE_KEY) || ""; } catch { return ""; } },
  set(v) { try { localStorage.setItem(PHONE_KEY, v); } catch {} },
};

function header() {
  if (!meeting) return;
  document.getElementById("group").textContent = meeting.group_name || "Grupo Jovem Sagrada Família";
  document.getElementById("title").textContent = meeting.type;
  document.getElementById("subtitle").textContent = fmtDate(meeting.date) + (meeting.theme ? ` · ${meeting.theme}` : "");
  document.title = `Presença · ${meeting.group_name || "Grupo Jovem"}`;
}

function render(html, focus) {
  $card.innerHTML = html;
  if (focus) $card.querySelector(focus)?.focus();
}

// ---------- telas ----------
function landing() {
  document.getElementById("title").textContent = "Grupo Jovem Sagrada Família";
  render(`
    <div class="stack center">
      <h2>Chegou no encontro?</h2>
      <p class="muted">Aponte a câmera do celular para o QR Code da acolhida e confirme sua presença. 🙌</p>
      <a class="btn primary block" href="coordenacao.html">Área da coordenação</a>
      <p class="tiny muted">Matriz Sagrada Família · Jardim Camburi · Vitória/ES</p>
    </div>`);
}

function closed() {
  render(`
    <div class="center stack" style="padding:18px 0">
      <div style="font-size:3rem">🔒</div>
      <h2>A chamada deste encontro está fechada.</h2>
      <p class="muted">Fala com a acolhida 😉</p>
    </div>`);
}

function phoneStep(error = "") {
  render(`
    <form id="f" class="stack" novalidate>
      <label class="field"><span>Seu WhatsApp</span>
        <input id="phone" class="input big" inputmode="tel" autocomplete="tel-national" placeholder="(27) 99999-9999" value="${esc(phone)}">
      </label>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <button class="btn primary xl" id="go" type="submit">Continuar</button>
    </form>`, "#phone");
  const $p = $card.querySelector("#phone");
  $p.addEventListener("input", () => { phone = maskPhone($p.value); $p.value = phone; });
  $card.querySelector("#f").addEventListener("submit", (e) => { e.preventDefault(); lookup(); });
}

function knownStep(first, error = "") {
  render(`
    <div class="center stack">
      <h2 style="font-size:2rem">Oi, ${esc(first)}! 👋</h2>
      <p class="muted">Que bom te ver por aqui.</p>
      <button class="btn gold xl" id="ok">Confirmar minha presença</button>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <button class="linkbtn" id="back">← Não sou eu</button>
    </div>`);
  $card.querySelector("#ok").onclick = () => confirm(false);
  $card.querySelector("#back").onclick = () => phoneStep();
}

function newStep(error = "") {
  const age = form.birth ? Math.floor((Date.now() - new Date(form.birth).getTime()) / 31557600000) : null;
  render(`
    <form id="f" class="stack" novalidate>
      <div><h2 style="font-size:1.6rem">Primeira vez por aqui?</h2><p class="muted">Que bom te ver! 🙌</p></div>
      <label class="field"><span>Nome completo</span>
        <input id="name" class="input" autocomplete="name" maxlength="120" value="${esc(form.name)}"></label>
      <label class="field"><span>Data de nascimento (opcional)</span>
        <input id="birth" class="input" type="date" value="${esc(form.birth)}"></label>
      <div class="field"><span>Como conheceu o grupo?</span>
        <div class="chips">${HOW_FOUND.map((h) => `<button type="button" class="chip" data-how="${esc(h)}" aria-pressed="${form.how === h}">${esc(h)}</button>`).join("")}</div>
      </div>
      <label class="field"><span>Quem te convidou? (opcional)</span>
        <input id="invited" class="input" maxlength="120" value="${esc(form.invited)}"></label>
      <label class="consent"><input type="checkbox" id="consent" ${form.consent ? "checked" : ""}>
        <span>Autorizo o grupo a me mandar avisos pelo WhatsApp.
        ${age !== null && age < 18 ? `<span class="muted" style="display:block;margin-top:4px">Como você tem menos de 18 anos, confirmo que meu responsável está ciente.</span>` : ""}</span>
      </label>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <button class="btn gold xl" type="submit">Confirmar minha presença</button>
      <button class="linkbtn" type="button" id="back">← Voltar</button>
    </form>`, form.name ? null : "#name");
  const q = (s) => $card.querySelector(s);
  q("#name").oninput = (e) => (form.name = e.target.value);
  q("#invited").oninput = (e) => (form.invited = e.target.value);
  q("#birth").onchange = (e) => { form.birth = e.target.value; newStep(); };
  q("#consent").onchange = (e) => (form.consent = e.target.checked);
  $card.querySelectorAll("[data-how]").forEach((b) => (b.onclick = () => {
    form.how = b.dataset.how;
    $card.querySelectorAll("[data-how]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  q("#back").onclick = () => phoneStep();
  q("#f").addEventListener("submit", (e) => { e.preventDefault(); confirm(true); });
}

function sending() {
  render(`
    <div class="center stack" style="padding:16px 0">
      <div style="font-size:2.6rem">📍</div>
      <p style="font-weight:700">Confirmando sua presença…</p>
      <p class="small muted">Se o celular pedir sua localização, pode permitir.</p>
    </div>`);
}

function done({ first, total, already }) {
  const msg = already
    ? `Tudo certo, ${first}! Aproveita o encontro.`
    : total <= 1
      ? `Seja muito bem-vindo(a), ${first}! É sua primeira vez com a gente.`
      : `Essa é sua ${total}ª presença. Que bom que você voltou, ${first}!`;
  const wa = /^https:\/\//.test(meeting?.whatsapp_group_url || "") ? meeting.whatsapp_group_url : "";
  render(`
    <div class="center" style="padding:6px 0">
      <div class="big-emoji">✅</div>
      <h2 style="font-size:1.9rem;margin-top:14px">${already ? "Sua presença já está confirmada" : "Presença confirmada!"}</h2>
      <p style="font-size:1.1rem;margin-top:10px">${esc(msg)}</p>
      ${wa ? `<div class="wa-box">
          <p class="small muted">Fica por dentro dos avisos e da agenda do grupo 💬</p>
          <a class="btn wa xl" href="${esc(wa)}" target="_blank" rel="noopener">Entrar no grupo do WhatsApp</a>
        </div>` : `<p class="small muted" style="margin-top:22px">Pode guardar o celular 😊</p>`}
    </div>`);
}

// ---------- ações ----------
async function lookup() {
  if (!isValidPhone(phone)) return phoneStep("Confere o número com DDD 🙂");
  $card.querySelector("#go")?.setAttribute("disabled", "");
  const { data, error } = await sb.rpc("public_lookup", { _code: code, _phone: onlyDigits(phone) });
  if (error) return phoneStep("Sem conexão. Tenta de novo.");
  if (data.status === "closed") return closed();
  if (data.status === "invalid") return phoneStep("Confere o número com DDD 🙂");
  if (data.status === "known") {
    if (data.already) return done({ first: data.first_name, total: 0, already: true });
    return knownStep(data.first_name);
  }
  newStep();
}

async function confirm(isNew) {
  if (isNew) {
    if (form.name.trim().split(/\s+/).length < 2) return newStep("Coloca seu nome completo, por favor.");
    if (!form.consent) return newStep("Marque a autorização para continuar.");
  }
  sending();
  const pos = await getPosition();
  const args = { _code: code, _phone: onlyDigits(phone), _lat: pos?.latitude ?? null, _lng: pos?.longitude ?? null };
  if (isNew) Object.assign(args, {
    _full_name: form.name.trim(),
    _birth_date: form.birth || null,
    _how_found: form.how || null,
    _invited_by: form.invited.trim() || null,
    _consent: form.consent,
  });
  const { data, error } = await sb.rpc("public_checkin", args);
  if (error) return isNew ? newStep("Não deu certo. Tenta de novo.") : phoneStep("Não deu certo. Tenta de novo.");
  if (data.status === "closed") return closed();
  if (data.status === "need_data") return newStep();
  if (data.status === "invalid") return phoneStep("Confere o número com DDD 🙂");
  store.set(onlyDigits(phone));
  done({ first: data.first_name, total: data.total, already: data.status === "already" });
}

// ---------- início ----------
(async function start() {
  phone = maskPhone(store.get());
  if (!code) return landing();
  const { data, error } = await sb.rpc("public_meeting", { _code: code });
  if (error || !data) return closed();
  meeting = data;
  header();
  phoneStep();
})();
