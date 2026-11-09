-- Apply once to a new Supabase project from the SQL Editor.
create extension if not exists pgcrypto;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references auth.users(id) on delete set null,
  image_path text not null,
  caption varchar(500) not null default '',
  created_at timestamptz not null default now(),
  is_visible boolean not null default true,
  deleted_at timestamptz
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body varchar(500) not null check (char_length(trim(body)) between 1 and 500),
  created_at timestamptz not null default now(),
  removed_at timestamptz
);

create table public.likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.saved_posts (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment')),
  target_id uuid not null,
  reason varchar(500) not null check (char_length(trim(reason)) between 3 and 500),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- This event table carries no user IDs, emails or comment text to Realtime subscribers.
create table public.feed_events (
  id bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('posts', 'comments', 'likes')),
  entity_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);

create index posts_created_at_idx on public.posts (created_at desc) where is_visible and deleted_at is null;
create index comments_post_created_idx on public.comments (post_id, created_at) where removed_at is null;
create index reports_status_created_idx on public.reports (status, created_at desc);

create function public.is_admin()
returns boolean language sql stable
as $$ select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false) $$;

create function public.is_active_user()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid()) and p.is_blocked = false
  )
$$;

create function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id);
  return new;
end;
$$;
create trigger auth_user_profile after insert on auth.users
for each row execute function public.create_profile_for_new_user();

create function public.enforce_content_limits()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare recent_count integer;
begin
  if new.author_id is null then return new; end if;
  if not public.is_active_user() then
    raise exception 'Account is unavailable for posting.' using errcode = '42501';
  end if;

  if tg_table_name = 'comments' and not exists (
    select 1 from public.posts p where p.id = new.post_id and p.is_visible and p.deleted_at is null
  ) then
    raise exception 'Post is unavailable for commenting.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended((select auth.uid())::text, 0));
  if tg_table_name = 'posts' then
    select count(*) into recent_count from public.posts p
    where p.author_id = (select auth.uid()) and p.created_at > now() - interval '1 minute';
    if recent_count >= 4 then raise exception 'Posting rate limit reached.' using errcode = 'P0001'; end if;
  else
    select count(*) into recent_count from public.comments c
    where c.author_id = (select auth.uid()) and c.created_at > now() - interval '1 minute';
    if recent_count >= 10 then raise exception 'Comment rate limit reached.' using errcode = 'P0001'; end if;
    if exists (
      select 1 from public.comments c
      where c.author_id = (select auth.uid()) and c.post_id = new.post_id
        and lower(c.body) = lower(trim(new.body))
        and c.created_at > now() - interval '5 minutes'
    ) then raise exception 'Duplicate comment.' using errcode = 'P0001'; end if;
  end if;
  return new;
end;
$$;
create trigger posts_rate_limit before insert on public.posts
for each row execute function public.enforce_content_limits();
create trigger comments_rate_limit before insert on public.comments
for each row execute function public.enforce_content_limits();

create function public.validate_report_target()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.target_type = 'post' and not exists (select 1 from public.posts where id = new.target_id) then
    raise exception 'Reported post does not exist.';
  elsif new.target_type = 'comment' and not exists (select 1 from public.comments where id = new.target_id) then
    raise exception 'Reported comment does not exist.';
  end if;
  return new;
end;
$$;

create function public.enforce_report_limits()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare recent_count integer;
begin
  if not public.is_active_user() then
    raise exception 'Account is unavailable for reporting.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended((select auth.uid())::text, 0));
  select count(*) into recent_count from public.reports r
  where r.reporter_id = (select auth.uid()) and r.created_at > now() - interval '1 hour';
  if recent_count >= 10 then raise exception 'Report rate limit reached.' using errcode = 'P0001'; end if;
  if exists (
    select 1 from public.reports r
    where r.reporter_id = (select auth.uid()) and r.target_type = new.target_type
      and r.target_id = new.target_id and r.status = 'open'
  ) then raise exception 'This item has already been reported.' using errcode = 'P0001'; end if;
  return new;
