// Utilidades compartilhadas: telefone, datas, escape de HTML e regras de status.

export const GROUP_TYPE = "Grupo de jovens";
export const MEETING_TYPES = ["Grupo de jovens", "Adoração", "Terço", "Evento"];
export const HOW_FOUND = ["Amigo(a) me convidou", "Instagram", "EJC", "Missa ou paróquia", "Outro"];

export const onlyDigits = (s) => String(s ?? "").replace(/\D/g, "");

export function maskPhone(v) {
  const d = onlyDigits(v).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
export const isValidPhone = (v) => { const n = onlyDigits(v).length; return n === 10 || n === 11; };
export const fmtPhone = (d) => (d ? maskPhone(d) : "sem telefone");
export const waLink = (d, text = "") =>
  d ? `https://wa.me/55${onlyDigits(d)}${text ? `?text=${encodeURIComponent(text)}` : ""}` : null;

const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export function fmtDate(iso, withWeek = false) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  const base = `${d}/${m}/${y}`;
  if (!withWeek) return base;
  const wd = new Date(Number(y), Number(m) - 1, Number(d)).getDay();
  return `${WEEK[wd]}, ${base}`;
}
export const fmtShort = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
export function todayISO() {
  const n = new Date();
  return new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export const firstName = (n) => String(n ?? "").trim().split(/\s+/)[0] || "";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function randomCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map((x) => A[x % A.length]).join("");
}

export function getPosition(timeout = 7000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), timeout + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => finish({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => finish(null),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 },
    );
  });
}

/**
 * Status de cada pessoa (mesmas regras do app original):
 * - Novo: só 1 presença e ela foi no último encontro
 * - Frequente: presente em 3+ dos últimos 4 encontros de "Grupo de jovens"
 * - Sumido: 2+ presenças, mas faltou aos 2 últimos encontros de grupo
 * - Ocasional: os demais
 */
export function computeStats(people, meetings, attendances, today = todayISO()) {
  const past = meetings.filter((m) => m.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = past[0];
  const group = past.filter((m) => m.type === GROUP_TYPE);
  const last4 = group.slice(0, 4).map((m) => m.id);
  const last2 = group.slice(0, 2).map((m) => m.id);
  const dateOf = new Map(meetings.map((m) => [m.id, m.date]));
  const byPerson = new Map();
  for (const a of attendances) {
    if (!byPerson.has(a.person_id)) byPerson.set(a.person_id, new Set());
    byPerson.get(a.person_id).add(a.meeting_id);
  }
  const out = new Map();
  for (const p of people) {
    const set = byPerson.get(p.id) ?? new Set();
    const dates = [...set].map((id) => dateOf.get(id)).filter(Boolean).sort();
    const total = set.size;
    const freq4 = last4.filter((id) => set.has(id)).length;
    let status = "Ocasional";
    if (total === 1 && latest && set.has(latest.id)) status = "Novo";
    else if (freq4 >= 3) status = "Frequente";
    else if (total >= 2 && last2.length === 2 && last2.every((id) => !set.has(id))) status = "Sumido";
    out.set(p.id, { total, first: dates[0] ?? null, last: dates.at(-1) ?? null, freq4, group4: last4.length, status, meetings: set });
  }
  return { stats: out, latest };
}

/** Função que diz se a presença (encontro, pessoa) foi a primeira vez da pessoa. */
export function firstTimeChecker(meetings, attendances) {
  const dateOf = new Map(meetings.map((m) => [m.id, m.date]));
  const first = new Map();
  for (const a of attendances) {
    const d = dateOf.get(a.meeting_id) ?? "";
    const cur = first.get(a.person_id);
    if (!cur || d < cur.date) first.set(a.person_id, { id: a.meeting_id, date: d });
  }
  return (meetingId, personId) => first.get(personId)?.id === meetingId;
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\n");
}

export function download(filename, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
