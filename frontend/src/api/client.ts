import axios from 'axios';
import type {
  AdminUser,
  AdminUserCreateInput,
  AdminUserListResponse,
  MeResponse,
  RCA,
  RCAHistoryEntry,
  RCAListResponse,
  RCASeverity,
  RCAStatus,
  User,
} from './types';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

export async function fetchMe(): Promise<MeResponse> {
  const { data } = await api.get<MeResponse>('/me');
  return data;
}

export async function fetchUsers(q: string): Promise<User[]> {
  const { data } = await api.get<User[]>('/users', { params: q ? { q } : {} });
  return data;
}

export async function fetchRCAs(
  filters: {
    status?: RCAStatus;
    mine?: boolean;
    q?: string;
    severity?: RCASeverity;
    environment?: string;
    page?: number;
    page_size?: number;
    from?: string;
    to?: string;
  } = {},
): Promise<RCAListResponse> {
  const params: Record<string, string | number> = {};
  if (filters.status) params.status = filters.status;
  if (filters.mine) params.mine = 'true';
  if (filters.q) params.q = filters.q;
  if (filters.severity) params.severity = filters.severity;
  if (filters.environment) params.environment = filters.environment;
  if (filters.page) params.page = filters.page;
  if (filters.page_size) params.page_size = filters.page_size;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  const { data } = await api.get<RCAListResponse>('/rcas', { params });
  return data;
}

export async function fetchRCA(id: number): Promise<RCA> {
  const { data } = await api.get<RCA>(`/rcas/${id}`);
  return data;
}

export interface CreateRCAInput {
  title: string;
  body?: string;
  content?: Record<string, unknown> | null;
  assignee_emails: string[];
  severity?: RCASeverity | null;
  environment?: string | null;
  services_affected?: string[];
  incident_started_at?: string | null;
  incident_detected_at?: string | null;
  incident_mitigated_at?: string | null;
  incident_resolved_at?: string | null;
}

export async function createRCA(input: CreateRCAInput): Promise<RCA> {
  const { data } = await api.post<RCA>('/rcas', input);
  return data;
}

export type UpdateRCAPatch = Partial<{
  title: string;
  body: string;
  content: Record<string, unknown> | null;
  assignee_emails: string[];
  status: RCAStatus;
  severity: RCASeverity | null;
  environment: string | null;
  services_affected: string[];
  incident_started_at: string | null;
  incident_detected_at: string | null;
  incident_mitigated_at: string | null;
  incident_resolved_at: string | null;
}>;

export async function updateRCA(id: number, patch: UpdateRCAPatch): Promise<RCA> {
  const { data } = await api.patch<RCA>(`/rcas/${id}`, patch);
  return data;
}

export async function deleteRCA(id: number): Promise<void> {
  await api.delete(`/rcas/${id}`);
}

export async function fetchRCAHistory(id: number): Promise<RCAHistoryEntry[]> {
  const { data } = await api.get<RCAHistoryEntry[]>(`/rcas/${id}/history`);
  return data;
}

export async function regenerateSummary(id: number): Promise<RCA> {
  const { data } = await api.post<RCA>(`/rcas/${id}/regenerate-summary`);
  return data;
}

export async function fetchAdminUsers(params: {
  q?: string;
  page?: number;
  page_size?: number;
} = {}): Promise<AdminUserListResponse> {
  const query: Record<string, string | number> = {};
  if (params.q) query.q = params.q;
  if (params.page) query.page = params.page;
  if (params.page_size) query.page_size = params.page_size;
  const { data } = await api.get<AdminUserListResponse>('/admin/users', { params: query });
  return data;
}

export async function patchAdminUser(
  email: string,
  payload: { is_admin: boolean },
): Promise<AdminUser> {
  const { data } = await api.patch<AdminUser>(`/admin/users/${encodeURIComponent(email)}`, payload);
  return data;
}

export async function deleteAdminUser(email: string): Promise<void> {
  await api.delete(`/admin/users/${encodeURIComponent(email)}`);
}

export async function createAdminUser(payload: AdminUserCreateInput): Promise<AdminUser> {
  const { data } = await api.post<AdminUser>('/admin/users', payload);
  return data;
}
