-- Allow offer outcomes: an offer can be accepted or declined.
alter table public.applications drop constraint if exists applications_stage_check;
alter table public.applications add constraint applications_stage_check
  check (stage in ('applied','oa','interview','offer','accepted','declined','rejected'));

alter table public.application_events drop constraint if exists application_events_stage_check;
alter table public.application_events add constraint application_events_stage_check
  check (stage in ('applied','oa','interview','offer','accepted','declined','rejected'));
