-- Cadence's two seeded demo users. The uuids are pinned and MUST match
-- src/server/users.ts: offline JWT verification, actAs claims, and this seed
-- all agree on the same Supabase user ids. Both users share the demo
-- password "cadence-demo" (hashed here; GoTrue verifies it on login).

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change,
  email_change_token_new,
  email_change_token_current
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01',
    'authenticated',
    'authenticated',
    'maya@cadence.test',
    extensions.crypt('cadence-demo', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"name":"Maya Alvarez"}',
    now(),
    now(),
    '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '3d2f5e0c-9b1a-4c8d-8e4f-2a6b7c9d1e02',
    'authenticated',
    'authenticated',
    'daniel@cadence.test',
    extensions.crypt('cadence-demo', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"name":"Daniel Hartwell"}',
    now(),
    now(),
    '', '', '', '', ''
  )
on conflict (id) do nothing;

insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  (
    gen_random_uuid(),
    '8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01',
    '8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01',
    '{"sub":"8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01","email":"maya@cadence.test","email_verified":true}',
    'email',
    now(),
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    '3d2f5e0c-9b1a-4c8d-8e4f-2a6b7c9d1e02',
    '3d2f5e0c-9b1a-4c8d-8e4f-2a6b7c9d1e02',
    '{"sub":"3d2f5e0c-9b1a-4c8d-8e4f-2a6b7c9d1e02","email":"daniel@cadence.test","email_verified":true}',
    'email',
    now(),
    now(),
    now()
  )
on conflict (provider_id, provider) do nothing;
