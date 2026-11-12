-- shops.blocked_until / block_count (20261112090000) were replaced by host_cooldowns (20261112120000).
alter table public.shops drop column blocked_until, drop column block_count;
