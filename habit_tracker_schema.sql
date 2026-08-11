-- Schema-only export for Habit Tracker tables
-- Source project: habit-tracker-mvp (hxjesszhawscacidjiat)
-- Generated via Supabase MCP introspection (no table data included)
--
-- Tables:
--   habit_tracker_books
--   habit_tracker_categories
--   habit_tracker_log_days
--   habit_tracker_reading_settings
--   habit_tracker_stopwatches
--   habit_tracker_ui_settings

-- ---------------------------------------------------------------------------
-- habit_tracker_books
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.habit_tracker_books (
  id uuid NOT NULL,
  title text NOT NULL DEFAULT ''::text,
  total_pages integer NOT NULL,
  last_finished_page integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  purchase_opened boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT books_pkey PRIMARY KEY (id),
  CONSTRAINT books_total_pages_check CHECK (total_pages >= 1),
  CONSTRAINT books_last_finished_page_check CHECK (last_finished_page >= 0),
  CONSTRAINT books_status_check CHECK (status = ANY (ARRAY['active'::text, 'finished'::text]))
);

-- ---------------------------------------------------------------------------
-- habit_tracker_categories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.habit_tracker_categories (
  id text NOT NULL,
  name text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT categories_pkey PRIMARY KEY (id),
  CONSTRAINT categories_name_check CHECK (
    (char_length(TRIM(BOTH FROM name)) > 0)
    AND (char_length(name) <= 40)
  )
);

-- ---------------------------------------------------------------------------
-- habit_tracker_log_days
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.habit_tracker_log_days (
  day_key date NOT NULL,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT habit_log_days_pkey PRIMARY KEY (day_key)
);

-- ---------------------------------------------------------------------------
-- habit_tracker_reading_settings
-- (FK to habit_tracker_books — create books first)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.habit_tracker_reading_settings (
  id integer NOT NULL DEFAULT 1,
  active_book_id uuid,
  next_book_url text NOT NULL DEFAULT ''::text,
  open_threshold double precision NOT NULL DEFAULT 0.8,
  threshold_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT reading_settings_pkey PRIMARY KEY (id),
  CONSTRAINT reading_settings_id_check CHECK (id = 1),
  CONSTRAINT reading_settings_open_threshold_check CHECK (
    (open_threshold > (0)::double precision)
    AND (open_threshold <= (1)::double precision)
  ),
  CONSTRAINT reading_settings_active_book_id_fkey
    FOREIGN KEY (active_book_id)
    REFERENCES public.habit_tracker_books (id)
    ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- habit_tracker_stopwatches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.habit_tracker_stopwatches (
  id integer NOT NULL,
  elapsed_ms bigint NOT NULL DEFAULT 0,
  running boolean NOT NULL DEFAULT false,
  started_at bigint,
  name text NOT NULL DEFAULT ''::text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stopwatches_pkey PRIMARY KEY (id),
  CONSTRAINT stopwatches_id_check CHECK (id >= 0),
  CONSTRAINT stopwatches_elapsed_ms_check CHECK (elapsed_ms >= 0),
  CONSTRAINT stopwatches_name_check CHECK (char_length(name) <= 40)
);

-- ---------------------------------------------------------------------------
-- habit_tracker_ui_settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.habit_tracker_ui_settings (
  id integer NOT NULL DEFAULT 1,
  collapsed_days jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT habit_ui_settings_pkey PRIMARY KEY (id),
  CONSTRAINT habit_ui_settings_id_check CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- Grants (matches source project: full access for anon / authenticated /
-- service_role). RLS is currently disabled on these tables in the source.
-- ---------------------------------------------------------------------------
GRANT ALL ON TABLE public.habit_tracker_books TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.habit_tracker_categories TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.habit_tracker_log_days TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.habit_tracker_reading_settings TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.habit_tracker_stopwatches TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.habit_tracker_ui_settings TO anon, authenticated, service_role;
