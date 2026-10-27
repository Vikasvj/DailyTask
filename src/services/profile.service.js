import { getSupabase } from '../config/supabase.js';

import { fileTypeFromBuffer } from 'file-type';
const profileColumns =
  'id,full_name,avatar_path,created_at,updated_at';

function error(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
    expose: true,
  });
}

function invalid() {
  return error(
    400,
    'INVALID_INPUT',
    'Invalid profile request.',
  );
}

function unavailable() {
  return error(
    503,
    'DATABASE_UNAVAILABLE',
    'Profile service is temporarily unavailable.',
  );
}

function onlyFields(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw invalid();
  }
}

function validateProfile(input, userId) {
  onlyFields(input, ['full_name', 'avatar_path']);

  if (Object.keys(input).length === 0) {
    throw invalid();
  }

  const patch = {};

  if (Object.hasOwn(input, 'full_name')) {
    if (typeof input.full_name !== 'string') {
      throw invalid();
    }

    const name = input.full_name.trim();

    if (name.length < 1 || name.length > 80) {
      throw invalid();
    }

    patch.full_name = name;
  }

  if (Object.hasOwn(input, 'avatar_path')) {
    const path = input.avatar_path;

    if (path === null) {
      patch.avatar_path = null;
    } else {
      if (typeof path !== 'string' || path.length > 200) {
        throw invalid();
      }

      const parts = path.split('/');

      if (
        parts.length !== 2 ||
        parts[0] !== userId ||
        !/^avatar\.(jpg|jpeg|png|webp)$/i.test(parts[1])
      ) {
        throw invalid();
      }

      patch.avatar_path = path;
    }
  }

  return patch;
}

async function result(query) {
  const { data, error: cause, status } = await query;

  if (!cause) return data;

  if (status === 429) {
    throw error(
      429,
      'RATE_LIMITED',
      'Too many requests. Please try again later.',
    );
  }

  if (['PGRST301', 'PGRST303'].includes(cause.code)) {
    throw error(
      401,
      'INVALID_TOKEN',
      'The access token is invalid or expired.',
    );
  }

  if (cause.code === '23505') {
    throw error(409, 'CONFLICT', 'Profile already exists.');
  }

  if (
    ['23502', '23514', '22023', '22P02'].includes(cause.code)
  ) {
    throw invalid();
  }

  if (cause.code === '42501') {
    throw error(
      403,
      'FORBIDDEN',
      'This profile operation is not permitted.',
    );
  }

  throw unavailable();
}

async function ensureProfile(supabase, userId) {
  const existing = await result(
    supabase
      .from('habit_profiles')
      .select(profileColumns)
      .eq('id', userId)
      .maybeSingle(),
  );

  if (existing) return existing;

  try {
    return await result(
      supabase
        .from('habit_profiles')
        .insert({ id: userId })
        .select(profileColumns)
        .single(),
    );
  } catch (cause) {
    if (cause.code !== 'CONFLICT') throw cause;

    const retry = await result(
      supabase
        .from('habit_profiles')
        .select(profileColumns)
        .eq('id', userId)
        .maybeSingle(),
    );

    if (!retry) throw unavailable();

    return retry;
  }
}

async function getAuthenticatedUser(supabase, token) {
  const { data, error: cause } =
    await supabase.auth.getUser(token);

  if (cause || !data?.user) {
    throw error(
      401,
      'INVALID_TOKEN',
      'The access token is invalid or expired.',
    );
  }

  return data.user;
}

export async function getProfile(userId, token) {
  const supabase = getSupabase(token);

  const [profile, user] = await Promise.all([
    ensureProfile(supabase, userId),
    getAuthenticatedUser(supabase, token),
  ]);

  return {
    ...profile,
    email: user.email ?? null,
  };
}

export async function updateProfile(userId, token, input) {
  const patch = validateProfile(input, userId);
  const supabase = getSupabase(token);

  await ensureProfile(supabase, userId);

  const updated = await result(
    supabase
      .from('habit_profiles')
      .update({
        ...patch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select(profileColumns)
      .maybeSingle(),
  );

  if (!updated) {
    throw error(404, 'NOT_FOUND', 'Profile not found.');
  }

  const user = await getAuthenticatedUser(supabase, token);

  return {
    ...updated,
    email: user.email ?? null,
  };
}

export async function uploadAvatar(userId, token, file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw invalid();
  }

  // Verify the actual image format, not just its filename.
  const detected = await fileTypeFromBuffer(file.buffer);

  const allowedTypes = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };

  const extension = allowedTypes[detected?.mime];

  if (!extension) {
    throw invalid();
  }

  const supabase = getSupabase(token);

  // Ensure the authenticated user has a profile.
  const profile = await ensureProfile(supabase, userId);

  const path = `${userId}/avatar.${extension}`;

  // Upload to the private Supabase Storage bucket.
  const { error: uploadError } = await supabase.storage
    .from('profile-avatars')
    .upload(path, file.buffer, {
      contentType: detected.mime,
      upsert: true,
      cacheControl: '3600',
    });

  if (uploadError) {
    if (String(uploadError.statusCode) === '403') {
      throw error(
        403,
        'FORBIDDEN',
        'You are not permitted to upload this avatar.',
      );
    }

    throw unavailable();
  }

  // Save the storage path in the profile table.
  const updated = await result(
    supabase
      .from('habit_profiles')
      .update({
        avatar_path: path,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select(profileColumns)
      .maybeSingle(),
  );

  if (!updated) {
    // Best-effort cleanup if the profile update failed.
    await supabase.storage
      .from('profile-avatars')
      .remove([path]);

    throw error(404, 'NOT_FOUND', 'Profile not found.');
  }

  // Remove the old image if its extension changed.
  if (
    profile.avatar_path &&
    profile.avatar_path !== path
  ) {
    await supabase.storage
      .from('profile-avatars')
      .remove([profile.avatar_path]);
  }

  return updated;
}