end;
$$;
create trigger reports_rate_limit before insert on public.reports
for each row execute function public.enforce_report_limits();
create trigger reports_validate_target before insert on public.reports
for each row execute function public.validate_report_target();

create function public.emit_feed_event()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare event_id uuid; event_action text;
begin
  if tg_op = 'DELETE' then event_id := old.id; event_action := 'delete';
  else event_id := new.id; event_action := lower(tg_op); end if;
  insert into public.feed_events (entity_type, entity_id, action)
  values (tg_table_name, event_id, event_action);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger posts_feed_event after insert or update or delete on public.posts
for each row execute function public.emit_feed_event();
create trigger comments_feed_event after insert or update or delete on public.comments
for each row execute function public.emit_feed_event();

create function public.emit_like_event()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.feed_events (entity_type, entity_id, action) values ('likes', old.post_id, 'delete');
    return old;
  end if;
  insert into public.feed_events (entity_type, entity_id, action) values ('likes', new.post_id, 'insert');
  return new;
end;
$$;
create trigger likes_feed_event after insert or delete on public.likes
for each row execute function public.emit_like_event();

-- Public views intentionally omit account IDs and email addresses.
create view public.public_feed with (security_barrier = true) as
select p.id, p.image_path, p.caption, p.created_at,
  (select count(*)::integer from public.likes l where l.post_id = p.id) as likes_count,
  (select count(*)::integer from public.comments c where c.post_id = p.id and c.removed_at is null) as comments_count,
  coalesce((select jsonb_agg(jsonb_build_object(
    'id', c.id,
    'body', c.body,
    'created_at', c.created_at,
    'can_delete', c.author_id = (select auth.uid()) or public.is_admin()
  ) order by c.created_at)
    from public.comments c where c.post_id = p.id and c.removed_at is null), '[]'::jsonb) as comments,
  (p.author_id = (select auth.uid()) or public.is_admin()) as can_delete
from public.posts p where p.is_visible and p.deleted_at is null;

