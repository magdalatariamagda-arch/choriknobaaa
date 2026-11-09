create extension if not exists pgcrypto;

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 1200),
  topic text not null check (topic in ('ურთიერთობები', 'სამსახური', 'სწავლა', 'ცხოვრება', 'სხვა')),
  image_url text,
  created_at timestamptz not null default now(),
  constraint posts_have_content check (char_length(trim(body)) > 0 or image_url is not null)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 600),
  created_at timestamptz not null default now()
);

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.blocked_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text not null default 'შეზღუდულია მოდერატორის მიერ',
  created_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment')),
  post_id uuid,
  comment_id uuid,
  reason text not null check (reason in ('შეურაცხმყოფელი შინაარსი', 'სპამი ან რეკლამა', 'მუქარა ან ძალადობა', 'სხვა')),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint reports_target_matches check (
    (target_type = 'post' and post_id is not null and comment_id is null) or
    (target_type = 'comment' and comment_id is not null and post_id is null)
  )
);

create index posts_created_at_idx on public.posts(created_at desc);
create index posts_topic_idx on public.posts(topic);
create index comments_post_created_at_idx on public.comments(post_id, created_at);
create index reports_status_created_at_idx on public.reports(status, created_at);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users
    where user_id = (select auth.uid())
  );
$$;

create or replace function public.is_blocked(target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocked_users
    where user_id = target_user
  );
$$;

create view public.public_posts as
  select id, body, topic, image_url, created_at, (user_id = auth.uid()) as is_mine
  from public.posts;

create view public.public_comments as
  select id, post_id, parent_id, body, created_at, (user_id = auth.uid()) as is_mine
  from public.comments;

create or replace function public.get_moderation_reports()
returns table (
  id uuid,
  target_type text,
  post_id uuid,
  comment_id uuid,
  reason text,
  status text,
  created_at timestamptz,
  target_body text,
  image_url text,
  author_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    report.id,
    report.target_type,
    report.post_id,
    report.comment_id,
    report.reason,
    report.status,
    report.created_at,
    coalesce(post.body, comment.body, 'შინაარსი წაშლილია'),
    post.image_url,
    coalesce(post.user_id, comment.user_id)
  from public.reports as report
  left join public.posts as post on post.id = report.post_id
  left join public.comments as comment on comment.id = report.comment_id
  where report.status = 'open' and public.is_admin()
  order by report.created_at asc;
$$;

revoke all on function public.get_moderation_reports() from public, anon;
grant execute on function public.get_moderation_reports() to authenticated;

alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.admin_users enable row level security;
alter table public.blocked_users enable row level security;
alter table public.reports enable row level security;

create policy "Posts are publicly readable" on public.posts
  for select using (true);
create policy "Signed-in users can publish posts" on public.posts
  for insert to authenticated
  with check (user_id = (select auth.uid()) and not public.is_blocked());
create policy "Post owners and moderators can delete posts" on public.posts
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "Comments are publicly readable" on public.comments
  for select using (true);
create policy "Signed-in users can comment" on public.comments
  for insert to authenticated
  with check (
    user_id = (select auth.uid()) and not public.is_blocked() and
    (parent_id is null or exists (
      select 1 from public.comments parent
      where parent.id = comments.parent_id and parent.post_id = comments.post_id
    ))
  );
create policy "Comment owners and moderators can delete comments" on public.comments
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "Users can read only their own moderator record" on public.admin_users
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Moderators can inspect moderator records" on public.admin_users
  for select to authenticated using (public.is_admin());

create policy "Users can read their own restriction status" on public.blocked_users
  for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());
create policy "Moderators can restrict accounts" on public.blocked_users
  for insert to authenticated with check (public.is_admin());
create policy "Moderators can lift account restrictions" on public.blocked_users
  for delete to authenticated using (public.is_admin());

create policy "Users can submit reports" on public.reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()) and not public.is_blocked() and status = 'open');
create policy "Only moderators can inspect reports" on public.reports
  for select to authenticated using (public.is_admin());
create policy "Only moderators can resolve reports" on public.reports
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin() and reviewed_by = (select auth.uid()));

revoke select on public.posts, public.comments from anon, authenticated;
grant insert, delete on public.posts, public.comments to authenticated;
grant select (id, post_id) on public.comments to authenticated;
grant select on public.public_posts, public.public_comments to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Post images are publicly readable" on storage.objects
  for select using (bucket_id = 'post-images');
create policy "Users can upload images to their own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'post-images' and owner_id = (select auth.uid())::text and not public.is_blocked());
create policy "Owners and moderators can delete post images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'post-images' and (owner_id = (select auth.uid())::text or public.is_admin()));
