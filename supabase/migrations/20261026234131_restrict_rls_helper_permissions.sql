-- Supabase's table-creation helper is internal, not an application RPC.
-- Keep its owner and event trigger intact while removing public execution.
-- Some installations do not have this optional helper.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
