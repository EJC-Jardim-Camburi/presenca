-- 0001 (21/10/2026) — aplicado direto no banco, fora das migrations do Lovable.

-- 1) Coordenação: só e-mails pré-cadastrados em public.coordinators viram coordenadores.
--    (Antes: o primeiro usuário a se cadastrar virava admin — brecha num site público.)
INSERT INTO public.coordinators (email, role) VALUES ('joaovitoramosss@gmail.com', 'admin')
  ON CONFLICT (email) DO UPDATE SET role = 'admin';

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.coordinators SET user_id = NEW.id
  WHERE email = lower(NEW.email) AND user_id IS NULL;
  RETURN NEW;
END $$;

-- 2) Link do grupo do WhatsApp, mostrado depois do check-in.
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS whatsapp_group_url text;

CREATE OR REPLACE FUNCTION public.public_meeting(_code text) RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object('date', m.date, 'type', m.type, 'theme', m.theme,
    'group_name', s.group_name, 'whatsapp_group_url', s.whatsapp_group_url)
  FROM public.meetings m, public.app_settings s
  WHERE upper(m.code) = upper(trim(_code)) AND m.is_open
$$;

-- 21/10 (noite): admin passa a ser o e-mail pessoal do João (o grupo não é da empresa).
DELETE FROM public.coordinators WHERE email = 'joao@tastefy.com.br';
