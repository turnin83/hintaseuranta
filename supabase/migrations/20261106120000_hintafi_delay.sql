-- hinta.fi blocks clients that ask too often (a "Pääsy rajoitettu" page served as HTTP 404).
-- Be gentler: at least 5 s between its pages (Settings -> Kaupat can raise it further).
update public.shops set min_delay_ms = 5000 where domain = 'hinta.fi' and min_delay_ms < 5000;
