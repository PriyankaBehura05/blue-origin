import { useState } from 'react';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { useSession } from '@/services/session';
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from '@/components/ui';
import { RecordForm, type FieldDef, type FormValues } from '@/components/RecordForm';
import type { AuthUser, Role } from '@/types';

const ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin — everything, including users' },
  { value: 'editor', label: 'Editor — view and change data' },
  { value: 'viewer', label: 'Viewer — view and download only' },
];
const ROLE_TONE: Record<Role, string> = { admin: 'blue', editor: 'green', viewer: 'gray' };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';

function fields(isNew: boolean, isSelf: boolean): FieldDef[] {
  const out: FieldDef[] = [
    { name: 'name', label: 'Name', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
  ];
  if (!isSelf) {
    // your own role and status cannot be changed (no locking yourself out)
    out.push({ name: 'role', label: 'Role', type: 'select', options: ROLES, required: true });
    out.push({ name: 'active', label: 'Status', type: 'select', required: true,
      options: [{ value: 'yes', label: 'Active — can sign in' }, { value: 'no', label: 'Inactive — cannot sign in' }] });
  }
  if (isNew) {
    out.push({ name: 'password', label: 'Password', type: 'password', required: true, hint: 'At least 8 characters. Share it with the user; they can change it after signing in.' });
  } else if (!isSelf) {
    // your own password: "Change password" in the top bar (it asks for the current one)
    out.push({ name: 'password', label: 'New password', type: 'password', hint: 'Leave blank to keep the current password.' });
  }
  return out;
}

// Admins add, edit, deactivate and delete the people who can sign in.
export default function UsersPage() {
  const me = useSession()?.user;
  const users = useAsync(() => api.getUsers(), [], me?.role === 'admin');
  const [editing, setEditing] = useState<AuthUser | 'new' | null>(null);

  if (me?.role !== 'admin') return <ErrorBox message="Only an admin can manage users." />;

  const save = async (v: FormValues) => {
    const input = {
      name: v.name.trim(),
      email: v.email.trim(),
      ...(v.role ? { role: v.role as Role } : {}),
      ...(v.active ? { active: v.active === 'yes' } : {}),
      ...(v.password ? { password: v.password } : {}),
    };
    if (editing === 'new') await api.createUser({ ...input, password: v.password });
    else if (editing) await api.updateUser(editing.id, input);
    users.reload();
  };
  const isSelf = editing !== null && editing !== 'new' && editing.id === me.id;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Who can sign in, and what they can do"
        actions={<>
          <button className="btn" title="Every account with its role, status and last sign-in, plus the history of changes. Also kept in Dropbox: Users/BO_User_Register.xlsx. Passwords are never included."
            onClick={() => api.downloadUserRegister().catch((e) => alert(`Download failed: ${e instanceof Error ? e.message : e}`))}>⤓ Download register (Excel)</button>
          <button className="btn primary" onClick={() => setEditing('new')}>+ Add user</button>
        </>}
      />
      {users.error && <ErrorBox message={users.error} />}
      <Card pad={false}>
        {!users.data ? (
          !users.error && <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Added</th><th /></tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id} className="clickable" onClick={() => setEditing(u)}>
                    <td><strong>{u.name}</strong>{u.id === me.id && <span className="note"> (you)</span>}</td>
                    <td>{u.email}</td>
                    <td><span className={`badge ${ROLE_TONE[u.role] ?? 'gray'}`}>{u.role}</span></td>
                    <td><StatusBadge status={u.active ? 'Active' : 'Inactive'} /></td>
                    <td>{when(u.lastLoginAt)}</td>
                    <td>{when(u.createdAt)}</td>
                    <td className="right"><button className="btn sm" onClick={(e) => { e.stopPropagation(); setEditing(u); }}>✎ Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="note">
        Admins manage users and everything else · Editors upload and change data, benefits and syncs · Viewers can see and download
        everything but change nothing. You cannot remove your own admin access, and at least one active admin always remains.
      </p>
      {editing && (
        <RecordForm
          title={editing === 'new' ? 'Add user' : `Edit ${editing.name}`}
          fields={fields(editing === 'new', isSelf)}
          initial={editing === 'new'
            ? { role: 'viewer', active: 'yes' }
            : { name: editing.name, email: editing.email, role: editing.role, active: editing.active ? 'yes' : 'no' }}
          onSubmit={save}
          onDelete={editing === 'new' || isSelf ? undefined : async () => { await api.deleteUser(editing.id); users.reload(); }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
