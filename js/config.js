// Backend: banco (Supabase) criado pelo Lovable Cloud no projeto 8fb41d25.
// A chave "publishable" é pública por natureza — a proteção dos dados é feita pelas regras (RLS) do banco.
export const SUPABASE_URL = "https://c--8fb41d25-ade5-4168-8840-da263ca4bf64-prod.lovable.cloud";
export const SUPABASE_KEY = "sb_publishable_qcx03_nE9q2eddmevvoV4A_jKi_9zmU";

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "gjsf-auth" },
});
