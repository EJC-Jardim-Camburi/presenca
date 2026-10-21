-- 0000 — esquema original criado pelo Lovable (projeto 8fb41d25, 21/10/2026), SEM os dados.
-- Os nomes/telefones da lista de papel ficam só no banco: este repositório é público.
-- Observação: handle_new_user e public_meeting foram substituídos em 0001.

-- ===== Settings =====
CREATE TABLE public.app_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  group_name text NOT NULL DEFAULT 'Grupo Jovem Sagrada Família',
  location_name text NOT NULL DEFAULT 'Matriz Sagrada Família — Jardim Camburi',
  lat double precision NOT NULL DEFAULT -20.2610,
  lng double precision NOT NULL DEFAULT -40.2697,
  radius_m int NOT NULL DEFAULT 200,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.app_settings TO authenticated;
GRANT SELECT ON public.app_settings TO anon;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
INSERT INTO public.app_settings (id) VALUES (1);

-- ===== Coordinators (role table) =====
CREATE TABLE public.coordinators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  user_id uuid UNIQUE,
  role text NOT NULL DEFAULT 'coordenacao' CHECK (role IN ('admin','coordenacao','acolhida')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.coordinators TO authenticated;
GRANT ALL ON public.coordinators TO service_role;
ALTER TABLE public.coordinators ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_coordinator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.coordinators WHERE user_id = auth.uid())
$$;
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.coordinators WHERE user_id = auth.uid() AND role = 'admin')
$$;

CREATE POLICY "coord read coordinators" ON public.coordinators FOR SELECT TO authenticated
  USING (public.is_coordinator() OR user_id = auth.uid());
CREATE POLICY "admin insert coordinators" ON public.coordinators FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());
CREATE POLICY "admin update coordinators" ON public.coordinators FOR UPDATE TO authenticated
  USING (public.is_admin());
CREATE POLICY "admin delete coordinators" ON public.coordinators FOR DELETE TO authenticated
  USING (public.is_admin() AND user_id IS DISTINCT FROM auth.uid());

CREATE POLICY "anyone reads settings" ON public.app_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "coord updates settings" ON public.app_settings FOR UPDATE TO authenticated
  USING (public.is_coordinator());

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.coordinators WHERE user_id IS NOT NULL) THEN
    INSERT INTO public.coordinators (email, user_id, role)
    VALUES (lower(NEW.email), NEW.id, 'admin')
    ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id, role = 'admin';
  ELSE
    UPDATE public.coordinators SET user_id = NEW.id
    WHERE email = lower(NEW.email) AND user_id IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.link_coordinator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.email := lower(trim(NEW.email));
  IF NEW.user_id IS NULL THEN
    SELECT id INTO NEW.user_id FROM auth.users WHERE lower(email) = NEW.email LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coordinators_link BEFORE INSERT ON public.coordinators
  FOR EACH ROW EXECUTE FUNCTION public.link_coordinator();

-- ===== People =====
CREATE TABLE public.people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  phone text,
  birth_date date,
  how_found text,
  invited_by text,
  whatsapp_consent boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX people_phone_unique ON public.people(phone) WHERE phone IS NOT NULL AND phone <> '';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.people TO authenticated;
GRANT ALL ON public.people TO service_role;
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coord all people" ON public.people FOR ALL TO authenticated
  USING (public.is_coordinator()) WITH CHECK (public.is_coordinator());

-- ===== Meetings =====
CREATE TABLE public.meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  type text NOT NULL DEFAULT 'Grupo de jovens',
  theme text,
  location_name text,
  code text NOT NULL UNIQUE DEFAULT upper(substr(md5(random()::text), 1, 6)),
  is_open boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meetings TO authenticated;
GRANT ALL ON public.meetings TO service_role;
ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coord all meetings" ON public.meetings FOR ALL TO authenticated
  USING (public.is_coordinator()) WITH CHECK (public.is_coordinator());

-- ===== Attendances =====
CREATE TABLE public.attendances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'qr' CHECK (source IN ('qr','manual','papel')),
  verified boolean NOT NULL DEFAULT false,
  distance_m int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, person_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendances TO authenticated;
GRANT ALL ON public.attendances TO service_role;
ALTER TABLE public.attendances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coord all attendances" ON public.attendances FOR ALL TO authenticated
  USING (public.is_coordinator()) WITH CHECK (public.is_coordinator());
ALTER PUBLICATION supabase_realtime ADD TABLE public.attendances;

-- ===== Funções públicas do check-in (só devolvem o primeiro nome) =====
CREATE OR REPLACE FUNCTION public.public_meeting(_code text) RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object('date', m.date, 'type', m.type, 'theme', m.theme, 'group_name', s.group_name)
  FROM public.meetings m, public.app_settings s
  WHERE upper(m.code) = upper(trim(_code)) AND m.is_open
$$;

