// แยกการเรียก Supabase ออกจาก DOM เพื่ออ่านง่ายและทดสอบ error paths ได้
export function createAuthService(client, baseUrl) {
  const redirect = (page) => new URL(page, baseUrl).href;
  async function checked(promise) {
    const result = await promise;
    if (result.error) throw result.error;
    return result.data;
  }
  return {
    session: async () => (await checked(client.auth.getSession())).session,
    login: (email, password) => checked(client.auth.signInWithPassword({ email, password })),
    register: (email, password, name) =>
      checked(
        client.auth.signUp({
          email,
          password,
          options: { data: { display_name: name }, emailRedirectTo: redirect('index.html') },
        }),
      ),
    forgot: (email) =>
      checked(
        client.auth.resetPasswordForEmail(email, { redirectTo: redirect('reset-password.html') }),
      ),
    reset: (password) => checked(client.auth.updateUser({ password })),
    changePassword: (currentPassword, password, nonce = '') =>
      checked(
        client.auth.updateUser({
          password,
          current_password: currentPassword,
          ...(nonce ? { nonce } : {}),
        }),
      ),
    reauthenticate: () => checked(client.auth.reauthenticate()),
    logout: () => checked(client.auth.signOut({ scope: 'local' })),
  };
}

export function passwordChangePayload(current, password, confirmation, nonce = '') {
  if (typeof current !== 'string' || !current || current.length > 128)
    throw new Error('กรอกรหัสผ่านปัจจุบัน');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    throw new Error('รหัสผ่านใหม่ต้องมี 8–128 ตัวอักษร');
  if (password !== confirmation) throw new Error('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
  if (password === current) throw new Error('ใช้รหัสผ่านใหม่ที่ต่างจากรหัสผ่านปัจจุบัน');
  return { current, password, nonce: nonce.trim() };
}
