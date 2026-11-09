-- Apply this incremental migration to an existing project created from the previous supabase.sql.
-- It preserves the existing public_feed column order and appends can_delete.
create or replace view public.public_feed with (security_barrier = true) as
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

create or replace function public.delete_post(target_post_id uuid)
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

create or replace function public.delete_comment(target_comment_id uuid)
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

create or replace function public.admin_remove_comment(target_comment_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  delete from public.comments where id = target_comment_id;
end;
$$;

revoke all on function public.delete_post(uuid) from public, anon;
revoke all on function public.delete_comment(uuid) from public, anon;
revoke all on function public.admin_remove_comment(uuid) from public, anon;
grant execute on function public.delete_post(uuid) to authenticated;
grant execute on function public.delete_comment(uuid) to authenticated;
grant execute on function public.admin_remove_comment(uuid) to authenticated;
grant execute on function public.is_admin() to anon, authenticated;
do $$
begin
  if to_regprocedure('public.admin_delete_post(uuid)') is not null then
    execute 'revoke all on function public.admin_delete_post(uuid) from public, anon, authenticated';
  end if;
end;
$$;