create function public.delete_post(target_post_id uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare post_author_id uuid; stored_path text;
begin
  select p.author_id, p.image_path into post_author_id, stored_path
  from public.posts p where p.id = target_post_id for update;
  if not found then raise exception 'Post not found.' using errcode = 'P0002'; end if;
  if post_author_id is distinct from (select auth.uid()) and not public.is_admin() then
    raise exception 'Not allowed to delete this post.' using errcode = '42501';
  end if;
  delete from public.posts where id = target_post_id;
  return stored_path;
end;
$$;

create function public.delete_comment(target_comment_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare comment_author_id uuid;
begin
  select c.author_id into comment_author_id
  from public.comments c where c.id = target_comment_id for update;
  if not found then raise exception 'Comment not found.' using errcode = 'P0002'; end if;
  if comment_author_id is distinct from (select auth.uid()) and not public.is_admin() then
    raise exception 'Not allowed to delete this comment.' using errcode = '42501';
  end if;
  delete from public.comments where id = target_comment_id;
end;
$$;

create view public.admin_posts with (security_barrier = true) as
select p.id, p.author_id, u.email as author_email, p.image_path, p.caption, p.created_at, p.is_visible, p.deleted_at
from public.posts p left join auth.users u on u.id = p.author_id
where public.is_admin();

create view public.admin_comments with (security_barrier = true) as
select c.id, c.post_id, c.author_id, u.email as author_email, c.body, c.created_at, c.removed_at
from public.comments c join auth.users u on u.id = c.author_id
where public.is_admin();

create view public.admin_users with (security_barrier = true) as
select p.user_id, u.email, p.is_blocked, p.created_at
from public.profiles p join auth.users u on u.id = p.user_id
where public.is_admin();

create view public.admin_reports with (security_barrier = true) as
select r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
  reporter.email as reporter_email,
  case when r.target_type = 'post' then post.author_id else comment.author_id end as target_author_id,
  case when r.target_type = 'post' then post_user.email else comment_user.email end as target_author_email,
  case when r.target_type = 'post' then post.caption else comment.body end as target_text
from public.reports r
left join auth.users reporter on reporter.id = r.reporter_id
left join public.posts post on r.target_type = 'post' and post.id = r.target_id
left join auth.users post_user on post_user.id = post.author_id
left join public.comments comment on r.target_type = 'comment' and comment.id = r.target_id
left join auth.users comment_user on comment_user.id = comment.author_id
where public.is_admin();

create function public.admin_remove_comment(target_comment_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  delete from public.comments where id = target_comment_id;
end;
$$;

create function public.admin_set_user_block(target_user_id uuid, should_block boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  update public.profiles set is_blocked = should_block where user_id = target_user_id;
end;
$$;

create function public.admin_review_report(target_report_id uuid, next_status text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if next_status not in ('reviewed', 'dismissed') then raise exception 'Invalid report status.'; end if;
  update public.reports set status = next_status, reviewed_at = now() where id = target_report_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.saved_posts enable row level security;
alter table public.reports enable row level security;
alter table public.feed_events enable row level security;

revoke all on public.profiles, public.posts, public.comments, public.likes, public.saved_posts, public.reports, public.feed_events from anon, authenticated;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_active_user() from public, anon;
revoke all on function public.admin_remove_comment(uuid) from public, anon;
revoke all on function public.delete_post(uuid) from public, anon;
revoke all on function public.delete_comment(uuid) from public, anon;
revoke all on function public.admin_set_user_block(uuid, boolean) from public, anon;
revoke all on function public.admin_review_report(uuid, text) from public, anon;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_active_user() to authenticated;
grant select on public.profiles to authenticated;
grant select on public.public_feed, public.admin_posts, public.admin_comments, public.admin_users, public.admin_reports to authenticated;
grant select on public.public_feed to anon;
grant insert on public.posts, public.comments, public.reports to authenticated;
grant select, insert, delete on public.likes, public.saved_posts to authenticated;
grant select on public.feed_events to anon, authenticated;
grant execute on function public.admin_remove_comment(uuid) to authenticated;
grant execute on function public.delete_post(uuid) to authenticated;
grant execute on function public.delete_comment(uuid) to authenticated;
grant execute on function public.admin_set_user_block(uuid, boolean) to authenticated;
grant execute on function public.admin_review_report(uuid, text) to authenticated;

create policy profiles_read_self on public.profiles for select to authenticated
using (user_id = (select auth.uid()) or public.is_admin());
create policy posts_insert_owner on public.posts for insert to authenticated
with check (author_id = (select auth.uid()) and public.is_active_user());
create policy posts_admin_manage on public.posts for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy comments_insert_owner on public.comments for insert to authenticated
with check (author_id = (select auth.uid()) and public.is_active_user());
create policy comments_admin_manage on public.comments for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy likes_own_manage on public.likes for all to authenticated
using (user_id = (select auth.uid()) and public.is_active_user())
with check (user_id = (select auth.uid()) and public.is_active_user());
create policy saved_posts_own_manage on public.saved_posts for all to authenticated
using (user_id = (select auth.uid()) and public.is_active_user())
with check (user_id = (select auth.uid()) and public.is_active_user());
create policy reports_insert_owner on public.reports for insert to authenticated
with check (reporter_id = (select auth.uid()) and public.is_active_user());
create policy reports_admin_manage on public.reports for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy feed_events_read on public.feed_events for select to anon, authenticated using (true);

-- Public photos are intentional; bucket restrictions and owner metadata govern uploads/deletes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']);
create policy post_images_insert_owner on storage.objects for insert to authenticated
with check (bucket_id = 'post-images' and owner_id = (select auth.uid())::text and public.is_active_user());
create policy post_images_delete_owner_or_admin on storage.objects for delete to authenticated
using (bucket_id = 'post-images' and (owner_id = (select auth.uid())::text or public.is_admin()));

-- Supabase Realtime is used only for privacy-safe event IDs; page data is re-read from public_feed.
alter publication supabase_realtime add table public.feed_events;

-- One clearly fictional starter photo keeps a fresh deployment from opening to an empty feed.
insert into public.posts (author_id, image_path, caption)
values (null,
  'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=1200&q=85',
  'სადღესასწაულო განწყობა ქალაქში ✨');
