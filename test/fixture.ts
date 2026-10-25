import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"

export const GHOST_SQL = readFileSync(new URL("../sql/ghost.sql", import.meta.url), "utf8")

// A small shop: an order's total is a trigger rollup, shipped orders are final, order numbers come from a sequence.
export const SHOP_SQL = `
  create sequence order_no_seq start 1001;
  create table customers (id bigserial primary key, name text not null);
  create table orders (
    id bigserial primary key,
    order_no bigint not null default nextval('order_no_seq'),
    customer_id bigint references customers,
    total numeric not null default 0,
    shipped boolean not null default false
  );
  create table order_lines (id bigserial primary key, order_id bigint not null references orders, qty int not null, price numeric not null);
  create view order_totals as select o.id, o.order_no, o.total, count(l.id) as lines from orders o left join order_lines l on l.order_id = o.id group by o.id;

  create function roll_up_total() returns trigger language plpgsql as $$
  begin
    update orders set total = (select coalesce(sum(qty * price), 0) from order_lines where order_id = coalesce(new.order_id, old.order_id))
    where id = coalesce(new.order_id, old.order_id);
    return null;
  end $$;
  create trigger order_lines_total after insert or update or delete on order_lines for each row execute function roll_up_total();

  create function shipped_is_final() returns trigger language plpgsql as $$
  begin
    if old.shipped then raise exception 'Shipped orders are final' using errcode = 'P0001'; end if;
    return new;
  end $$;
  create trigger orders_final before update on orders for each row execute function shipped_is_final();

  create function add_line(p_order bigint, p_qty int, p_price numeric) returns bigint language plpgsql as $$
  declare v bigint;
  begin
    insert into order_lines (order_id, qty, price) values (p_order, p_qty, p_price) returning id into v;
    return v;
  end $$;

  insert into customers (name) values ('Acme');
  insert into orders (customer_id) values (1);
`

export async function shop(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(SHOP_SQL)
  // PGlite has no pgrst listener; the notify is harmless but noisy.
  await db.exec(GHOST_SQL)
  await db.query("select ghost.install()")
  return db
}

export async function one<T = any>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<Record<string, unknown>>(sql, params)
  return Object.values(rows[0] ?? {})[0] as T
}