CREATE OR REPLACE FUNCTION public.public_lookup(_code text, _phone text) RETURNS json
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE m_id uuid; p record; digits text := regexp_replace(coalesce(_phone,''), '\D', '', 'g');
BEGIN
  SELECT id INTO m_id FROM public.meetings WHERE upper(code) = upper(trim(_code)) AND is_open;
  IF m_id IS NULL THEN RETURN json_build_object('status','closed'); END IF;
  IF length(digits) < 10 THEN RETURN json_build_object('status','invalid'); END IF;
  SELECT id, full_name INTO p FROM public.people WHERE phone = digits;
  IF p.id IS NULL THEN RETURN json_build_object('status','new'); END IF;
  RETURN json_build_object('status','known',
    'first_name', split_part(trim(p.full_name), ' ', 1),
    'already', EXISTS (SELECT 1 FROM public.attendances WHERE meeting_id = m_id AND person_id = p.id));
END $$;

CREATE OR REPLACE FUNCTION public.public_checkin(
  _code text, _phone text, _lat double precision DEFAULT NULL, _lng double precision DEFAULT NULL,
  _full_name text DEFAULT NULL, _birth_date date DEFAULT NULL, _how_found text DEFAULT NULL,
  _invited_by text DEFAULT NULL, _consent boolean DEFAULT false
) RETURNS json
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m_id uuid; pid uuid; pname text; s record; dist double precision; ok boolean := false;
  total int; digits text := regexp_replace(coalesce(_phone,''), '\D', '', 'g');
BEGIN
  SELECT id INTO m_id FROM public.meetings WHERE upper(code) = upper(trim(_code)) AND is_open;
  IF m_id IS NULL THEN RETURN json_build_object('status','closed'); END IF;
  IF length(digits) < 10 OR length(digits) > 11 THEN RETURN json_build_object('status','invalid'); END IF;

  SELECT id, full_name INTO pid, pname FROM public.people WHERE phone = digits;
  IF pid IS NULL THEN
    IF coalesce(trim(_full_name),'') = '' OR length(trim(_full_name)) > 120 OR NOT coalesce(_consent,false) THEN
      RETURN json_build_object('status','need_data');
    END IF;
    INSERT INTO public.people (full_name, phone, birth_date, how_found, invited_by, whatsapp_consent)
    VALUES (trim(_full_name), digits, _birth_date, left(_how_found, 60), left(nullif(trim(_invited_by),''), 120), true)
    RETURNING id, full_name INTO pid, pname;
  ELSE
    UPDATE public.people SET whatsapp_consent = true WHERE id = pid AND NOT whatsapp_consent;
  END IF;

  IF EXISTS (SELECT 1 FROM public.attendances WHERE meeting_id = m_id AND person_id = pid) THEN
    SELECT count(*) INTO total FROM public.attendances WHERE person_id = pid;
    RETURN json_build_object('status','already','first_name', split_part(trim(pname),' ',1),'total', total);
  END IF;

  IF _lat IS NOT NULL AND _lng IS NOT NULL THEN
    SELECT * INTO s FROM public.app_settings WHERE id = 1;
    dist := 2 * 6371000 * asin(sqrt(
      power(sin(radians(_lat - s.lat) / 2), 2) +
      cos(radians(s.lat)) * cos(radians(_lat)) * power(sin(radians(_lng - s.lng) / 2), 2)));
    ok := dist <= s.radius_m;
  END IF;

  INSERT INTO public.attendances (meeting_id, person_id, source, verified, distance_m)
  VALUES (m_id, pid, 'qr', ok, CASE WHEN dist IS NULL THEN NULL ELSE round(dist)::int END);

  SELECT count(*) INTO total FROM public.attendances WHERE person_id = pid;
  RETURN json_build_object('status','ok','first_name', split_part(trim(pname),' ',1),'total', total,'verified', ok);
END $$;

CREATE OR REPLACE FUNCTION public.merge_people(_keep uuid, _remove uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF NOT public.is_coordinator() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _keep = _remove THEN RETURN; END IF;
  UPDATE public.attendances a SET person_id = _keep
  WHERE a.person_id = _remove
    AND NOT EXISTS (SELECT 1 FROM public.attendances b WHERE b.person_id = _keep AND b.meeting_id = a.meeting_id);
  SELECT * INTO r FROM public.people WHERE id = _remove;
  UPDATE public.people k SET
    phone = coalesce(nullif(k.phone,''), nullif(r.phone,'')),
    birth_date = coalesce(k.birth_date, r.birth_date),
    how_found = coalesce(k.how_found, r.how_found),
    invited_by = coalesce(k.invited_by, r.invited_by),
    whatsapp_consent = k.whatsapp_consent OR r.whatsapp_consent,
    notes = nullif(concat_ws(E'\n', k.notes, r.notes), '')
  WHERE k.id = _keep;
  DELETE FROM public.people WHERE id = _remove;
  UPDATE public.people SET phone = coalesce(nullif(phone,''), nullif(r.phone,'')) WHERE id = _keep;
END $$;

REVOKE ALL ON FUNCTION public.merge_people(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_people(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_coordinator() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_meeting(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_lookup(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_checkin(text, text, double precision, double precision, text, date, text, text, boolean) TO anon, authenticated;
